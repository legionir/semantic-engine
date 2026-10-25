/**
 * Per-project locks — فاز ۸.
 *
 * Nothing in this codebase had a lock before: two `semantic-engine start`
 * against one workspace produced two watchers writing the same artifacts, and
 * two Gateway `start` calls for one project produced two workers.
 *
 * The lock is a file created with `O_EXCL` (`flag: 'wx'`), so the race is
 * decided by the filesystem rather than by whoever checks first. The file
 * carries the owner's pid and a heartbeat, which is what makes a crash
 * recoverable: a lock whose owner is gone, or whose heartbeat is older than
 * `staleAfterMs`, is taken over instead of blocking the project forever.
 *
 * Two locks per project, under `<artifactRoot>/locks/`:
 *
 *   - `worker.lock` — at most one worker process per project;
 *   - `index.lock`  — at most one index run per project (different projects
 *     index in parallel).
 */

import * as fs from 'fs';
import * as path from 'path';

export const WORKER_LOCK_FILE = 'worker.lock';
export const INDEX_LOCK_FILE = 'index.lock';

/** یک heartbeat قدیمی‌تر از این، یعنی صاحب lock رفته است. */
export const DEFAULT_STALE_AFTER_MS = 30_000;

export interface LockInfo {
  readonly projectId: string;
  readonly pid: number;
  readonly kind: 'worker' | 'index';
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
}

export interface AcquireLockOptions {
  readonly staleAfterMs?: number;
  readonly now?: () => Date;
  /** برای تست: جای `process.pid`. */
  readonly pid?: number;
  readonly isProcessAlive?: (pid: number) => boolean;
}

export type LockAcquireResult =
  | { readonly ok: true; readonly info: LockInfo; readonly release: () => void; readonly heartbeat: () => void; readonly recovered: boolean }
  | { readonly ok: false; readonly holder: LockInfo | null; readonly reason: 'held' | 'unreadable' };

export function readLock(lockPath: string): LockInfo | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Partial<LockInfo>;
    if (typeof parsed.pid !== 'number' || typeof parsed.projectId !== 'string') return null;
    return {
      projectId: parsed.projectId,
      pid: parsed.pid,
      kind: parsed.kind === 'index' ? 'index' : 'worker',
      acquiredAt: String(parsed.acquiredAt ?? ''),
      heartbeatAt: String(parsed.heartbeatAt ?? ''),
    };
  } catch {
    return null;
  }
}

function defaultIsAlive(pid: number): boolean {
  try {
    /* سیگنال ۰ چیزی نمی‌کشد؛ فقط وجود پروسه را می‌سنجد. */
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * جانشینی اتمیکِ فایل lock — F-0026.
 *
 * `readLock` روی متنِ نیمه‌نوشته `null` می‌دهد، و «null» در این فایل
 * نشانهٔ رهاشدن بود؛ پس heartbeatِ غیراتمی می‌توانست قفلِ یک صاحبِ
 * زنده را قابل‌پاک‌کردن نشان بدهد و دو worker روی یک پروژه بسازد.
 */
function replaceAtomically(target: string, content: string): boolean {
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, target);
    return true;
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* فایل موقت خودش نمانده است. */
    }
    return false;
  }
}

/**
 * pid را از متنِ خام درمی‌آورد، حتی وقتی JSON کامل نیست.
 *
 * دقیقاً برای همان حالتِ بالا: JSONِ نیمه‌نوشته parse نمی‌شود ولی `"pid":`
 * که اولِ شیء است معمولاً خوانده می‌شود، و همین کافی است تا بفهمیم صاحب
 * هنوز زنده است یا نه.
 */
