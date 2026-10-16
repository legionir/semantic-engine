/**
 * Phase 0 additive CodeIntel contracts. No filesystem or network side effects.
 *
 * ── Coordinate space (single source of truth) ──────────────────────────
 *
 * `offset`  UTF-16 code units over the *decoded* text, with one leading BOM
 *           removed (`LineIndex.text`). The BOM is not part of any
 *           coordinate: an editor, a parser and this index must all agree
 *           that the first real character is at offset 0.
 * `Position` 0-based `line`, 0-based `character` in UTF-16 code units —
 *           the LSP shape. `character` counts from the start of the line's
 *           *content*; the line break is not addressed by it.
 * `range`   end-exclusive, exactly like LSP (`text.slice(start, end)`).
 *
 * The existing `ProjectIndex` uses 1-based `line`/`endLine` for symbols. That
 * contract is not changed here; `toProjectIndexLine()` is the one documented
 * bridge, so no caller has to guess.
 *
 * ── Representability of offsets ────────────────────────────────────────
 *
 * A line break is one or two code units (`\n`, `\r`, `\r\n`) but a `Position`
 * has exactly one slot between the end of the content and the start of the
 * next line. Therefore, when the break is `\r\n`, the offset of the `\n`
 * (that is `break.start + 1`) is **not representable** as a `Position`.
 * `LineIndex` is explicit about what happens instead of being silently lossy:
 *
 *   `positionAt(offset)` for an unrepresentable offset returns the end
 *   position of the line the break belongs to (`{ line, character }` with
 *   `character === contentEnd - lineStart`), and `offsetAt()` of that
 *   position gives back `break.start`.
 *
 * The guarantees callers may rely on:
 *
 *   1. round-trip: `offsetAt(positionAt(o)) === o` for every representable `o`
 *      (every offset of the text except the interior of a `\r\n`);
 *   2. clamping: `offsetAt(positionAt(o))` is the nearest representable offset
 *      and never moves past `o`;
 *   3. idempotence for *every* offset, including unrepresentable ones:
 *      `positionAt(offsetAt(positionAt(o)))` is `positionAt(o)`.
 *
 * `isRepresentableOffset()` answers the question directly, so a caller that
 * needs an exact offset can check instead of discovering the collapse later.
 * `Expected: 6, Received: 5` on a CRLF fixture is what the missing check looks
 * like.
 */

export interface Position {
  readonly line: number;
  /** UTF-16 code units from the start of the line's content, 0-based. */
  readonly character: number;
}

export interface TextRange {
  readonly start: Position;
  readonly end: Position;
}

/** Line numbering of this contract. `ProjectIndex` symbol lines are 1-based. */
export const CODEINTEL_LINE_BASE = 0;

/** The documented bridge to the existing 1-based `ProjectIndex` line fields. */
export function toProjectIndexLine(position: Position): number {
  return position.line + CODEINTEL_LINE_BASE + 1;
}

/**
 * Bridge for `FileEntry.lines`, whose existing contract follows `countLines`:
 * it counts line terminators and does not count the empty logical line opened
 * by a trailing terminator. `LineIndex.lineCount` deliberately exposes the
 * editor/LSP view and therefore differs for empty and trailing-newline text.
 */
export function toProjectIndexLineCount(index: Pick<LineIndex, 'text' | 'lineCount'>): number {
  if (index.text.length === 0) return 0;
  const endsWithLineBreak = /(?:\r\n|\r|\n)$/u.test(index.text);
  return index.lineCount - (endsWithLineBreak ? 1 : 0);
}

/** A line break, `[start, end)`, as an offset range. */
export interface LineBreak {
  readonly start: number;
  readonly end: number;
}

/** A single source of truth for UTF-16 offsets and all supported EOL forms. */
export class LineIndex {
  /** The indexed text is decoded and has one leading BOM removed. */
  readonly text: string;
  private readonly starts: readonly number[];
  private readonly ends: readonly number[];

  constructor(input: string) {
    this.text = input.startsWith('\uFEFF') ? input.slice(1) : input;
    const starts: number[] = [0];
    const ends: number[] = [];
    let i = 0;
    while (i < this.text.length) {
      if (this.text[i] === '\r') {
        ends.push(i);
        i += this.text[i + 1] === '\n' ? 2 : 1;
        starts.push(i);
      } else if (this.text[i] === '\n') {
        ends.push(i);
        i += 1;
        starts.push(i);
      } else {
        i += 1;
      }
    }
    ends.push(this.text.length);
    this.starts = starts;
    this.ends = ends;
  }

  get lineCount(): number {
    return this.starts.length;
  }

  /** Offset of the first code unit of `line`. */
  lineStart(line: number): number {
    this.assertLine(line);
    return this.starts[line];
  }

