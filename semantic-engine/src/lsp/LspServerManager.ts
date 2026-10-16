/**
 * LspServerManager — چرخهٔ عمر سرورها — LSP-05.
 *
 * تا فاز ۳۵، هر مصرف‌کننده‌ای که زبان‌سرور می‌خواست خودش یک
 * `LspClient` می‌ساخت و خودش خاموشش می‌کرد. برای یک آزمون کافی بود؛
 * برای یک اجرای واقعی نه: دو مصرف‌کننده (استخراج symbol و
 * diagnostics) دو سرور بالا می‌آوردند، هیچ‌کس سرور بیکار را
 * نمی‌بست، و کرش سرور یعنی همان خطا به‌ازای هر فایل تکرار می‌شد.
 *
 * ── قواعد، همان‌ها که سند طراحی گفته بود ─────────────────────────
 *
 * | رویداد | رفتار |
 * |---|---|
 * | اولین فایل یک زبان | spawn تنبل |
 * | ۱۰ دقیقه بی‌استفاده | خاموشی خودکار (حداقل عمر ۳۰ ثانیه) |
 * | کرش سرور | تا ۳ بار restart با backoff، بعد `degraded` |
 * | RSS از سقف رد شد | restart اجباری + هشدار |
 * | خاموشی برنامه | `shutdown` → `exit` → مهلت → `SIGKILL` |
 *
 * ── تصمیم: restart تنبل، نه پس‌زمینه ────────────────────────────
 *
 * طرح اولیه `handleCrash` را با یک تایمر backoff تصویر کرده بود.
 * اینجا restart در **`acquire` بعدی** انجام می‌شود و نه در
 * پس‌زمینه. دو دلیل:
 *
 * ۱. سروری که کرش کرده و دیگر کسی سراغش نمی‌آید، نباید سه بار
 *    بالا بیاید تا دوباره بمیرد. کار بی‌مصرف روی ماشین کاربر.
 * ۲. تایمر پس‌زمینه یعنی حالت مشترک بین دو مسیر اجرا، و اثباتِ
 *    برگرداندنِ فاز ۳۰ نشان داد چنین چیزی چقدر راحت کل سوئیت را
 *    معلق می‌کند.
 *
 * تنزل هم صریح است: بعد از سومین شکست، `acquire` برای آن زبان
 * `null` می‌دهد و زنجیرهٔ استخراج با tree-sitter ادامه می‌دهد.
 */

import * as path from 'path';
import { IDisposable } from '../core/types/common.types';
import { ILogger, silentLogger } from '../host/Logger';
import { LspClient, LspExitInfo } from './LspClient';
import { LspServerRegistry, LspServerSpec, ResolvedLspServer, describeMissingServers } from './registry';
import { ReadinessProbe, ReadinessTracker, ReadinessVerdict } from './readiness';
import { residentMemoryMb } from './processMemory';

export interface LspServerManagerOptions {
  readonly workspaceRoot: string;
  readonly registry?: LspServerRegistry;
  readonly logger?: ILogger;
  /** چقدر بی‌استفاده بماند تا خاموش شود. پیش‌فرض ۱۰ دقیقه. */
  readonly idleTimeoutMs?: number;
  /** جوان‌تر از این هرگز reap نمی‌شود — تا وسط یک عملیات کشته نشود. */
  readonly minLifetimeMs?: number;
  /** چند بار restart پیش از تنزل. پیش‌فرض ۳. */
  readonly maxRestarts?: number;
  /**
   * پنجرهٔ شمارش شکست. پیش‌فرض ۵ دقیقه.
   *
   * شکست‌ها در یک پنجرهٔ لغزان شمرده می‌شوند، نه از ابتدای جلسه:
   * سروری که صبح یک بار مرده و از آن موقع سالم است، نباید بعدازظهر
   * با دومین مرگ تسلیم اعلام شود.
   */
  readonly failureWindowMs?: number;
  /** پایهٔ backoff نمایی. پیش‌فرض ۱ ثانیه. */
  readonly restartBackoffMs?: number;
  /** سقف حافظه به مگابایت. پیش‌فرض ۲۰۴۸. صفر یعنی بدون سقف. */
  readonly memoryLimitMb?: number;
  /** فاصلهٔ نگهداری خودکار (reap + سنجش حافظه). صفر یعنی دستی. */
  readonly maintenanceIntervalMs?: number;
  readonly requestTimeoutMs?: number;
  /** مهلت آمادگی سرورهای بدون warmup. */
  readonly readyTimeoutMs?: number;
  /** مهلت آمادگی سرورهایی که `needsWarmup` دارند. */
  readonly warmupTimeoutMs?: number;
  /** فایل نمونه برای کاوش فعال آمادگی. */
  readonly readinessProbe?: (languageId: string) => ReadinessProbe | null;
  readonly readiness?: ReadinessTracker;

