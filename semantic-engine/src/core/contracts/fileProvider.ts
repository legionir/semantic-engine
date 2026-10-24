/**
 * ConfinedFileProvider — reference implementation of the `FileProvider` port.
 *
 * Everything a read path needs to be safe is here, and every rule has a test in
 * `fileProvider.test.ts`:
 *
 *   | rule                       | failure mode it closes                        |
 *   |----------------------------|-----------------------------------------------|
 *   | relative POSIX input only   | `../../etc/passwd`, `C:\\…`, NUL bytes         |
 *   | lexical root confinement    | absolute paths and `..` that resolve outside  |
 *   | canonical (realpath) check  | a symlink inside the root pointing outside    |
 *   | secret denylist             | `.env`, `id_rsa`, `*.pem`, `*.key`, credentials |
 *   | `.git` segment denylist     | object files: binary, huge, never source      |
 *   | per-file byte cap           | a 4 GB artifact being read into memory        |
 *   | listed-entry cap            | a runaway directory                 |
 *   | per-call deadline           | a hung network/remote mount                   |
 *   | `AbortSignal`               | cancellation must reach the reader            |
 *
 * The port deliberately has no write method. `readOnly` is `true` as a literal.
 *
 * ── Known duplication (recorded as D-0007, not silently fixed) ──────────
 *
 * `src/services/source/SourceSecurityGuard.ts` implements the same two checks
 * (lexical + realpath confinement) for the sync path. This provider does not
 * import it: `core/contracts` must not depend on `services`, and the guard
 * carries policy (blocked extensions) that a *read* boundary should not inherit
 * — `.bin` files are legitimately readable, they are just not source. Unifying
 * the two under one confinement helper is a Phase 1 decision, not something a
 * Phase 0 contract may quietly do.
 */

import * as path from 'path';
import { CODEINTEL_ERROR_CODES } from './codeintel';
import type { FileMetadata, FileProvider } from './ports';
import { compareCanonical } from './codeintel';
import {
  ConfinedFileProviderOptions, DEFAULT_DENIED_PATTERNS, DEFAULT_DENIED_SEGMENTS, FileProviderError,
  ProviderFileSystem, ProviderStats, nodeProviderFileSystem,
} from './fileProviderTypes';

export * from './fileProviderTypes';

/** Prefix read for binary detection: a NUL byte in the first 8 KiB. */
const BINARY_SNIFF_BYTES = 8000;

interface NormalizedPath {
  /** Normalized relative path, POSIX separators. */
  readonly relativePath: string;
}

export class ConfinedFileProvider implements FileProvider {
  readonly readOnly = true as const;

  private readonly workspaceRoot: string;
  private readonly maxFiles: number;
  private readonly maxFileBytes: number;
  private readonly timeoutMs: number;
  private readonly deniedPatterns: readonly string[];
  private readonly deniedSegments: readonly string[];
  private readonly fs: ProviderFileSystem;
  private readonly signal?: AbortSignal;
  /** `realpath(workspaceRoot)`, resolved once. */
  private canonicalRoot: string | null = null;

  constructor(options: ConfinedFileProviderOptions) {
    if (!options.workspaceRoot) {
      throw new FileProviderError(CODEINTEL_ERROR_CODES.INVALID_ARGUMENT, 'workspaceRoot is required');
    }
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.maxFiles = options.maxFiles ?? 10_000;
    this.maxFileBytes = options.maxFileBytes ?? 2_000_000;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.deniedPatterns = options.deniedPatterns ?? DEFAULT_DENIED_PATTERNS;
    this.deniedSegments = options.deniedSegments ?? DEFAULT_DENIED_SEGMENTS;
    this.fs = options.fileSystem ?? nodeProviderFileSystem;
    if (options.signal) this.signal = options.signal;
  }

