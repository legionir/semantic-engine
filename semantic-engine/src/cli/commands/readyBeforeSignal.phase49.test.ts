/**
 * فاز ۴۹، گام افزوده — «آماده‌ام» را نباید پیش از آماده بودن گفت.
 *
 * ── چطور پیدا شد ────────────────────────────────────────────────────
 *
 * حین اجرای گیت فاز ۴۹، آزمون `MIG-52 — SIGTERM هم خاموشی تمیز
 * می‌دهد` یک بار قرمز شد و اجرای بعدی سبز بود. وسوسهٔ طبیعی این است
 * که اسمش را «flake» بگذاریم و رد شویم. اندازه‌گیری شد و flake نبود:
 *
 * ```
 * ۸ اجرا، ماشین بی‌کار     : clean 8 · unclean 0 · stale pid files 0
 * ۸ اجرا، ۸ حلقهٔ CPU در پس‌زمینه : clean 3 · unclean 5 · stale pid files 5
 *     run 0: exit code=null signal=SIGTERM   stale pid file: watch.pid
 *     run 1: exit code=null signal=SIGTERM   stale pid file: watch.pid
 *     …
 * ```
 *
 * علت در `watch-command.ts` بود:
 *
 * ```ts
 * await pipeline.watchFilesystem();
 * process.stderr.write('… press Ctrl+C to stop\n');   // ← «آماده‌ام»
 * await waitForShutdown(…);                            // ← تازه اینجا
 * ```                                                  //   handler نصب می‌شود
 *
 * بین آن دو خط، پروسه هیچ handlerی برای SIGINT/SIGTERM ندارد، پس
 * سیگنال با رفتار پیش‌فرض پروسه را می‌کشد: `finally` اجرا نمی‌شود،
 * `pipeline.dispose()` صدا زده نمی‌شود، و فایل PID جا می‌ماند.
 *
 * این باگ محصول است، نه باگ آزمون. کاربری که `watch` را اجرا کند و
 * سریع Ctrl+C بزند، دقیقاً همین را می‌گیرد. `serve --http` هم همین
 * ترتیب را داشت.
 *
 * ── چرا این آزمون درون‌پروسه‌ای است ──────────────────────────────────
 *
 * چون خودِ پنجرهٔ مسابقه را نمی‌شود قطعی بازتولید کرد — بستگی به بار
 * ماشین دارد. ولی *قاعده* قطعی است: **در لحظه‌ای که نشانهٔ آمادگی
 * نوشته می‌شود، handler باید نصب شده باشد.** این آزمون همان لحظه را
 * می‌گیرد و تعداد شنوندهٔ سیگنال را می‌شمارد.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runWatch, PID_FILE_NAME } from './watch-command';
import { CommandContext } from './types';

const quietLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as CommandContext['logger'];

let workspace: string;
let originalWrite: typeof process.stderr.write;
let sigintBefore: number;
let sigtermBefore: number;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'se-ready-'));
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.writeFileSync(path.join(workspace, 'src', 'a.ts'), 'export const a = 1;\n');
  originalWrite = process.stderr.write.bind(process.stderr);
  sigintBefore = process.listenerCount('SIGINT');
  sigtermBefore = process.listenerCount('SIGTERM');
});

afterEach(() => {
  process.stderr.write = originalWrite;
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('فاز ۴۹ — آمادگی و سیگنال', () => {
  it('وقتی watch می‌گوید آماده است، handler سیگنال نصب شده است', async () => {
    let sigintWhenReady = -1;
    let sigtermWhenReady = -1;

    /*
    | همان لحظه‌ای که نشانه نوشته می‌شود، شنونده‌ها شمرده می‌شوند.
    | نه قبلش، نه بعدش — چون پنجرهٔ باگ دقیقاً همان‌جاست.
    */
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      if (text.includes('press Ctrl+C') && sigintWhenReady === -1) {
        sigintWhenReady = process.listenerCount('SIGINT') - sigintBefore;
        sigtermWhenReady = process.listenerCount('SIGTERM') - sigtermBefore;
        /* حالا که نشانه آمده، پروسه را با همان سیگنال متوقف کن. */
        setImmediate(() => process.emit('SIGTERM' as NodeJS.Signals));
      }
      return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;

    const context: CommandContext = { cwd: workspace, logger: quietLogger };
    const result = await runWatch(
      {
        command: 'watch',
        /*
        | مسیر artifact صریح داده می‌شود: از فاز ۴ پیش‌فرض `external` است و
        | این آزمون دربارهٔ سیگنال‌ها و فایل PID است، نه دربارهٔ محل artifact.
        */
        options: { root: workspace, git: false, out: path.join(workspace, '.semantic-engine') },
        positionals: [],
      } as never,
      context
    );

    expect(sigintWhenReady).toBe(1);
    expect(sigtermWhenReady).toBe(1);
    expect(result.code).toBe(0);
  }, 120_000);

  it('پس از خاموشی، فایل PID جا نمی‌ماند', async () => {
    const pidPath = path.join(workspace, '.semantic-engine', PID_FILE_NAME);
    let existedWhileRunning = false;
    let ownerPid = -1;

    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      if (text.includes('press Ctrl+C')) {
        /*
        | بدون این دو خط، آزمون با یک `runWatch` که اصلاً راه
        | نیفتاده هم سبز می‌شود — «فایل نیست» هم وقتی درست است که
        | هرگز ساخته نشده باشد.
        */
        existedWhileRunning = fs.existsSync(pidPath);
        ownerPid = Number(fs.readFileSync(pidPath, 'utf8').trim());
        setImmediate(() => process.emit('SIGINT' as NodeJS.Signals));
      }
      return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;

    const result = await runWatch(
      {
        command: 'watch',
        /*
        | مسیر artifact صریح داده می‌شود: از فاز ۴ پیش‌فرض `external` است و
        | این آزمون دربارهٔ سیگنال‌ها و فایل PID است، نه دربارهٔ محل artifact.
        */
        options: { root: workspace, git: false, out: path.join(workspace, '.semantic-engine') },
        positionals: [],
      } as never,
      { cwd: workspace, logger: quietLogger }
    );

    expect(existedWhileRunning).toBe(true);
    expect(ownerPid).toBe(process.pid);
    expect(result.code).toBe(0);
    expect(fs.existsSync(pidPath)).toBe(false);
  }, 120_000);
});
