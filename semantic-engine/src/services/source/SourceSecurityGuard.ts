/**
 * SourceSecurityGuard — Enforces file-system and source integrity guards.
 * Protects against Path Traversal, Symlink Loops, Zip Bombs, and Disallowed Executables.
 */

import * as path from 'path';
import * as fs from 'fs';
import { confinePathSync } from '../../core/contracts/pathConfinement';

export interface SecurityPolicy {
  readonly allowedExtensions?: readonly string[];
  readonly blockedExtensions?: readonly string[];
  readonly maxFileSizeBytes?: number;
  readonly maxTotalSizeBytes?: number;
  readonly maxSymlinkDepth?: number;
}

export const DEFAULT_SECURITY_POLICY: SecurityPolicy = {
  blockedExtensions: ['.exe', '.dll', '.so', '.dylib', '.bin', '.iso', '.dmg'],
  maxFileSizeBytes: 10 * 1024 * 1024, // 10MB
  maxTotalSizeBytes: 200 * 1024 * 1024, // 200MB
  maxSymlinkDepth: 3,
};

export class SourceSecurityGuard {
  constructor(private readonly policy: SecurityPolicy = DEFAULT_SECURITY_POLICY) {}

  /** Confinement is shared with `ConfinedFileProvider` (core/contracts/pathConfinement); only the extension policy is local. */
  validateRelativePath(baseRoot: string, relativePath: string): { ok: boolean; reason?: string; resolvedPath?: string } {
    const confined = confinePathSync(baseRoot, relativePath);
    if (!confined.ok) return { ok: false, reason: confined.reason };

    const ext = path.extname(relativePath).toLowerCase();
    if (this.policy.blockedExtensions?.includes(ext)) {
      return { ok: false, reason: `Disallowed binary/executable file extension: ${ext}` };
    }
    return { ok: true, resolvedPath: confined.absolute };
  }

  validateFileSize(bytes: number): { ok: boolean; reason?: string } {
    const limit = this.policy.maxFileSizeBytes || 10 * 1024 * 1024;
    if (bytes > limit) {
      return { ok: false, reason: `File size (${bytes} bytes) exceeds limit of ${limit} bytes` };
    }
    return { ok: true };
  }

  validateTotalSize(bytes: number): { ok: boolean; reason?: string } {
    const limit = this.policy.maxTotalSizeBytes || 200 * 1024 * 1024;
    if (bytes > limit) {
      return { ok: false, reason: `Bundle size (${bytes} bytes) exceeds limit of ${limit} bytes` };
    }
    return { ok: true };
  }

  /**
   * Walks a symlink chain one hop at a time.
   *
   * SE-P0-SYM-01 — the previous version asked `fs.existsSync()` first and
   * `fs.realpathSync()` second, which made both of its checks unreachable:
   *
   *   - `existsSync` follows links, so a cyclic link (`a → b → a`) reports
   *     "does not exist" and the function returned `ok: true` for exactly the
   *     case it was written to catch;
   *   - `realpathSync` returns the *final* canonical path in one call, so the
   *     chain was never walked and `maxSymlinkDepth` could never be exceeded.
   *
   * Measured with a two-link cycle and a five-deep chain: both were reported
   * `ok: true`. `ReadBoundary.phase0.test.ts` now pins the corrected behaviour.
   * A dangling link is still `ok: true` — there is nothing behind it to guard —
   * but it is detected with `lstat`, which does not follow.
   */
  validateSymlink(targetPath: string, visited: Set<string> = new Set()): { ok: boolean; reason?: string } {
    const maxDepth = this.policy.maxSymlinkDepth || 3;
    let current = targetPath;

    try {
      for (let hops = 0; ; hops += 1) {
        let stat: fs.Stats;
        try {
          stat = fs.lstatSync(current);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true };
          throw err;
        }
        if (!stat.isSymbolicLink()) return { ok: true };

        const linkTarget = fs.readlinkSync(current);
        const next = path.resolve(path.dirname(current), linkTarget);

        if (visited.has(next)) {
          return { ok: false, reason: `Cyclic symlink loop detected at: ${current}` };
        }
        visited.add(next);

        if (hops + 1 > maxDepth) {
          return { ok: false, reason: `Symlink traversal depth exceeded limit of ${maxDepth}` };
        }

        current = next;
      }
    } catch (err) {
      return { ok: false, reason: `Symlink resolution error: ${(err as Error).message}` };
    }
  }
}
