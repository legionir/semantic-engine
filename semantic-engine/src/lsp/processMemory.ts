/**
 * حافظهٔ یک پروسهٔ فرزند — بخشی از LSP-05 (سقف حافظه).
 *
 * چرا لازم است: اندازه‌گیری `LSP-ARCHITECTURE.md` روی ۱۶۴ فایل همین
 * مخزن، **۸۰۹ مگابایت** برای زبان‌سرور داد. روی یک مخزن بزرگ‌تر،
 * سروری که سقف نداشته باشد ماشین را می‌خورد و OOM killer به‌جای ما
 * تصمیم می‌گیرد — که یعنی کل پروسهٔ ایندکس هم ممکن است با آن برود.
 *
 * سه راه سنجیده شد:
 *
 * ```
 * /proc/<pid>/status  → VmRSS: 41776 kB     ← بدون spawn، فقط لینوکس
 * ps -o rss= -p <pid> → "41776"             ← لینوکس و macOS، یک spawn
 * ویندوز              → هیچ‌کدام            ← null
 * ```
 *
 * ترتیب همین است: `/proc` ارزان است و هیچ پروسه‌ای نمی‌سازد؛ `ps`
 * فقط وقتی که `/proc` نباشد. روی ویندوز `null` برمی‌گردد و سقف
 * حافظه عملاً خاموش است — که صادقانه‌تر از عددی است که معنی‌اش را
 * نمی‌دانیم.
 */

import * as fs from 'fs';
import { spawnSync } from 'child_process';

/** مصرف حافظهٔ مقیم، به مگابایت. `null` یعنی قابل اندازه‌گیری نیست. */
export function residentMemoryMb(pid: number | undefined): number | null {
  if (!pid || pid <= 0) return null;

  const fromProc = readProcStatus(pid);
  if (fromProc !== null) return fromProc;

  return readPs(pid);
}

function readProcStatus(pid: number): number | null {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    if (!match) return null;
    return Number(match[1]) / 1024;
  } catch {
    /*
    | پروسه مرده، یا سیستم‌عامل `/proc` ندارد. هیچ‌کدام خطا نیست —
    | فقط یعنی این راه جواب نداد.
    */
    return null;
  }
}

function readPs(pid: number): number | null {
  if (process.platform === 'win32') return null;
  try {
    const result = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    if (result.status !== 0) return null;
    const kb = Number((result.stdout ?? '').trim());
    return Number.isFinite(kb) && kb > 0 ? kb / 1024 : null;
  } catch {
    return null;
  }
}
