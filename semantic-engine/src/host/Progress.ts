/**
 * گزارش پیشرفت مستقل از ویرایشگر.
 *
 * شکل `report({ message, increment })` عمداً همان `vscode.Progress` است
 * تا مصرف‌کننده‌های موجود دست‌نخورده بمانند. `increment` مثل VS Code
 * «درصد اضافه‌شده» است، نه مقدار مطلق.
 */

export interface ProgressUpdate {
  readonly message?: string;
  readonly increment?: number;
}

/**
 * کمینهٔ چیزی که یک مصرف‌کننده لازم دارد.
 *
 * عمداً از `ProgressReporter` جداست: `WorkspaceScanner` فقط گزارش
 * می‌دهد و هرگز `done()` را صدا نمی‌زند — پایان دادن کار *مالک* گزارش
 * است. با این تفکیک، `vscode.Progress` هم ساختاری با آن جور درمی‌آید و
 * مسیر مهاجرت بدون شکستن فراخوان‌های موجود باز می‌ماند.
 */
export interface ProgressLike {
  report(update: ProgressUpdate): void;
}

export interface ProgressReporter extends ProgressLike {
  report(update: ProgressUpdate): void;
  done(): void;
}

export interface ProgressSink {
  write(chunk: string): unknown;
  readonly isTTY?: boolean;
  readonly columns?: number;
}

/** برای تست‌ها و کتابخانه‌ای که نباید چیزی چاپ کند. */
export class SilentProgress implements ProgressReporter {
  report(_update: ProgressUpdate): void {}
  done(): void {}
}

export interface TtyProgressOptions {
  readonly sink?: ProgressSink;
  readonly throttleMs?: number;
  readonly columns?: number;
  readonly now?: () => number;
}

/**
 * یک خط که بازنویسی می‌شود.
 *
 * دو ریزه‌کاری که در عمل مهم‌اند: کنترل جریان (یک بازنویسی به‌ازای هر
 * فایل روی ده‌هزار فایل خودش کندی می‌آورد) و بریدن خط بلند (پیچش خط،
 * بازنویسی با `\r` را خراب می‌کند و ترمینال پر از خطوط نصفه می‌شود).
 */
export class TtyProgress implements ProgressReporter {
  private readonly sink: ProgressSink;
  private readonly throttleMs: number;
  private readonly now: () => number;
  private readonly columns: number;

  private percent = 0;
  private message = '';
  private lastRenderAt = -Infinity;
  private lastLineLength = 0;

  constructor(options: TtyProgressOptions = {}) {
    this.sink = options.sink ?? process.stderr;
    this.throttleMs = options.throttleMs ?? 80;
    this.now = options.now ?? Date.now;
    this.columns = options.columns ?? this.sink.columns ?? 80;
  }

  report(update: ProgressUpdate): void {
    if (update.increment !== undefined) {
      // سقف ۱۰۰: جمع خطاهای ممیز شناور روی هزاران فایل از ۱۰۰ رد می‌کند.
      this.percent = Math.min(100, this.percent + update.increment);
    }
    if (update.message !== undefined) {
      this.message = update.message;
    }

    const at = this.now();
    if (at - this.lastRenderAt < this.throttleMs) return;
    this.lastRenderAt = at;
    this.render();
  }

  done(): void {
    this.render();
    this.sink.write('\n');
  }

  private render(): void {
    const prefix = `[${String(Math.round(this.percent)).padStart(3, ' ')}%] `;
    const room = Math.max(0, this.columns - prefix.length);
    const body = this.message.length > room ? this.message.slice(0, room) : this.message;
    let line = prefix + body;

    /*
    | خط قبلی ممکن است بلندتر بوده باشد؛ بدون پر کردن با فاصله، دنبالهٔ
    | آن روی صفحه باقی می‌ماند.
    */
    if (line.length < this.lastLineLength) {
      line = line.padEnd(Math.min(this.lastLineLength, this.columns), ' ');
    }
    this.lastLineLength = line.length;

    this.sink.write('\r' + line);
  }
}

export interface NdjsonProgressOptions {
  readonly sink?: ProgressSink;
  readonly now?: () => Date;
}

/** یک رکورد JSON در هر خط — برای CI و پروسهٔ والد. */
export class NdjsonProgress implements ProgressReporter {
  private readonly sink: ProgressSink;
  private readonly now: () => Date;
  private percent = 0;
  private message = '';

  constructor(options: NdjsonProgressOptions = {}) {
    this.sink = options.sink ?? process.stderr;
    this.now = options.now ?? (() => new Date());
  }

  report(update: ProgressUpdate): void {
    if (update.increment !== undefined) {
      this.percent = Math.min(100, this.percent + update.increment);
    }
    if (update.message !== undefined) {
      this.message = update.message;
    }

    this.write({
      type: 'progress',
      ts: this.now().toISOString(),
      message: this.message,
      percent: round(this.percent),
    });
  }

  done(): void {
    this.write({
      type: 'progress-done',
      ts: this.now().toISOString(),
      percent: round(this.percent),
    });
  }

  private write(record: Record<string, unknown>): void {
    try {
      this.sink.write(JSON.stringify(record) + '\n');
    } catch {
      // مثل لاگر: گزارش پیشرفت نباید ایندکس را زمین بزند.
    }
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface CreateProgressOptions {
  readonly mode?: 'auto' | 'tty' | 'ndjson' | 'silent';
  readonly sink?: ProgressSink;
  /** حالت سرور stdio: هیچ‌چیز نباید روی stdout برود. */
  readonly stdio?: boolean;
  readonly throttleMs?: number;
}

export function createProgressReporter(options: CreateProgressOptions = {}): ProgressReporter {
  const mode = options.mode ?? 'auto';
  const sink = options.sink ?? process.stderr;

  if (options.stdio) return new SilentProgress();

  switch (mode) {
    case 'silent':
      return new SilentProgress();
    case 'ndjson':
      return new NdjsonProgress({ sink });
    case 'tty':
      return new TtyProgress({ sink, throttleMs: options.throttleMs });
    default:
      /*
      | خروجی هدایت‌شده به فایل یا لوله TTY نیست؛ نوشتن `\r` آنجا فقط
      | یک فایل لاگ آشغال می‌سازد.
      */
      return sink.isTTY
        ? new TtyProgress({ sink, throttleMs: options.throttleMs })
        : new SilentProgress();
  }
}