  /** Offset of the first code unit of the line break, or the end of the text. */
  contentEnd(line: number): number {
    this.assertLine(line);
    return this.ends[line];
  }

  /**
   * The line break that ends `line`, or `null` when the line is the last one
   * and the text has no trailing break. A `\r\n` is one break of length two.
   */
  lineBreakOf(line: number): LineBreak | null {
    this.assertLine(line);
    const start = this.ends[line];
    const end = this.nextLineStart(line);
    if (end === null || end === start) return null;
    return { start, end };
  }

  /**
   * False only for the interior of a multi-code-unit line break (`\r\n`),
   * which no `Position` can address. Everything else round-trips exactly.
   */
  isRepresentableOffset(offset: number): boolean {
    this.assertOffset(offset);
    const line = this.positionAt(offset).line;
    const lineBreak = this.lineBreakOf(line);
    if (!lineBreak) return true;
    return offset <= lineBreak.start || offset >= lineBreak.end;
  }

  offsetAt(position: Position): number {
    this.assertPosition(position);
    return Math.min(this.starts[position.line] + position.character, this.ends[position.line]);
  }

  positionAt(offset: number): Position {
    this.assertOffset(offset);
    let low = 0;
    let high = this.starts.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.starts[mid] <= offset) low = mid + 1;
      else high = mid - 1;
    }
    const line = Math.max(0, high);
    return { line, character: Math.min(offset, this.ends[line]) - this.starts[line] };
  }

  toOffsets(range: TextRange): { start: number; end: number } {
    const start = this.offsetAt(range.start);
    const end = this.offsetAt(range.end);
    if (end < start) throw new RangeError('range end precedes range start');
    return { start, end };
  }

  /** The text a range covers. End-exclusive, so this is `slice`, not `substring`. */
  textOf(range: TextRange): string {
    const { start, end } = this.toOffsets(range);
    return this.text.slice(start, end);
  }

  private nextLineStart(line: number): number | null {
    return line + 1 < this.starts.length ? this.starts[line + 1] : null;
  }

  private assertLine(line: number): void {
    if (!Number.isInteger(line) || line < 0 || line >= this.starts.length) {
      throw new RangeError(`line out of bounds: ${line}`);
    }
  }

  private assertOffset(offset: number): void {
    if (!Number.isInteger(offset) || offset < 0 || offset > this.text.length) {
      throw new RangeError(`offset out of bounds: ${offset}`);
    }
  }

  private assertPosition(position: Position): void {
    if (!Number.isInteger(position.line) || !Number.isInteger(position.character)) {
      throw new RangeError('position must contain integer line and character');
    }
    if (position.line < 0 || position.line >= this.starts.length || position.character < 0) {
      throw new RangeError(`position out of bounds: ${position.line}:${position.character}`);
    }
  }
}

export interface SymbolIdentity {
  readonly symbolKey: SymbolKey;
  readonly signatureHash?: string;
}

export type SymbolKey = string & { readonly __symbolKey: unique symbol };

/**
 * Shape of a canonical symbol key:
 * `<relativePath>::<qualifiedName>::<kind>[#<ordinal>]`.
 *
 * The three parts are `::`-separated, so none of them may contain `::` — a key
 * that could be read two ways is not an identifier.
 */
export function makeSymbolKey(
  relativePath: string,
  qualifiedName: string,
  kind: string,
  ordinal?: number
): SymbolKey {
  assertRelativePosixPath(relativePath, 'symbol key');
  assertKeyPart(qualifiedName, 'qualified name');
  assertKeyPart(kind, 'kind');
  if (ordinal !== undefined && (!Number.isInteger(ordinal) || ordinal < 0)) {
    throw new TypeError('symbol ordinal must be a non-negative integer');
  }
  const suffix = ordinal === undefined ? '' : `#${ordinal}`;
  return `${relativePath}::${qualifiedName}::${kind}${suffix}` as SymbolKey;
}

export interface ParsedSymbolKey {
  readonly relativePath: string;
  readonly qualifiedName: string;
  readonly kind: string;
  readonly ordinal: number | null;
}

/** Inverse of `makeSymbolKey`; `makeSymbolKey(...parseSymbolKey(k)) === k`. */
export function parseSymbolKey(key: string): ParsedSymbolKey {
  const parts = key.split('::');
  if (parts.length !== 3) throw new TypeError(`not a canonical symbol key: ${key}`);
  const [relativePath, qualifiedName, kindPart] = parts;
  const hashIndex = kindPart.lastIndexOf('#');
  const kind = hashIndex === -1 ? kindPart : kindPart.slice(0, hashIndex);
  const ordinalText = hashIndex === -1 ? null : kindPart.slice(hashIndex + 1);
  const ordinal = ordinalText === null ? null : Number(ordinalText);
  if (ordinal !== null && !/^\d+$/.test(ordinalText as string)) {
    throw new TypeError(`not a canonical symbol key ordinal: ${key}`);
  }
  assertRelativePosixPath(relativePath, 'symbol key');
  assertKeyPart(qualifiedName, 'qualified name');
  assertKeyPart(kind, 'kind');
  return { relativePath, qualifiedName, kind, ordinal };
}

