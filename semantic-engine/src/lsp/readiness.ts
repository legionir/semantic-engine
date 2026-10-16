/**
 * تشخیص آمادگی — LSP-06.
 *
 * `initialize` که برگشت، به معنی آماده بودن **نیست**. `gopls` و
 * `rust-analyzer` پس از آن دقایقی ایندکس می‌کنند و در آن پنجره
 * پاسخ‌های خالی یا کند می‌دهند. پاسخ خالیِ یک سرورِ در حال گرم شدن،
 * از نبودِ سرور بدتر است: ایندکس پر می‌شود از فایل‌های «بدون
 * symbol».
 *
 * سه لایه، به‌ترتیب اعتبار:
 *
 * ۱. **`$/progress`** — استاندارد. از `kind: "begin"` تا
 *    `kind: "end"`. در اندازه‌گیری فاز ۳۲، `tsgo` هیچ progressای
 *    نفرستاد چون فوراً آماده بود؛ پس این لایه به‌تنهایی کافی نیست.
 * ۲. **افزونهٔ مخصوص سرور** — `rust-analyzer` رویداد
 *    `experimental/serverStatus` دارد و `quiescent: true` یعنی
 *    ایندکس تمام شد.
 * ۳. **کاوش فعال** — یک `documentSymbol` روی فایلی که می‌دانیم
 *    symbol دارد، با backoff، تا نتیجهٔ ناخالی بیاید یا سررسید
 *    برسد.
 *
 * اگر سررسید برسد → `degraded`. **هرگز کل ایندکس‌سازی برای یک سرور
 * کند بلوکه نمی‌شود.**
 */

import { LspClient } from './LspClient';
import { ILogger, silentLogger } from '../host/Logger';

export type ReadinessVerdict = 'ready' | 'degraded';

export interface ReadinessProbe {
  readonly filePath: string;
  readonly languageId: string;
  readonly text?: string;
}

export interface ReadinessOptions {
  readonly logger?: ILogger;
  /** فاصلهٔ اولین تلاش‌ها؛ دوبرابر می‌شود تا سقف. */
  readonly pollIntervalMs?: number;
  readonly maxPollIntervalMs?: number;
}

const DEFAULT_POLL_MS = 100;
const DEFAULT_MAX_POLL_MS = 2_000;

interface ProgressValue {
  readonly kind?: 'begin' | 'report' | 'end';
  readonly title?: string;
}

interface ProgressParams {
  readonly token?: string | number;
  readonly value?: ProgressValue;
}

/**
 * وضعیت گرم شدن یک سرور.
 *
 * به‌ازای هر کلاینت یکی؛ `attach` بیش از یک بار روی یک کلاینت
 * بی‌اثر است.
 */
export class ReadinessTracker {
  private readonly openTokens = new Map<LspClient, Set<string>>();
  private readonly quiescent = new WeakMap<LspClient, boolean>();
  private readonly attached = new WeakSet<LspClient>();
  private readonly logger: ILogger;

  constructor(private readonly options: ReadinessOptions = {}) {
    this.logger = (options.logger ?? silentLogger).child('lsp:readiness');
  }

  attach(client: LspClient): void {
    if (this.attached.has(client)) return;
    this.attached.add(client);

    client.onNotification('$/progress', raw => {
      const params = raw as ProgressParams;
      const token = String(params?.token ?? '');
      if (!token || !params?.value?.kind) return;

      let tokens = this.openTokens.get(client);
      if (!tokens) {
        tokens = new Set();
        this.openTokens.set(client, tokens);
      }
      if (params.value.kind === 'begin') tokens.add(token);
      if (params.value.kind === 'end') tokens.delete(token);
    });

    /*
    | افزونهٔ rust-analyzer. سرورهای دیگر آن را نمی‌فرستند، پس
    | نبودش هیچ معنایی ندارد — فقط بودنش معنی دارد.
    */
    client.onNotification('experimental/serverStatus', raw => {
      const status = raw as { quiescent?: boolean };
      if (typeof status?.quiescent === 'boolean') {
        this.quiescent.set(client, status.quiescent);
      }
    });
  }

  /** آیا سرور همین حالا مشغول کاری است که اعلامش کرده؟ */
  isBusy(client: LspClient): boolean {
    const tokens = this.openTokens.get(client);
    if (tokens && tokens.size > 0) return true;
    const quiescent = this.quiescent.get(client);
    return quiescent === false;
  }

  forget(client: LspClient): void {
    this.openTokens.delete(client);
  }

  /**
   * صبر تا آمادگی، یا اعلام `degraded`.
   *
   * بدون `probe`، فقط دو لایهٔ اول سنجیده می‌شوند — که برای سروری
   * که هیچ progressای نمی‌فرستد یعنی «فوراً آماده».
   */
  async waitUntilReady(
    client: LspClient,
    timeoutMs: number,
    probe?: ReadinessProbe
  ): Promise<ReadinessVerdict> {
    const deadline = Date.now() + timeoutMs;
    let interval = this.options.pollIntervalMs ?? DEFAULT_POLL_MS;
    const maxInterval = this.options.maxPollIntervalMs ?? DEFAULT_MAX_POLL_MS;
    let attempts = 0;

    for (;;) {
      if (!client.isRunning) return 'degraded';

      if (!this.isBusy(client)) {
        if (!probe) return 'ready';

        attempts++;
        const answered = await this.probeOnce(client, probe);
        if (answered) {
          this.logger.debug('server is ready', { attempts });
          return 'ready';
        }
      }

      if (Date.now() >= deadline) {
        this.logger.warn('language server did not become ready in time', {
          timeoutMs,
          attempts,
          busy: this.isBusy(client),
        });
        return 'degraded';
      }

      await sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
      interval = Math.min(interval * 2, maxInterval);
    }
  }

  /**
   * یک تلاش برای گرفتن symbol.
   *
   * خطا هم «هنوز آماده نیست» حساب می‌شود، نه شکست: سرور در حال گرم
   * شدن ممکن است `ContentModified` یا `ServerNotInitialized`
   * برگرداند.
   */
  private async probeOnce(client: LspClient, probe: ReadinessProbe): Promise<boolean> {
    try {
      const symbols = await client.withDocument(
        probe.filePath,
        probe.languageId,
        () => client.documentSymbol(probe.filePath, { timeoutMs: 5_000 }),
        probe.text
      );
      return Array.isArray(symbols) && symbols.length > 0;
    } catch (error) {
      this.logger.debug('readiness probe failed; still warming', { error: String(error) });
      return false;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}