function pidFromRawLock(lockPath: string): number | null {
  try {
    const match = fs.readFileSync(lockPath, 'utf8').match(/"pid"\s*:\s*(\d+)/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/**
 * تلاش برای گرفتن lock.
 *
 * هرگز throw نمی‌کند: «کس دیگری آن را دارد» یک نتیجه است، نه خطا. تنها خطای
 * ممکن، نوشتن روی دیسک است که به‌صورت `reason: 'unreadable'` برگردانده
 * می‌شود تا caller بتواند تصمیم بگیرد.
 */
export function acquireLock(
  lockPath: string,
  projectId: string,
  kind: 'worker' | 'index',
  options: AcquireLockOptions = {}
): LockAcquireResult {
  const now = options.now ?? (() => new Date());
  const pid = options.pid ?? process.pid;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const isAlive = options.isProcessAlive ?? defaultIsAlive;

  const write = (recovered: boolean): LockAcquireResult | null => {
    const timestamp = now().toISOString();
    const info: LockInfo = { projectId, pid, kind, acquiredAt: timestamp, heartbeatAt: timestamp };

    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    try {
      fs.writeFileSync(lockPath, `${JSON.stringify(info, null, 2)}\n`, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        return { ok: false, holder: readLock(lockPath), reason: 'unreadable' };
      }
      return null;
    }

    return {
      ok: true,
      info,
      recovered,
      heartbeat: () => {
        const current = readLock(lockPath);
        /* فقط صاحب lock heartbeat می‌نویسد؛ وگرنه یک پروسهٔ دیگر را زنده نگه می‌دارد. */
        if (!current || current.pid !== pid) return;
        /*
        | F-0026 — heartbeat اتمیک جایگزین می‌شود، پس خواننده‌ای هرگز
        | نیمه‌نوشته نمی‌بیند. اگر rename نشد، فایلِ قبلی دست‌نخورده
        | می‌ماند: یک heartbeatِ از‌دست‌رفته بهتر از قفلِ دو‌صاحبی نیست.
        */
        replaceAtomically(
          lockPath,
          `${JSON.stringify({ ...current, heartbeatAt: now().toISOString() }, null, 2)}\n`
        );
      },
      release: () => {
        const current = readLock(lockPath);
        if (!current || current.pid !== pid) return;
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {
          /* نبود فایل یعنی کار تمام است. */
        }
      },
    };
  };

  const first = write(false);
  if (first) return first;

  /*
  | فایل وجود دارد: صاحبش زنده است یا رها شده؟
  */
  const holder = readLock(lockPath) ?? readLock(lockPath);
  if (!holder) {
    /*
    | فایل هست ولی خواندنی نیست.
    |
    | F-0026 — این دیگر به‌خودی‌خود نشانهٔ رهاشدن نیست: تا پیش از این
    | همین‌جا قفل را پاک و پس می‌گرفت، یعنی یک heartbeat نیمه‌نوشته
    | می‌توانست صاحبِ زنده را بی‌قفل کند و دو worker روی یک پروژه
    | بنشیند. اول دوباره می‌خوانیم (برشِ لحظه‌ای)، بعد اگر باز هم
    | نشد pidِ خام را از متن بیرون می‌کشیم: صاحب زنده باشد، قفلِ او
    | دست‌نخورده می‌ماند.
    */
    const rawPid = pidFromRawLock(lockPath);
    if (rawPid !== null && isAlive(rawPid)) {
      return { ok: false, holder: null, reason: 'held' };
    }
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {
      return { ok: false, holder: null, reason: 'unreadable' };
    }
    const retry = write(true);
    return retry ?? { ok: false, holder: readLock(lockPath), reason: 'held' };
  }

  const heartbeatAt = Date.parse(holder.heartbeatAt);
  const heartbeatAge = Number.isFinite(heartbeatAt) ? now().getTime() - heartbeatAt : Infinity;
  const stale = !isAlive(holder.pid) || heartbeatAge > staleAfterMs;

  if (!stale) {
    return { ok: false, holder, reason: 'held' };
  }

  try {
    fs.rmSync(lockPath, { force: true });
  } catch {
    return { ok: false, holder, reason: 'held' };
  }

  const recovered = write(true);
  return recovered ?? { ok: false, holder: readLock(lockPath), reason: 'held' };
}