  async list(relativeDirectory: string): Promise<readonly FileMetadata[]> {
    const normalized = this.normalize(relativeDirectory, { allowRoot: true });
    const absolute = await this.confine(normalized, { mustExist: true });

    const names = await this.guarded(`list ${relativeDirectory || '.'}`, () => this.fs.readdir(absolute));
    if (names.length > this.maxFiles) {
      throw new FileProviderError(
        CODEINTEL_ERROR_CODES.LIMIT_EXCEEDED,
        `${names.length} entries exceed maxFiles=${this.maxFiles} in '${relativeDirectory || '.'}'`
      );
    }

    const seen = new Set<string>();
    const entries: FileMetadata[] = [];

    for (const name of [...names].sort(compareCanonical)) {
      const childRelative =
        normalized.relativePath === '' ? name : `${normalized.relativePath}/${name}`;
      if (this.isDenied(childRelative)) continue;

      const childAbsolute = path.join(absolute, name);
      let stats: ProviderStats;
      try {
        stats = await this.guarded(`lstat ${childRelative}`, () => this.fs.lstat(childAbsolute));
      } catch (error) {
        /* A file that vanished between readdir and lstat is not an error; any
           other failure (EACCES, EIO) must propagate. */
        if (isNotFound(error)) continue;
        throw error;
      }

      let isSymlink = stats.isSymbolicLink();
      if (isSymlink) {
        /* A symlink is listed for its target, and only when the target is a
           regular file that stays inside the root. */
        try {
          stats = await this.guarded(`stat ${childRelative}`, () => this.fs.stat(childAbsolute));
        } catch (error) {
          if (isNotFound(error)) continue;
          throw error;
        }
      }

      if (!stats.isFile()) continue;

      const confined = await this.confineEntry(childRelative, isSymlink);
      if (!confined) continue;

      if (seen.has(childRelative)) continue;
      seen.add(childRelative);

      entries.push({
        relativePath: childRelative,
        sizeBytes: stats.size,
        mtimeMs: stats.mtimeMs,
        isSymlink,
        isBinary: await this.isBinaryFile(childAbsolute),
      });
    }

    return entries.sort((a, b) => compareCanonical(a.relativePath, b.relativePath));
  }

  async read(relativePath: string, maxBytes: number): Promise<Uint8Array> {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new FileProviderError(
        CODEINTEL_ERROR_CODES.INVALID_ARGUMENT,
        `maxBytes must be a positive integer, got ${maxBytes}`
      );
    }

    const normalized = this.normalize(relativePath, { allowRoot: false });
    const absolute = await this.confine(normalized, { mustExist: true });

    let stats = await this.guarded(`lstat ${relativePath}`, () => this.fs.lstat(absolute));
    if (stats.isSymbolicLink()) {
      /* The canonical check above already proved the target is inside the
         root; from here the link is read as its target. */
      stats = await this.guarded(`stat ${relativePath}`, () => this.fs.stat(absolute));
    }
    if (!stats.isFile()) {
      throw new FileProviderError(CODEINTEL_ERROR_CODES.DENIED, `not a regular file: ${relativePath}`);
    }

    const cap = Math.min(maxBytes, this.maxFileBytes);
    if (stats.size > cap) {
      throw new FileProviderError(
        CODEINTEL_ERROR_CODES.LIMIT_EXCEEDED,
        `file '${relativePath}' is ${stats.size} bytes, above the limit of ${cap}`
      );
    }