export type Handle = string & { readonly __handle: unique symbol };

/**
 * Canonical read handle: `<relativePath>:<start>-<end>#<hash8>`.
 *
 * `start`/`end` are UTF-16 offsets into the text the hash was taken from, and
 * the hash binds the handle to that text: a caller that re-reads a file and
 * gets different bytes must not trust the range, it must report `STALE_HANDLE`.
 */
export function makeHandle(relativePath: string, start: number, end: number, hash8: string): Handle {
  assertRelativePosixPath(relativePath, 'handle');
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start
  ) {
    throw new TypeError('invalid handle range');
  }
  if (!/^[a-f0-9]{8}$/u.test(hash8)) {
    throw new TypeError('handle hash must be eight lowercase hex characters');
  }
  return `${relativePath}:${start}-${end}#${hash8}` as Handle;
}

export interface ParsedHandle {
  readonly relativePath: string;
  readonly start: number;
  readonly end: number;
  readonly hash8: string;
}

/**
 * Inverse of `makeHandle`. The path is read from the left and the range from
 * the right, so a path containing `:` still parses.
 */
export function parseHandle(handle: string): ParsedHandle {
  const hashIndex = handle.lastIndexOf('#');
  if (hashIndex === -1) throw new TypeError(`handle has no hash: ${handle}`);
  const hash8 = handle.slice(hashIndex + 1);
  const beforeHash = handle.slice(0, hashIndex);
  const colonIndex = beforeHash.lastIndexOf(':');
  if (colonIndex === -1) throw new TypeError(`handle has no range separator: ${handle}`);
  const relativePath = beforeHash.slice(0, colonIndex);
  const rangeText = beforeHash.slice(colonIndex + 1);
  const match = /^(\d+)-(\d+)$/u.exec(rangeText);
  if (!match) throw new TypeError(`handle has no canonical range: ${handle}`);
  const start = Number(match[1]);
  const end = Number(match[2]);
  const parsed = { relativePath, start, end, hash8 };
  if (makeHandle(relativePath, start, end, hash8) !== handle) {
    throw new TypeError(`handle is not canonical: ${handle}`);
  }
  return parsed;
}

export type TrustLevel = 'untrusted-source-content';

export interface EnvelopeStats {
  readonly durationMs?: number;
  readonly resultCount?: number;
  readonly truncated?: boolean;
}

export interface Envelope<T> {
  readonly ok: boolean;
  readonly requestId: string;
  readonly schemaVersion: '1';
  readonly snapshotId: string;
  readonly trust: TrustLevel;
  readonly stats: EnvelopeStats;
  readonly warnings: readonly string[];
  readonly sessionId?: string;
  readonly data?: T;
  readonly error?: CodeIntelError;
}

/**
 * Stable error codes. Consumers branch on these, not on messages, and a
 * `STALE_HANDLE`/`STALE_SNAPSHOT` must never be answered with source content
 * read from a different generation of the file.
 */
export const CODEINTEL_ERROR_CODES = Object.freeze({
  STALE_HANDLE: 'STALE_HANDLE',
  STALE_SNAPSHOT: 'STALE_SNAPSHOT',
  NOT_FOUND: 'NOT_FOUND',
  OUT_OF_RANGE: 'OUT_OF_RANGE',
  DENIED: 'DENIED',
  LIMIT_EXCEEDED: 'LIMIT_EXCEEDED',
  TIMEOUT: 'TIMEOUT',
  CANCELLED: 'CANCELLED',
  IO_ERROR: 'IO_ERROR',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  DISABLED: 'DISABLED',
});

export type CodeIntelErrorCode =
  (typeof CODEINTEL_ERROR_CODES)[keyof typeof CODEINTEL_ERROR_CODES];

