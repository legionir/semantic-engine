/**
 * WatchPipeline — حلقهٔ watch، بدون ویرایشگر — MIG-23.
 *
 * ── چه چیزی جای چه چیزی را می‌گیرد ────────────────────────────────
 *
 * `processIncrementalBatch` در `extension.ts` بود و با آن فایل در فاز
 * ۱۳ حذف شد. از آن زمان تا امروز مسیر watch **اصلاً وجود نداشت**:
 * `IncrementalEngine` بود، `FileChangeQueue` بود، `OutputWriter` بود،
 * ولی هیچ‌چیز آن سه را به هم وصل نمی‌کرد.
 *
 * این کلاس همان اتصال است — ولی نه همان رفتار. نسخهٔ قبلی در هر batch:
 *
 *   | کار | مشکل |
 *   |---|---|
 *   | `writeFile` ایندکس، بعد بردارسازی، بعد `writeFile` دوباره | SE-EXP-02 |
 *   | `VectorIndexer.index` روی کل ایندکس | SE-INC-02 |
 *   | `gitCollector.collect(همهٔ مسیرها)` | یک پروسهٔ git به ازای هر فایل |
 *   | تایمر ۳۰ ثانیه‌ای بازتولید متادیتای کل پروژه | SE-INC-04 |
 *
 * همهٔ این‌ها در فازهای ۲۰ و ۲۴ تا ۲۶ رفع شدند. وظیفهٔ این‌جا آن است
 * که آن‌ها را برنگرداند: هر batch **یک بار** از طریق `OutputWriter`
 * می‌نویسد، و غنی‌سازی و بردار جای خودشان — داخل موتور — می‌مانند.
 *
 * ── ترتیب و خاموشی ────────────────────────────────────────────────
 *
 * `IncrementalEngine.applyChanges` از فاز ۲۶ خودش زنجیرهٔ ترتیبی دارد،
 * پس دو batch روی store هم‌پوشانی نمی‌کنند. ولی *نوشتن* بیرون از موتور
 * است و باید در همان زنجیره بماند، وگرنه دو batch می‌توانند روی یک
 * فایل خروجی مسابقه بدهند. پس این کلاس زنجیرهٔ خودش را دارد که کل
 * «اعمال + نوشتن» را در بر می‌گیرد.
 *
 * `dispose` صف را **تخلیه می‌کند**، نه اینکه فقط تایمرش را بکشد: یک
 * ویرایش که کاربر انجام داده و هنوز debounce نشده، نباید با بستن
 * برنامه دور ریخته شود.
 */

import { FileChangeEvent } from '../core/types/common.types';
import { FileChangeQueue } from '../incremental/FileChangeQueue';
import { IncrementalEngine, IncrementalUpdateResult } from '../incremental/IncrementalEngine';
import { OutputWriter, WrittenArtifacts } from './OutputWriter';
import { FileSystemPort } from '../host/FileSystem';
import { FileWatcher } from '../host/FileWatcher';
import { ScannerConfig } from '../core/config/ScannerConfig';
import { ILogger, silentLogger } from '../host/Logger';

export interface WatchPipelineOptions {
  readonly workspaceRoot: string;
  readonly outputDir: string;
  /** موتوری که از قبل `load()` شده است. */
  readonly engine: IncrementalEngine;
  readonly debounceMs?: number;
  /**
   * سقف انتظار صف — SE-INC-08. بدون آن، یک `git checkout` که پیوسته
   * رویداد می‌فرستد، batch را برای همیشه گرسنه می‌گذارد.
   */
  readonly maxWaitMs?: number;
  readonly blueprint?: boolean;
  /** بازسازی blueprint در هر batch یا فقط پس از عبور از drift threshold. */
  readonly blueprintMode?: 'always' | 'threshold';
  readonly pretty?: boolean;
  readonly validate?: boolean;
  readonly fileSystem?: FileSystemPort;
  readonly logger?: ILogger;
  /** برای `watchFilesystem` — همان پیکربندی‌ای که اسکنر می‌گیرد. */
  readonly scannerConfig?: Partial<ScannerConfig>;
  readonly renameWindowMs?: number;
}

export interface WatchStats {
  /** چند batch تا حالا کامل شده است. */
  readonly batches: number;
  /** چند رویداد در مجموع پردازش شده است. */
  readonly events: number;
  /** چند batch با خطا تمام شد. */
  readonly failures: number;
}

type BatchListener = (events: readonly FileChangeEvent[]) => void;
type ResultListener = (result: IncrementalUpdateResult, written: WrittenArtifacts) => void;
type ErrorListener = (error: Error, events: readonly FileChangeEvent[]) => void;

export class WatchPipeline {
  private readonly queue: FileChangeQueue;
  private readonly logger: ILogger;
  private readonly enqueue: (events: FileChangeEvent[]) => void;

  /** زنجیرهٔ «اعمال + نوشتن» — نوشتن هم باید ترتیبی بماند. */
  private chain: Promise<void> = Promise.resolve();
  private disposed = false;
  private watcher: FileWatcher | null = null;

  private batches = 0;
  private events = 0;
  private failures = 0;

  private readonly onStart: BatchListener[] = [];
  private readonly onEnd: BatchListener[] = [];
  private readonly onDone: ResultListener[] = [];
  private readonly onFail: ErrorListener[] = [];

