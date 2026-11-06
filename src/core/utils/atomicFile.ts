/**
 * Small synchronous file primitives shared by every store that keeps its state
 * in one JSON file (registry, config, job state, worker config, cache).
 *
 * - `atomicWriteFileSync`: temp file in the same directory → `fsync` → `rename`.
 *   A reader never sees half a file and a power cut cannot leave an empty one.
 *   On Windows the rename is retried briefly when another process holds the
 *   target open (EPERM / EBUSY / EACCES), like `FileSystem.writeJsonAtomic`.
 * - `withFileLockSync`: cross-process mutual exclusion for a read-modify-write.
 *   The lock file records its owner; a lock is only taken over when its owner
 *   process is gone or it is older than `staleMs`, and only the owner removes it.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const BUSY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_PAUSES_MS = [10, 25, 50, 100, 200, 400, 800];

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface AtomicWriteOptions {
  readonly mode?: number;
  /** Directory mode when the parent has to be created. */
  readonly dirMode?: number;
  /** Test seam; defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
}

export function atomicWriteFileSync(
  target: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {}
): void {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true, ...(options.dirMode !== undefined ? { mode: options.dirMode } : {}) });
  const tmp = path.join(
    dir,
    `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  );

  try {
    const fd = fs.openSync(tmp, 'w', options.mode ?? 0o600);
    try {
      fs.writeFileSync(fd, data);
      try {
        fs.fsyncSync(fd);
      } catch {
        /* some filesystems refuse fsync; the rename below is still atomic */
      }
    } finally {
      fs.closeSync(fd);
    }
    renameWithRetry(tmp, target, options.platform ?? process.platform);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* nothing left to clean */
    }
    throw error;
  }
}

export function atomicWriteJsonSync(target: string, value: unknown, options: AtomicWriteOptions = {}): void {
  atomicWriteFileSync(target, `${JSON.stringify(value, null, 2)}\n`, options);
}

function renameWithRetry(from: string, to: string, platform: NodeJS.Platform): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const pause = RENAME_PAUSES_MS[attempt];
      if (platform !== 'win32' || !code || !BUSY_CODES.has(code) || pause === undefined) throw error;
      sleepSync(pause);
    }
  }
}

export interface FileLockOptions {
  /** A lock whose owner is gone, or older than this, may be taken over. */
  readonly staleMs?: number;
  /** How long to wait before giving up with an error. */
  readonly waitMs?: number;
}

interface LockOwner {
  readonly pid: number;
  readonly token: string;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readOwner(lock: string): LockOwner | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lock, 'utf8')) as Partial<LockOwner>;
    if (typeof parsed.pid === 'number' && typeof parsed.token === 'string') {
      return { pid: parsed.pid, token: parsed.token };
    }
  } catch {
    /* unreadable or half-written: judged by age only */
  }
  return null;
}

export class FileLockTimeoutError extends Error {
  constructor(lock: string, waitMs: number) {
    super(`could not acquire ${lock} within ${waitMs} ms`);
    this.name = 'FileLockTimeoutError';
  }
}

export function withFileLockSync<T>(lock: string, run: () => T, options: FileLockOptions = {}): T {
  const staleMs = options.staleMs ?? 10_000;
  const waitMs = options.waitMs ?? 5_000;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const owner: LockOwner = { pid: process.pid, token: crypto.randomBytes(8).toString('hex') };
  const deadline = Date.now() + waitMs;

  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(owner));
      } finally {
        fs.closeSync(fd);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

      let stale = false;
      try {
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        const current = readOwner(lock);
        stale = age > staleMs || (current !== null && current.pid !== process.pid && !processAlive(current.pid));
      } catch {
        continue; /* released between the two calls */
      }
      if (stale) {
        try {
          fs.rmSync(lock, { force: true });
        } catch {
          /* another waiter took it over first */
        }
        continue;
      }
      if (Date.now() > deadline) throw new FileLockTimeoutError(lock, waitMs);
      sleepSync(15);
    }
  }

  try {
    return run();
  } finally {
    /* only the owner removes the lock: a taken-over lock belongs to someone else now */
    const current = readOwner(lock);
    if (current === null || current.token === owner.token) {
      try {
        fs.rmSync(lock, { force: true });
      } catch {
        /* best effort */
      }
    }
  }
}