  // ── درزهای تست ────────────────────────────────────────────────────
  readonly createClient?: (spec: LspServerSpec, resolved: ResolvedLspServer) => LspClient;
  readonly now?: () => number;
  readonly rss?: (pid: number | undefined) => number | null;
}

export type ManagedState = 'idle' | 'starting' | 'running' | 'crashed' | 'degraded' | 'stopped';

export interface ManagedServerStatus {
  readonly id: string;
  readonly languages: readonly string[];
  readonly state: ManagedState;
  readonly pid?: number;
  readonly startedAt?: number;
  readonly lastUsedAt?: number;
  readonly failures: number;
  readonly memoryMb?: number | null;
  readonly readiness?: ReadinessVerdict;
}

interface Entry {
  readonly spec: LspServerSpec;
  readonly resolved: ResolvedLspServer;
  client?: LspClient;
  state: ManagedState;
  startedAt?: number;
  lastUsedAt: number;
  /** زمان هر شکست، برای شمارش در پنجرهٔ لغزان. */
  failureTimes: number[];
  nextAttemptAt: number;
  readiness?: ReadinessVerdict;
  starting?: Promise<LspClient | null>;
}

const DEFAULT_IDLE_TIMEOUT_MS = 600_000;
const DEFAULT_MIN_LIFETIME_MS = 30_000;
const DEFAULT_MAX_RESTARTS = 3;
const DEFAULT_FAILURE_WINDOW_MS = 300_000;
const DEFAULT_BACKOFF_MS = 1_000;
const DEFAULT_MEMORY_LIMIT_MB = 2048;
const DEFAULT_MAINTENANCE_MS = 60_000;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_WARMUP_TIMEOUT_MS = 120_000;

export class LspServerManager implements IDisposable {
  private readonly logger: ILogger;
  private readonly registry: LspServerRegistry;
  private readonly readiness: ReadinessTracker;
  private readonly entries = new Map<string, Entry>();
  /** زبان‌هایی که تسلیمشان شده‌ایم — تا پایان جلسه. */
  private readonly degradedLanguages = new Set<string>();
  private readonly now: () => number;
  private maintenance?: NodeJS.Timeout;
  private disposed = false;

  constructor(private readonly options: LspServerManagerOptions) {
    this.logger = (options.logger ?? silentLogger).child('lsp:manager');
    this.registry = options.registry ?? new LspServerRegistry();
    this.readiness = options.readiness ?? new ReadinessTracker({ logger: options.logger });
    this.now = options.now ?? (() => Date.now());

    const interval = options.maintenanceIntervalMs ?? DEFAULT_MAINTENANCE_MS;
    if (interval > 0) {
      this.maintenance = setInterval(() => {
        void this.runMaintenance();
      }, interval);
      if (typeof this.maintenance.unref === 'function') this.maintenance.unref();
    }
  }

  /**
   * سرور آمادهٔ این زبان، یا `null`.
   *
   * `null` سه معنی دارد و هر سه یکی‌اند برای فراخوان: سروری نصب
   * نیست، سرور مرده و از سهمیهٔ restart گذشته، یا هنوز در پنجرهٔ
   * backoff است. در هر سه حالت، مصرف‌کننده باید با tree-sitter
   * ادامه بدهد.
   */
  async acquire(languageId: string): Promise<LspClient | null> {
    if (this.disposed) return null;
    const normalized = languageId.toLowerCase();
    if (this.degradedLanguages.has(normalized)) return null;

    const existing = this.entryForLanguage(normalized);
    if (existing) {
      if (existing.starting) return existing.starting;
      if (existing.client?.isRunning) {
        existing.lastUsedAt = this.now();
        return existing.client;
      }
      if (this.now() < existing.nextAttemptAt) return null;
    }

    const resolved = this.registry.resolveForLanguage(normalized, this.options.workspaceRoot);
    if (!resolved) {
      /*
      | نبودِ سرور یک بار گزارش می‌شود و بعد ساکت می‌ماند: پیام
      | نصب به‌ازای هر فایل، لاگ را بی‌مصرف می‌کند.
      */
      if (!this.degradedLanguages.has(normalized)) {
        this.degradedLanguages.add(normalized);
        this.logger.info(describeMissingServers(this.registry, normalized));
      }
      return null;
    }

    const spec = this.registry.all().find(candidate => candidate.id === resolved.id)!;
    const entry: Entry = existing ?? {
      spec,
      resolved,
      state: 'idle',
      lastUsedAt: this.now(),
      failureTimes: [],
      nextAttemptAt: 0,
    };
    this.entries.set(spec.id, entry);

    const starting = this.start(entry, normalized);
    entry.starting = starting;
    try {
      return await starting;
    } finally {
      entry.starting = undefined;
    }
  }

