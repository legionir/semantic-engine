/**
 * Path confinement shared by every file boundary (D-0007).
 *
 * `ConfinedFileProvider` (async, ports, deadlines) and `SourceSecurityGuard` (sync, used by the
 * read tools and by source sync/write) used to carry two copies of the same rules. The rules
 * live here once; the two callers differ only in how they touch the file system:
 *
 *   1. lexical confinement  — `resolveLexical`: empty path, NUL byte, `..`/absolute escape
 *   2. denylist             — `isDeniedPath`: secrets and `.git`
 *   3. canonical confinement — `isInside(canonicalRoot, realpath(deepest existing ancestor))`,
 *      which also covers a symlink in an ancestor of a file that does not exist yet (writes)
 *
 * `confinePathSync` runs all three with node:fs for the synchronous callers. Policy that belongs
 * to a caller (blocked extensions, size caps, deadlines) stays with that caller.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_DENIED_PATTERNS, DEFAULT_DENIED_SEGMENTS } from './fileProviderTypes';

export type ConfinementFailure = 'empty' | 'nul' | 'escape' | 'denied' | 'no-root' | 'symlink' | 'unresolvable' | 'missing';

export type ConfinementResult =
  | { readonly ok: true; readonly absolute: string }
  | { readonly ok: false; readonly failure: ConfinementFailure; readonly reason: string };

/** `target` is `root` or lives under it. Both arguments are absolute. */
export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  if (relative === '') return true;
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Is this workspace-relative path on the secret/`.git` denylist? Used by the provider, the sync
 * boundary and the MCP source tools, which read indexed files directly.
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

/** Step 1: no I/O. Returns the absolute path or the reason it was refused. */
export function resolveLexical(workspaceRoot: string, relativePath: string): ConfinementResult {
  if (!relativePath || relativePath.trim() === '') {
    return { ok: false, failure: 'empty', reason: 'Path cannot be empty' };
  }
  if (relativePath.includes('\0')) {
    return { ok: false, failure: 'nul', reason: 'Null byte injection detected' };
  }
  const absolute = path.resolve(workspaceRoot, relativePath);
  if (!isInside(path.resolve(workspaceRoot), absolute)) {
    return {
      ok: false,
      failure: 'escape',
      reason: `Path traversal detected: '${relativePath}' escapes root '${workspaceRoot}'`,
    };
  }
  return { ok: true, absolute };
}

export interface ConfineSyncOptions {
  /** Refuse a path that does not exist (reads). Writes leave this false. */
  readonly mustExist?: boolean;
  /** Apply the secret/`.git` denylist. Default true. */
  readonly denylist?: boolean;
}

/** Steps 1–3 with node:fs. Never throws. */
export function confinePathSync(
  workspaceRoot: string,
  relativePath: string,
  options: ConfineSyncOptions = {}
): ConfinementResult {
  const lexical = resolveLexical(workspaceRoot, relativePath);
  if (!lexical.ok) return lexical;
  const { absolute } = lexical;

  let canonicalRoot: string;
  try {
    canonicalRoot = fs.realpathSync(path.resolve(workspaceRoot));
  } catch {
    return { ok: false, failure: 'no-root', reason: `Root does not exist: '${workspaceRoot}'` };
  }

  if (options.denylist !== false && isDeniedPath(relativePath)) {
    return { ok: false, failure: 'denied', reason: `Path is on the secret/.git denylist: '${relativePath}'` };
  }

  // Deepest existing ancestor: a symlinked directory above a not-yet-created file must still be caught.
  let existing = absolute;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  if (options.mustExist && existing !== absolute) {
    return { ok: false, failure: 'missing', reason: `No such file: '${relativePath}'` };
  }

  try {
    if (!isInside(canonicalRoot, fs.realpathSync(existing))) {
      return { ok: false, failure: 'symlink', reason: `Symlink traversal detected for '${relativePath}'` };
    }
  } catch {
    return { ok: false, failure: 'unresolvable', reason: `Unable to resolve path safely: '${relativePath}'` };
  }
  return { ok: true, absolute };
}