    const buffer = await this.guarded(`read ${relativePath}`, () => this.fs.readFile(absolute));
    /* The file can grow between lstat and read; the cap is enforced again on
       the bytes that were actually read. */
    if (buffer.byteLength > cap) {
      throw new FileProviderError(
        CODEINTEL_ERROR_CODES.LIMIT_EXCEEDED,
        `file '${relativePath}' grew to ${buffer.byteLength} bytes, above the limit of ${cap}`
      );
    }
    return new Uint8Array(buffer);
  }

  async exists(relativePath: string): Promise<boolean> {
    const normalized = this.normalize(relativePath, { allowRoot: false });
    const absolute = await this.confine(normalized, { mustExist: false });
    if (!absolute) return false;
    if (!(await this.guarded(`exists ${relativePath}`, () => this.fs.exists(absolute)))) return false;
    let stats = await this.guarded(`lstat ${relativePath}`, () => this.fs.lstat(absolute));
    if (stats.isSymbolicLink()) {
      stats = await this.guarded(`stat ${relativePath}`, () => this.fs.stat(absolute));
    }
    return stats.isFile();
  }

  /** The canonical workspace root, i.e. what confinement is measured against. */
  async canonicalWorkspaceRoot(): Promise<string> {
    if (this.canonicalRoot) return this.canonicalRoot;
    try {
      this.canonicalRoot = await this.fs.realpath(this.workspaceRoot);
    } catch {
      throw new FileProviderError(
        CODEINTEL_ERROR_CODES.IO_ERROR,
        `workspace root does not exist: ${this.workspaceRoot}`
      );
    }
    return this.canonicalRoot;
  }

  // ── rules ─────────────────────────────────────────────────────────────

  private normalize(input: string, options: { allowRoot: boolean }): NormalizedPath {
    if (typeof input !== 'string' || input.trim() === '') {
      if (options.allowRoot && input === '') return { relativePath: '' };
      throw new FileProviderError(
        CODEINTEL_ERROR_CODES.INVALID_ARGUMENT,
        'path must be a non-empty relative POSIX path'
      );
    }
    if (input.includes('\0')) {
      throw new FileProviderError(CODEINTEL_ERROR_CODES.INVALID_ARGUMENT, 'path must not contain NUL');
    }
    if (input.includes('\\')) {
      throw new FileProviderError(
        CODEINTEL_ERROR_CODES.INVALID_ARGUMENT,
        `path must use "/" separators: ${input}`
      );
    }
    if (path.posix.isAbsolute(input) || /^[A-Za-z]:/u.test(input)) {
      throw new FileProviderError(CODEINTEL_ERROR_CODES.DENIED, `path must be relative: ${input}`);
    }

    const segments: string[] = [];
    for (const segment of input.split('/')) {
      if (segment === '' || segment === '.') continue;
      if (segment === '..') {
        throw new FileProviderError(
          CODEINTEL_ERROR_CODES.DENIED,
          `path traversal is not allowed: ${input}`
        );
      }
      segments.push(segment);
    }

    const relativePath = segments.join('/');
    if (relativePath === '' && !options.allowRoot) {
      throw new FileProviderError(
        CODEINTEL_ERROR_CODES.INVALID_ARGUMENT,
        'path must name a file, not the workspace root'
      );
    }
    return { relativePath };
  }

  private isDenied(relativePath: string): boolean {
    return isDeniedPath(relativePath, this.deniedPatterns, this.deniedSegments);
  }

  /**
   * Resolves the caller's path inside the workspace or refuses.
   *
   * Two checks, in this order: the lexical one catches `..` before any I/O, and
   * the canonical one catches a symlink whose target lives outside the root —
   * including the case where only an ancestor exists and is a symlink.
   */
  private async confine(
    normalized: NormalizedPath,
    options: { mustExist: boolean }
  ): Promise<string> {
    const canonicalRoot = await this.canonicalWorkspaceRoot();
    const absolute = path.resolve(this.workspaceRoot, normalized.relativePath);

    if (!isInside(this.workspaceRoot, absolute)) {
      throw new FileProviderError(
        CODEINTEL_ERROR_CODES.DENIED,
        `path escapes the workspace root: ${normalized.relativePath}`
      );
    }
    if (this.isDenied(normalized.relativePath)) {
      throw new FileProviderError(
        CODEINTEL_ERROR_CODES.DENIED,
        `path is on the denylist: ${normalized.relativePath}`
      );
    }

    const deepestExisting = await this.deepestExisting(absolute);
    if (deepestExisting === null) {
      if (options.mustExist) {
        throw new FileProviderError(
          CODEINTEL_ERROR_CODES.NOT_FOUND,
          `no such file: ${normalized.relativePath}`
        );
      }
      return '';
    }

    let realDeepest: string;
    try {
      realDeepest = await this.guarded(
        `realpath ${normalized.relativePath}`,
        () => this.fs.realpath(deepestExisting)
      );
    } catch (error) {
      throw toProviderError(error, `cannot resolve '${normalized.relativePath}'`);
    }

    if (!isInside(canonicalRoot, realDeepest)) {
      throw new FileProviderError(
        CODEINTEL_ERROR_CODES.DENIED,
        `symlink escapes the workspace root: ${normalized.relativePath}`
      );
    }
    return absolute;
  }

  /** Same canonical test for a listing entry; `null` means "omit". */
  private async confineEntry(relativePath: string, isSymlink: boolean): Promise<string | null> {
    if (!isSymlink) return relativePath;
    const absolute = path.resolve(this.workspaceRoot, relativePath);
    const canonicalRoot = await this.canonicalWorkspaceRoot();
    try {
      const real = await this.guarded(`realpath ${relativePath}`, () => this.fs.realpath(absolute));
      if (!isInside(canonicalRoot, real)) return null;
    } catch {
      /* A broken symlink is not a readable entry. */
      return null;
    }
    return relativePath;
  }

  private async deepestExisting(absolute: string): Promise<string | null> {
    let current = absolute;
    for (;;) {
      if (await this.fs.exists(current)) return current;
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }

  private async isBinaryFile(absolute: string): Promise<boolean> {
    try {
      const prefix = await this.guarded('binary sniff', () =>
        this.fs.readPrefix(absolute, BINARY_SNIFF_BYTES)
      );
      return prefix.includes(0);
    } catch {
      /* Unreadable is not the same as binary, but it is also not a fact we can
         claim. The entry stays listed and `read()` will surface the error. */
      return false;
    }
  }

  /**
   * Runs one filesystem call under the deadline and the cancellation signal.
   *
   * The timer is unref'd so a provider that is waiting on a timeout cannot keep
   * the process alive, and the abort listener is removed in `finally` so a long
   * lived signal does not accumulate listeners.
   */
  private async guarded<T>(label: string, operation: () => Promise<T>): Promise<T> {
    this.throwIfCancelled(label);

    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;

    const races: Promise<T>[] = [operation()];

    if (this.timeoutMs > 0 && Number.isFinite(this.timeoutMs)) {
      races.push(
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(
              new FileProviderError(
                CODEINTEL_ERROR_CODES.TIMEOUT,
                `${label} exceeded the ${this.timeoutMs}ms deadline`
              )
            );
          }, this.timeoutMs);
          if (typeof timer.unref === 'function') timer.unref();
        })
      );
    }

    if (this.signal) {
      const signal = this.signal;
      races.push(
        new Promise<never>((_resolve, reject) => {
          onAbort = () => {
            reject(new FileProviderError(CODEINTEL_ERROR_CODES.CANCELLED, `${label} was cancelled`));
          };
          signal.addEventListener('abort', onAbort, { once: true });
        })
      );
    }

    try {
      return await Promise.race(races);
    } catch (error) {
      throw toProviderError(error, label);
    } finally {
      if (timer) clearTimeout(timer);
      if (this.signal && onAbort) this.signal.removeEventListener('abort', onAbort);
    }
  }

  private throwIfCancelled(label: string): void {
    if (this.signal?.aborted) {
      throw new FileProviderError(CODEINTEL_ERROR_CODES.CANCELLED, `${label} was cancelled`);
    }
  }
}