  status(): ManagedServerStatus[] {
    const rss = this.options.rss ?? residentMemoryMb;
    return Array.from(this.entries.values()).map(entry => ({
      id: entry.spec.id,
      languages: entry.spec.languages,
      state: entry.state,
      pid: entry.client?.processId,
      startedAt: entry.startedAt,
      lastUsedAt: entry.lastUsedAt,
      failures: this.recentFailures(entry),
      memoryMb: entry.client?.isRunning ? rss(entry.client.processId) : null,
      readiness: entry.readiness,
    }));
  }

  /** سرورهایی که مدتی است کسی سراغشان نرفته. */
  async reapIdle(): Promise<string[]> {
    const idleTimeout = this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const minLifetime = this.options.minLifetimeMs ?? DEFAULT_MIN_LIFETIME_MS;
    const now = this.now();
    const reaped: string[] = [];

    for (const entry of this.entries.values()) {
      if (!entry.client?.isRunning || entry.starting) continue;
      if (now - entry.lastUsedAt < idleTimeout) continue;
      /*
      | «حداقل عمر» تا سروری که همین حالا بالا آمده و هنوز کسی
      | ازش استفاده نکرده، وسط اولین عملیات کشته نشود.
      */
      if (entry.startedAt !== undefined && now - entry.startedAt < minLifetime) continue;

      this.logger.debug('reaping idle language server', {
        server: entry.spec.id,
        idleMs: now - entry.lastUsedAt,
      });
      await entry.client.stop();
      entry.state = 'stopped';
      entry.readiness = undefined;
      reaped.push(entry.spec.id);
    }
    return reaped;
  }

  /**
   * سروری که از سقف حافظه رد شده، restart می‌شود.
   *
   * این یک شکست نیست: شمارندهٔ کرش دست نمی‌خورد، چون سرور کاری
   * نکرده جز اینکه پروژه بزرگ بوده.
   */
  async enforceMemoryLimit(): Promise<string[]> {
    const limit = this.options.memoryLimitMb ?? DEFAULT_MEMORY_LIMIT_MB;
    if (limit <= 0) return [];
    const rss = this.options.rss ?? residentMemoryMb;
    const restarted: string[] = [];

    for (const entry of this.entries.values()) {
      if (!entry.client?.isRunning || entry.starting) continue;
      const memory = rss(entry.client.processId);
      if (memory === null || memory <= limit) continue;

      this.logger.warn('language server exceeded its memory limit; restarting', {
        server: entry.spec.id,
        memoryMb: Math.round(memory),
        limitMb: limit,
      });
      await entry.client.stop();
      entry.state = 'stopped';
      entry.readiness = undefined;
      restarted.push(entry.spec.id);
    }
    return restarted;
  }

  async runMaintenance(): Promise<void> {
    try {
      await this.reapIdle();
      await this.enforceMemoryLimit();
    } catch (error) {
      this.logger.debug('maintenance failed', { error: String(error) });
    }
  }

  /** آیا این زبان تا پایان جلسه تسلیم‌شده اعلام شده؟ */
  isDegraded(languageId: string): boolean {
    return this.degradedLanguages.has(languageId.toLowerCase());
  }

  async disposeAll(): Promise<void> {
    this.disposed = true;
    if (this.maintenance) clearInterval(this.maintenance);
    this.maintenance = undefined;

    for (const entry of this.entries.values()) {
      if (entry.client) await entry.client.stop();
      entry.state = 'stopped';
    }
    this.entries.clear();
  }

  async dispose(): Promise<void> {
    await this.disposeAll();
  }

  // ── درون ────────────────────────────────────────────────────────────

  private entryForLanguage(languageId: string): Entry | undefined {
    for (const entry of this.entries.values()) {
      if (entry.spec.languages.includes(languageId)) return entry;
    }
    return undefined;
  }

  private async start(entry: Entry, languageId: string): Promise<LspClient | null> {
    entry.state = 'starting';
    const client = this.createClient(entry.spec, entry.resolved);

    client.onExit(info => this.handleExit(entry, info));
    this.readiness.attach(client);

    try {
      await client.start();
    } catch (error) {
      this.noteFailure(entry, languageId, error instanceof Error ? error.message : String(error));
      return null;
    }

    entry.client = client;
    entry.startedAt = this.now();
    entry.lastUsedAt = this.now();
    entry.state = 'running';

    const verdict = await this.waitForReadiness(entry, languageId, client);
    entry.readiness = verdict;

    if (verdict === 'degraded') {
      /*
      | سرورِ گرم‌نشده کشته نمی‌شود — ممکن است چند ثانیهٔ بعد آماده
      | شود و درخواست بعدی جواب بگیرد. فقط این‌بار `null` می‌دهیم
      | تا این فایل با tree-sitter برود.
      */
      this.logger.warn('language server is not ready yet; continuing without it', {
        server: entry.spec.id,
      });
      return null;
    }

    /*
    | شمارندهٔ شکست اینجا صفر **نمی‌شود**. نسخهٔ اول همین کار را
    | می‌کرد و نتیجه‌اش این بود که سقف restart هرگز به دست
    | نمی‌آمد: هر بالا آمدنِ موفق شمارنده را پاک می‌کرد، پس سروری
    | که هر بار بالا می‌آید و دو ثانیه بعد می‌میرد، تا ابد دوباره
    | بالا می‌آمد. شکست‌ها با گذشت زمان از پنجره بیرون می‌روند، نه
    | با یک start موفق (SE-LSP-14).
    */
    return client;
  }

