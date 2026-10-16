/**
 * FileWatcher — رصد فایل‌سیستم بدون ویرایشگر — MIG-40، MIG-41، MIG-42.
 *
 * ── چرا chokidar و نه `fs.watch` ──────────────────────────────────
 *
 * `fs.watch` با `recursive: true` روی لینوکس تازه از Node 20 کار
 * می‌کند، رویدادهای تکراری می‌دهد، و «فایل کامل نوشته شد» را نمی‌داند.
 * ویرایشگرها هنگام ذخیره فایل موقت می‌سازند و rename می‌کنند، پس
 * بدون `awaitWriteFinish` هر Ctrl+S چند رویداد کاذب می‌سازد.
 *
 * ── MIG-41: rename وجود ندارد ─────────────────────────────────────
 *
 * chokidar رویداد rename ندارد — فقط `add` و `unlink`. با یک probe
 * تأیید شد که ترتیبشان هم تضمین‌شده نیست:
 *
 * ```
 * fs.renameSync('src/b.ts', 'src/c.ts')
 *   → add:src/c.ts
 *   → unlink:src/b.ts        ← بعد از add آمد
 * ```
 *
 * بازسازی با تطبیق **محتوا** انجام می‌شود: فایل تازه‌آمده hash
 * می‌شود، و برای فایل رفته از `previousHash` پرسیده می‌شود (که
 * فراخوان به ایندکس موجود وصلش می‌کند — فایل دیگر روی دیسک نیست و
 * نمی‌شود hashش کرد). اگر در پنجرهٔ کوتاه با هم بخوانند، یک
 * `renamed` بیرون می‌آید؛ وگرنه همان `created` و `deleted` جدا.
 *
 * **هر دو سمت** بافر می‌شوند، چون ترتیب تضمین‌شده نیست — probe بالا
 * `add` را زودتر داد. بافر کردن فقط یک سمت یعنی نصف renameها از دست
 * می‌روند، و کدام نصف، به زمان‌بندی سیستم‌عامل بستگی دارد.
 *
 * هزینه‌اش این است که `created` و `deleted` به اندازهٔ پنجره عقب
 * می‌افتند. `modified` — که حالت رایج است — دست‌نخورده و بی‌تأخیر
 * می‌ماند، و پایین‌دست هم `FileChangeQueue` به‌هرحال debounce
 * می‌کند.
 *
 * MIGRATION هشدار داده بود که این ریسک‌دارترین بخش است و «تنزل صریح
 * به delete+create بهتر از رفتار نصفه‌کاره است». این پیاده‌سازی همان
 * را می‌کند: تطبیق فقط وقتی که hash قطعاً یکی باشد، و در هر حالت
 * دیگری تنزل.
 */

import * as fs from 'fs';
import * as path from 'path';
import { FileChangeEvent } from '../core/types/common.types';
import { IgnoreMatcher, normalizeSeparators } from '../core/config/IgnoreMatcher';
import { ScannerConfig, createScannerConfig } from '../core/config/ScannerConfig';
import { sha256 } from '../core/utils/hash';
import { ILogger, silentLogger } from './Logger';

/** hash ذخیره‌شدهٔ یک مسیر، برای تطبیق rename. */
export type PreviousHashLookup = (relativePath: string) => string | undefined;

export interface FileWatcherOptions {
  readonly workspaceRoot: string;
  readonly onEvent: (event: FileChangeEvent) => void;
  readonly scannerConfig?: Partial<ScannerConfig>;
  /** پوشهٔ خروجی — رصد نمی‌شود (SE-SCAN-17). */
  readonly outputDir?: string;
  /**
   * چقدر یک `unlink` منتظر `add` جفتش بماند. پیش‌فرض ۳۰۰ms، همان
   * عددی که MIGRATION پیشنهاد کرده بود.
   */
  readonly renameWindowMs?: number;
  /** `awaitWriteFinish.stabilityThreshold` — پیش‌فرض ۱۵۰ms. */
  readonly stabilityThresholdMs?: number;
  readonly previousHash?: PreviousHashLookup;
  readonly logger?: ILogger;
}

interface PendingEvent {
  readonly relativePath: string;
  readonly timer: NodeJS.Timeout;
}

interface ChokidarWatcher {
  on(event: string, listener: (...args: unknown[]) => void): ChokidarWatcher;
  close(): Promise<void>;
}

export class FileWatcher {
  private readonly matcher: IgnoreMatcher;
  private readonly logger: ILogger;
  private readonly renameWindowMs: number;
  private readonly stabilityThresholdMs: number;

  private watcher: ChokidarWatcher | null = null;
  private closed = false;

  /** `unlink`هایی که منتظر `add` جفتشان‌اند. کلید: hash محتوا. */
  /*
  | FIFO queue per content hash. A single-valued map made two files with identical
  | content overwrite each other's pending event (the first one was never emitted).
  */
  private readonly pendingUnlinks = new Map<string, PendingEvent[]>();
  /** `add`هایی که منتظر `unlink` جفتشان‌اند. کلید: hash محتوا. */
  private readonly pendingAdds = new Map<string, PendingEvent[]>();

  constructor(private readonly options: FileWatcherOptions) {
    this.logger = options.logger ?? silentLogger;
    this.renameWindowMs = options.renameWindowMs ?? 300;
    this.stabilityThresholdMs = options.stabilityThresholdMs ?? 150;

    this.matcher = new IgnoreMatcher({
      workspaceRoot: options.workspaceRoot,
      config: createScannerConfig(options.scannerConfig),
      outputDir: options.outputDir,
    });
  }