/** `target` is `root` or lives under it. Both arguments are absolute. */
export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  if (relative === '') return true;
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Is this workspace-relative path on the secret/`.git` denylist? Shared by the provider and by the
 * MCP source tools, which read indexed files directly and must not hand out `.env`, keys or `.git`.
 */
export function isDeniedPath(
  relativePath: string,
  patterns: readonly string[] = DEFAULT_DENIED_PATTERNS,
  segments: readonly string[] = DEFAULT_DENIED_SEGMENTS
): boolean {
  const parts = relativePath.replace(/\\/g, '/').split('/');
  if (segments.some(segment => parts.includes(segment))) return true;
  const name = parts[parts.length - 1] ?? '';
  return patterns.some(pattern => matchesPattern(name, pattern));
}

function matchesPattern(name: string, pattern: string): boolean {
  if (pattern === name) return true;
  const star = pattern.indexOf('*');
  if (star === -1) return false;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  return name.startsWith(prefix) && name.endsWith(suffix) && name.length >= prefix.length + suffix.length;
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT';
}

function toProviderError(error: unknown, label: string): Error {
  if (error instanceof FileProviderError) return error;
  const code = (error as { code?: string } | null)?.code;
  if (code === 'ENOENT') {
    return new FileProviderError(CODEINTEL_ERROR_CODES.NOT_FOUND, `${label}: no such file`);
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new FileProviderError(CODEINTEL_ERROR_CODES.DENIED, `${label}: permission denied`);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new FileProviderError(CODEINTEL_ERROR_CODES.IO_ERROR, `${label}: ${message}`);
}