  private async waitForReadiness(
    entry: Entry,
    languageId: string,
    client: LspClient
  ): Promise<ReadinessVerdict> {
    const timeout = entry.spec.needsWarmup
      ? this.options.warmupTimeoutMs ?? DEFAULT_WARMUP_TIMEOUT_MS
      : this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

    const probe = this.options.readinessProbe?.(languageId) ?? undefined;
    return this.readiness.waitUntilReady(client, timeout, probe ?? undefined);
  }

  private createClient(spec: LspServerSpec, resolved: ResolvedLspServer): LspClient {
    if (this.options.createClient) return this.options.createClient(spec, resolved);
    return new LspClient({
      id: spec.id,
      command: resolved.command,
      args: resolved.args,
      rootPath: this.options.workspaceRoot,
      logger: this.options.logger,
      requestTimeoutMs: this.options.requestTimeoutMs,
      initializationOptions: spec.initializationOptions,
      initializeTimeoutMs: spec.needsWarmup
        ? this.options.warmupTimeoutMs ?? DEFAULT_WARMUP_TIMEOUT_MS
        : undefined,
    });
  }

  private handleExit(entry: Entry, info: LspExitInfo): void {
    if (info.expected) {
      entry.state = 'stopped';
      return;
    }
    const language = entry.spec.languages[0] ?? 'unknown';
    this.noteFailure(
      entry,
      language,
      `server exited unexpectedly (code ${info.code}, signal ${info.signal})`
    );
  }

  /** شکست‌های داخل پنجرهٔ لغزان. */
  private recentFailures(entry: Entry): number {
    const window = this.options.failureWindowMs ?? DEFAULT_FAILURE_WINDOW_MS;
    const now = this.now();
    entry.failureTimes = entry.failureTimes.filter(at => now - at < window);
    return entry.failureTimes.length;
  }

  private noteFailure(entry: Entry, languageId: string, reason: string): void {
    this.recentFailures(entry);
    entry.failureTimes.push(this.now());
    const failures = entry.failureTimes.length;
    entry.client = undefined;
    entry.readiness = undefined;

    const maxRestarts = this.options.maxRestarts ?? DEFAULT_MAX_RESTARTS;
    if (failures >= maxRestarts) {
      entry.state = 'degraded';
      for (const language of entry.spec.languages) this.degradedLanguages.add(language);
      this.logger.warn('giving up on this language server for the rest of the session', {
        server: entry.spec.id,
        failures,
        reason,
      });
      return;
    }

    /*
    | backoff نمایی: ۱ ثانیه، ۲ ثانیه، ۴ ثانیه. تلاش دوباره در
    | `acquire` بعدی انجام می‌شود، نه با تایمر.
    */
    const base = this.options.restartBackoffMs ?? DEFAULT_BACKOFF_MS;
    entry.state = 'crashed';
    entry.nextAttemptAt = this.now() + base * Math.pow(2, failures - 1);
    this.logger.warn('language server failed; will retry', {
      server: entry.spec.id,
      failures,
      retryInMs: entry.nextAttemptAt - this.now(),
      reason,
    });
  }
}

/**
 * فایل نمونهٔ کاوش آمادگی، از روی خودِ workspace.
 *
 * ساختن یک فایل موقت ساده‌تر بود، ولی سروری مثل `tsgo` فایلی را که
 * جزو برنامه نیست تحلیل نمی‌کند و نتیجهٔ تهی می‌دهد — یعنی کاوش
 * همیشه «آماده نیست» می‌گفت.
 */
export function firstFileProbe(
  files: readonly { readonly path: string; readonly language?: string | null }[],
  workspaceRoot: string
): (languageId: string) => ReadinessProbe | null {
  return (languageId: string) => {
    const match = files.find(file => file.language === languageId);
    if (!match) return null;
    return {
      filePath: path.isAbsolute(match.path) ? match.path : path.join(workspaceRoot, match.path),
      languageId,
    };
  };
}