  async start(): Promise<void> {
    if (this.watcher) return;

    /*
    | require تنبل — همان دلیل transformers (SE-EXT-05):
    | کسی که فقط یک بار ایندکس می‌گیرد نباید هزینهٔ بارگذاری
    | watcher را بدهد، و نبود این بسته نباید کل پکیج را بشکند.
    */

    const chokidar = require('chokidar') as {
      watch: (target: string, options: Record<string, unknown>) => ChokidarWatcher;
    };

    const watcher = chokidar.watch(this.options.workspaceRoot, {
      ignoreInitial: true,
      /*
      | ویرایشگرها با نوشتن در فایل موقت و rename ذخیره می‌کنند. بدون
      | این، هر Ctrl+S چند رویداد و گاهی یک فایل نیمه‌نوشته می‌دهد.
      */
      awaitWriteFinish: {
        stabilityThreshold: this.stabilityThresholdMs,
        pollInterval: Math.max(10, Math.floor(this.stabilityThresholdMs / 3)),
      },
      /*
      | MIG-42: فیلتر از همان `IgnoreMatcher` می‌آید که اسکنر
      | استفاده می‌کند. `ignored` روی *پوشه* هم صدا زده می‌شود، پس
      | زیردرخت `node_modules` اصلاً باز نمی‌شود.
      */
      ignored: (target: string) => this.shouldIgnoreAbsolute(target),
    });

    watcher.on('add', (target: unknown) => this.onAdd(String(target)));
    watcher.on('change', (target: unknown) => this.onChange(String(target)));
    watcher.on('unlink', (target: unknown) => this.onUnlink(String(target)));
    watcher.on('error', (error: unknown) => {
      this.logger.warn('watcher error', { cause: String(error) });
    });

    await new Promise<void>(resolve => watcher.on('ready', () => resolve()));
    this.watcher = watcher;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    for (const queue of [...this.pendingUnlinks.values(), ...this.pendingAdds.values()]) {
      for (const pending of queue) clearTimeout(pending.timer);
    }
    this.pendingUnlinks.clear();
    this.pendingAdds.clear();

    const watcher = this.watcher;
    this.watcher = null;
    if (watcher) await watcher.close();
  }

  // ── داخلی ──────────────────────────────────────────────────────

  private shouldIgnoreAbsolute(absolute: string): boolean {
    const relative = normalizeSeparators(path.relative(this.options.workspaceRoot, absolute));
    // خودِ ریشه هرگز ignore نیست، وگرنه chokidar چیزی نمی‌بیند.
    if (!relative) return false;
    return this.matcher.ignoresPath(relative);
  }

  private relativeOf(absolute: string): string {
    return normalizeSeparators(path.relative(this.options.workspaceRoot, absolute));
  }

  private emit(event: FileChangeEvent): void {
    if (this.closed) return;
    this.options.onEvent(event);
  }

  private onChange(absolute: string): void {
    this.emit({ type: 'modified', path: this.relativeOf(absolute) });
  }

  private onAdd(absolute: string): void {
    const relativePath = this.relativeOf(absolute);
    const hash = this.hashOf(absolute);

    if (!hash) {
      this.emit({ type: 'created', path: relativePath });
      return;
    }

    // ترتیب unlink → add
    const waitingUnlink = this.take(this.pendingUnlinks, hash);
    if (waitingUnlink) {
      this.emit({ type: 'renamed', path: relativePath, oldPath: waitingUnlink.relativePath });
      return;
    }

    this.hold(this.pendingAdds, hash, relativePath, () =>
      this.emit({ type: 'created', path: relativePath })
    );
  }

  private onUnlink(absolute: string): void {
    const relativePath = this.relativeOf(absolute);
    const hash = this.options.previousHash?.(relativePath);

    /*
    | بدون hash قبلی، تطبیق ممکن نیست — فایل رفته و نمی‌شود خواندش.
    | تنزل صریح، نه حدس.
    */
    if (!hash) {
      this.emit({ type: 'deleted', path: relativePath });
      return;
    }

    // ترتیب add → unlink
    const waitingAdd = this.take(this.pendingAdds, hash);
    if (waitingAdd) {
      this.emit({ type: 'renamed', path: waitingAdd.relativePath, oldPath: relativePath });
      return;
    }

    this.hold(this.pendingUnlinks, hash, relativePath, () =>
      this.emit({ type: 'deleted', path: relativePath })
    );
  }

  /** نگه داشتن یک رویداد تا پایان پنجره، و بعد بیرون دادنش. */
  private hold(
    table: Map<string, PendingEvent[]>,
    hash: string,
    relativePath: string,
    release: () => void
  ): void {
    const entry: PendingEvent = {
      relativePath,
      timer: setTimeout(() => {
        const queue = table.get(hash);
        if (queue) {
          const index = queue.indexOf(entry);
          if (index !== -1) queue.splice(index, 1);
          if (queue.length === 0) table.delete(hash);
        }
        release();
      }, this.renameWindowMs),
    };

    // تایمر نباید پروسه را زنده نگه دارد.
    entry.timer.unref?.();

    const queue = table.get(hash);
    if (queue) queue.push(entry);
    else table.set(hash, [entry]);
  }

  /** oldest pending event for this hash (FIFO), removed from the queue; its timer is cancelled. */
  private take(table: Map<string, PendingEvent[]>, hash: string): PendingEvent | undefined {
    const queue = table.get(hash);
    const entry = queue?.shift();
    if (queue && queue.length === 0) table.delete(hash);
    if (entry) clearTimeout(entry.timer);
    return entry;
  }

  private hashOf(absolute: string): string | undefined {
    try {
      return sha256(fs.readFileSync(absolute));
    } catch {
      return undefined;
    }
  }
}