export interface CodeIntelError {
  readonly code: CodeIntelErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Which codes are worth retrying unchanged. Blocking conditions are not. */
const RETRYABLE_CODES: readonly CodeIntelErrorCode[] = Object.freeze([
  CODEINTEL_ERROR_CODES.TIMEOUT,
  CODEINTEL_ERROR_CODES.IO_ERROR,
  CODEINTEL_ERROR_CODES.STALE_SNAPSHOT,
]);

export function isRetryableCode(code: CodeIntelErrorCode): boolean {
  return RETRYABLE_CODES.includes(code);
}

export function codeIntelError(
  code: CodeIntelErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>
): CodeIntelError {
  return {
    code,
    message,
    retryable: isRetryableCode(code),
    ...(details ? { details } : {}),
  };
}

export function ok<T>(
  requestId: string,
  snapshotId: string,
  data: T,
  options: Partial<Pick<Envelope<T>, 'stats' | 'warnings' | 'sessionId'>> = {}
): Envelope<T> {
  return {
    ok: true,
    requestId,
    schemaVersion: '1',
    snapshotId,
    trust: 'untrusted-source-content',
    stats: options.stats ?? {},
    warnings: options.warnings ?? [],
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    data,
  };
}

export function fail<T = never>(
  requestId: string,
  snapshotId: string,
  error: CodeIntelError,
  options: Partial<Pick<Envelope<T>, 'stats' | 'warnings' | 'sessionId'>> = {}
): Envelope<T> {
  return {
    ok: false,
    requestId,
    schemaVersion: '1',
    snapshotId,
    trust: 'untrusted-source-content',
    stats: options.stats ?? {},
    warnings: options.warnings ?? [],
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    error,
  };
}

export interface CodeIntelConfig {
  readonly enabled: boolean;
  readonly readOnly: true;
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly timeoutMs: number;
}

/**
 * Defaults are the safe ones: nothing runs (`enabled: false`), nothing writes
 * (`readOnly: true`), and every resource has a ceiling. Frozen, so a caller
 * that forgets to spread gets an error in strict mode instead of a silently
 * mutated shared default.
 */
export const DEFAULT_CODEINTEL_CONFIG: CodeIntelConfig = Object.freeze({
  enabled: false,
  readOnly: true,
  maxFiles: 10_000,
  maxFileBytes: 2_000_000,
  timeoutMs: 30_000,
});

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit, arrays in order.
 *
 * Code-unit order, not `localeCompare` — the canonical form has to be the same
 * string in every process, and collation depends on the ICU build of the
 * runtime.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, current) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return current;
    return Object.fromEntries(
      Object.entries(current).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    );
  });
}

/** Comparison used for every deterministic path/key ordering. */
export function compareCanonical(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function assertKeyPart(part: string, what: string): void {
  if (!part) throw new TypeError(`${what} must be non-empty`);
  if (part.includes('::')) throw new TypeError(`${what} must not contain "::": ${part}`);
  if (part.includes('#')) throw new TypeError(`${what} must not contain "#": ${part}`);
}

/**
 * Additive mapping for pipeline data that already embeds key separators.
 *
 * Some producers store `path::name`-shaped values in `fullyQualifiedName`
 * (see `SymbolIdentity`/`JsonSymbolExtractor`), which can never be a key
 * part verbatim. This mapping is deterministic and total: the same symbol
 * always yields the same part, and the result always satisfies
 * `assertKeyPart`. Callers that need duplicate disambiguation keep using
 * the `#ordinal` suffix from `makeSymbolKey`.
 */
export function sanitizeKeyPart(part: string): string {
  return part.replace(/::/g, ':').replace(/#/g, '_');
}

/**
 * Relative, POSIX-style, already normalized: no absolute path, no drive letter,
 * no backslash, no empty/`.`/`..` segment, no trailing slash.
 */
export function assertRelativePosixPath(relativePath: string, what: string): void {
  if (!relativePath) throw new TypeError(`${what} path must be non-empty`);
  if (relativePath.includes('\0')) throw new TypeError(`${what} path must not contain NUL`);
  if (relativePath.includes('\\')) {
    throw new TypeError(`${what} path must use "/" separators: ${relativePath}`);
  }
  if (relativePath.startsWith('/')) {
    throw new TypeError(`${what} path must be relative: ${relativePath}`);
  }
  if (/^[A-Za-z]:/u.test(relativePath)) {
    throw new TypeError(`${what} path must not carry a drive letter: ${relativePath}`);
  }
  if (relativePath.endsWith('/')) {
    throw new TypeError(`${what} path must not end with "/": ${relativePath}`);
  }
  for (const segment of relativePath.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new TypeError(`${what} path must be normalized: ${relativePath}`);
    }
  }
  if (relativePath.includes('::')) {
    throw new TypeError(`${what} path must not contain "::": ${relativePath}`);
  }
}

/** Same rule for a directory argument of `FileProvider.list`. `''` = root. */
export function assertRelativeDirectory(relativeDirectory: string): void {
  if (relativeDirectory === '') return;
  assertRelativePosixPath(relativeDirectory, 'list');
}