  constructor(private readonly options: WatchPipelineOptions) {
    this.logger = options.logger ?? silentLogger;
    this.queue = new FileChangeQueue({
      debounceMs: options.debounceMs ?? 500,
      /*
      | پیش‌فرض ۵ ثانیه: به‌قدری بلند که یک تایپ معمولی را نبرد، و
      | به‌قدری کوتاه که یک checkout بزرگ بیش از این معطل نکند.
      */
      maxWaitMs: options.maxWaitMs ?? 5_000,
    });

    this.enqueue = batch => this.schedule(batch);
  }

  /**
   * وصل کردن یک watcher واقعی به این حلقه — فاز ۲۸.
   *
   * `previousHash` به store موتور وصل می‌شود: فایلِ حذف‌شده دیگر روی
   * دیسک نیست، پس تنها منبع hashش همان ایندکسی است که در حافظه
   * داریم. بدون این، هر rename به delete+create تنزل می‌کند.
   *
   * پوشهٔ خروجی هم به watcher داده می‌شود، وگرنه هر نوشتنِ خودمان
   * یک رویداد تازه می‌سازد و حلقه بی‌پایان می‌شود.
   */
  async watchFilesystem(): Promise<FileWatcher> {
    const watcher = new FileWatcher({
      workspaceRoot: this.options.workspaceRoot,
      outputDir: this.options.outputDir,
      ...(this.options.scannerConfig ? { scannerConfig: this.options.scannerConfig } : {}),
      ...(this.options.renameWindowMs !== undefined
        ? { renameWindowMs: this.options.renameWindowMs }
        : {}),
      logger: this.logger,
      previousHash: relativePath =>
        this.options.engine.getStore()?.getFileByPath(relativePath)?.hash,
      onEvent: event => this.notify(event),
    });

    await watcher.start();
    this.watcher = watcher;
    return watcher;
  }

  /** یک رویداد فایل‌سیستم. پس از `dispose` بی‌اثر است. */
  notify(event: FileChangeEvent): void {
    if (this.disposed) return;
    this.queue.enqueue(event, this.enqueue);
  }

  onBatchStart(listener: BatchListener): void {
    this.onStart.push(listener);
  }

  onBatchEnd(listener: BatchListener): void {
    this.onEnd.push(listener);
  }

  onBatchComplete(listener: ResultListener): void {
    this.onDone.push(listener);
  }

  onError(listener: ErrorListener): void {
    this.onFail.push(listener);
  }

  stats(): WatchStats {
    return { batches: this.batches, events: this.events, failures: this.failures };
  }

  /**
   * تخلیهٔ هرچه در صف است و انتظار تا پایان کار در جریان.
   *
   * پس از این، `notify` بی‌اثر است. فراخوانی دوباره بی‌خطر است.
   */
  async dispose(): Promise<void> {
    if (this.disposed) {
      await this.chain;
      return;
    }
    this.disposed = true;

    /*
    | watcher اول بسته می‌شود، وگرنه رویدادهای تازه وسط تخلیه
    | می‌آیند و صف دوباره پر می‌شود.
    */
    const watcher = this.watcher;
    this.watcher = null;
    if (watcher) await watcher.close();

    /*
    | صف را دستی تخلیه می‌کنیم چون تایمرش ممکن است هنوز نرسیده باشد.
    | `drain` رویدادها را ادغام‌شده برمی‌گرداند، پس همان batchی است
    | که تایمر هم می‌ساخت.
    */
    const pending = this.queue.drain();
    this.queue.dispose();

    if (pending.length > 0) {
      this.schedule(pending);
    }

    await this.chain;
  }

  /** افزودن یک batch به انتهای زنجیره. */
  private schedule(events: FileChangeEvent[]): void {
    this.chain = this.chain.then(() => this.runBatch(events));
  }

  private async runBatch(events: FileChangeEvent[]): Promise<void> {
    for (const listener of this.onStart) listener(events);

    try {
      this.logger.debug('watch batch', {
        events: events.map(event => `${event.type}:${event.path}`),
      });

      const result = await this.options.engine.applyChanges(events);

      /*
      | یک بار، از طریق `OutputWriter` — که خودش اتمیک می‌نویسد و
      | blueprint را فقط وقتی drift از آستانه رد شده باشد می‌سازد.
      */
      const writer = new OutputWriter({
        outputDir: this.options.outputDir,
        ...(this.options.fileSystem ? { fileSystem: this.options.fileSystem } : {}),
        logger: this.logger,
        ...(this.options.pretty !== undefined ? { pretty: this.options.pretty } : {}),
        ...(this.options.validate !== undefined ? { validate: this.options.validate } : {}),
        blueprint:
          (this.options.blueprint ?? true) &&
          ((this.options.blueprintMode ?? 'threshold') === 'always' ||
            result.shouldRebuildBlueprint),
        driftScore: result.driftScore,
        ...(result.projectIndex.git?.commit
          ? { gitCommit: result.projectIndex.git.commit }
          : {}),
      });

      const written = await writer.write(result.projectIndex);

      this.batches++;
      this.events += events.length;
      for (const listener of this.onDone) listener(result, written);
    } catch (error) {
      /*
      | یک batch شکست‌خورده نباید حلقه را بکشد. ویرایش بعدی کاربر باید
      | همچنان کار کند — و اگر خطا ماندگار باشد، هر batch گزارشش
      | می‌دهد.
      */
      this.failures++;
      const failure = error instanceof Error ? error : new Error(String(error));
      this.logger.warn('watch batch failed', { cause: failure.message });
      for (const listener of this.onFail) listener(failure, events);
    } finally {
      for (const listener of this.onEnd) listener(events);
    }
  }
}
