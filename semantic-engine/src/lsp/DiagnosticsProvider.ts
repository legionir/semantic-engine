/**
 * DiagnosticsProvider — تحلیل واقعی نوع، بدون اجرای کامپایلر — LSP-14.
 *
 * `ProjectIndex.diagnostics` از روز اول در قرارداد بود و تا فاز ۲۲
 * همیشه `[]` می‌ماند (SE-DATA-04). فاز ۲۲ لوله‌کشی‌اش را ساخت —
 * هشدارهای اسکنر و استخراج حالا به آن می‌رسند — ولی چیزی که کاربر از
 * «diagnostics» انتظار دارد، خطای نوع است، و آن هنوز نبود.
 *
 * ── pull، نه push ──────────────────────────────────────────────────
 *
 * آموزش‌های رایج می‌گویند به `textDocument/publishDiagnostics` گوش
 * بدهید. اندازه‌گیری روی `tsgo` (فاز ۳۴، فایل با خطای عمدی):
 *
 * ```
 * push (publishDiagnostics) → فقط یک پیام، برای tsconfig.json، با ۰ مورد
 * pull (textDocument/diagnostic) → ۷ مورد
 * ```
 *
 * سرور مدل pull (استاندارد ۳٫۱۷) را ترجیح می‌دهد و برای فایل‌هایی که
 * خودمان باز کرده‌ایم اصلاً push نمی‌فرستد. کلاینتی که فقط push
 * پیاده کند، صفر می‌گیرد و نتیجه می‌گیرد «پشتیبانی نمی‌شود».
 *
 * پس pull مسیر اصلی است و push مکمل — برای سرورهای قدیمی‌تر که
 * `diagnosticProvider` را اعلام نمی‌کنند.
 *
 * ── سه چیز دیگر که probe نشان داد ──────────────────────────────────
 *
 * ۱. **pull پیش از `didOpen` هم جواب می‌دهد** — سرور از دیسک
 *    می‌خواند. ولی در حالت watch، متن در حافظه از دیسک جلوتر است، پس
 *    باز کردن سند با متنِ داده‌شده اجباری است وگرنه نتیجه یک نسخه
 *    عقب است.
 * ۲. **`resultId` نمی‌آید** — یعنی کش `unchanged` این سرور را ندارد.
 *    پیاده‌سازی هر دو حالت لازم است چون سرورهای دیگر دارند.
 * ۳. **`code` عدد است**، و schema رشته یا `null` می‌خواهد
 *    (`contracts/project-index.schema.json`). بدون تبدیل، خروجی از
 *    اعتبارسنجی فاز ۲۴ رد نمی‌شود.
 */

import { Diagnostic } from '../core/types/project-index.types';
import { ILogger, silentLogger } from '../host/Logger';
import { LspClient } from './LspClient';
import { DiagnosticLike, DiagnosticSeverity, PublishDiagnosticsParams } from './protocol';

/**
 * چیزی که pipeline لازم دارد.
 *
 * عمداً کوچک و بدون اشاره به LSP: `IndexPipeline` نباید به زیرسیستم
 * زبان‌سرور گره بخورد، و تست‌هایش باید بتوانند یک بدل ساده بدهند.
 */
export interface FileDiagnosticsSource {
  diagnosticsFor(
    filePath: string,
    languageId: string,
    content: string,
    fileId: string
  ): Promise<readonly Diagnostic[]>;
  dispose?(): Promise<void> | void;
}

export interface DiagnosticsProviderOptions {
  readonly acquire: (languageId: string) => Promise<LspClient | null>;
  readonly languages?: readonly string[];
  readonly logger?: ILogger;
  /** سررسید یک درخواست. */
  readonly timeoutMs?: number;
  /** سقف کل کار برای یک فایل — SE-LSP-10. */
  readonly fileBudgetMs?: number;
  /** چقدر منتظر push بمانیم وقتی pull نیست. */
  readonly pushWaitMs?: number;
  /** بیشترین diagnostic که برای یک فایل نگه داشته می‌شود. */
  readonly maxPerFile?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_PUSH_WAIT_MS = 1_000;
const DEFAULT_MAX_PER_FILE = 200;

const DEFAULT_LANGUAGES = [
  'typescript',
  'typescriptreact',
  'javascript',
  'javascriptreact',
] as const;

/** LSP 3.17: گزارش کامل، یا «چیزی عوض نشده». */
interface DocumentDiagnosticReport {
  readonly kind?: 'full' | 'unchanged';
  readonly resultId?: string;
  readonly items?: readonly DiagnosticLike[];
  readonly relatedDocuments?: Record<string, DocumentDiagnosticReport>;
}

export class DiagnosticsProvider implements FileDiagnosticsSource {
  private readonly logger: ILogger;
  private readonly languages: ReadonlySet<string>;
  private readonly pushed = new Map<string, readonly DiagnosticLike[]>();
  private readonly pushWaiters = new Map<string, (() => void)[]>();
  private readonly subscribed = new WeakSet<LspClient>();
  /** آخرین نتیجهٔ کامل، برای پاسخ `unchanged`. */
  private readonly lastFull = new Map<string, readonly DiagnosticLike[]>();
  private readonly resultIds = new Map<string, string>();

  constructor(private readonly options: DiagnosticsProviderOptions) {
    this.logger = (options.logger ?? silentLogger).child('lsp:diagnostics');
    this.languages = new Set(options.languages ?? DEFAULT_LANGUAGES);
  }

  async diagnosticsFor(
    filePath: string,
    languageId: string,
    content: string,
    fileId: string
  ): Promise<readonly Diagnostic[]> {
    if (!this.languages.has(languageId)) return [];

    const client = await this.acquire(languageId);
    if (!client) return [];

    try {
      const raw = await this.withDeadline(
        this.collect(client, filePath, languageId, content),
        () => client.closeDocument(filePath),
        filePath
      );
      return this.toSchema(raw, fileId, filePath);
    } catch (error) {
      /*
      | diagnostics یک قابلیت اضافه است. اگر سرور کند یا مرده باشد،
      | ایندکس باید بدون آن تمام شود — نه اینکه شکست بخورد.
      */
      this.logger.debug('could not collect diagnostics', {
        file: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  dispose(): void {
    this.pushed.clear();
    this.pushWaiters.clear();
    this.lastFull.clear();
    this.resultIds.clear();
  }

  // ── درون ────────────────────────────────────────────────────────────

  private async collect(
    client: LspClient,
    filePath: string,
    languageId: string,
    content: string
  ): Promise<readonly DiagnosticLike[]> {
    this.subscribe(client);
    const uri = client.uriFor(filePath);

    /*
    | باز کردن سند با **متنِ داده‌شده** لازم است: در حالت watch،
    | آنچه روی دیسک است یک ذخیره عقب‌تر است و diagnostic مربوط به
    | نسخهٔ قدیمی، بدتر از نبودنش است.
    */
    client.openDocument(filePath, languageId, content);
    try {
      if (this.supportsPull(client)) {
        return await this.pull(client, filePath, uri);
      }
      return await this.waitForPush(uri);
    } finally {
      client.closeDocument(filePath);
    }
  }

  private supportsPull(client: LspClient): boolean {
    const declared: unknown = client.capabilities?.diagnosticProvider;
    return declared !== undefined && declared !== null && declared !== false;
  }

  private async pull(
    client: LspClient,
    filePath: string,
    uri: string
  ): Promise<readonly DiagnosticLike[]> {
    const previousResultId = this.resultIds.get(uri);
    const report = await client.request<DocumentDiagnosticReport>(
      'textDocument/diagnostic',
      {
        textDocument: { uri },
        ...(previousResultId ? { previousResultId } : {}),
      },
      { timeoutMs: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS }
    );

    if (report?.resultId) this.resultIds.set(uri, report.resultId);
    else this.resultIds.delete(uri);

    if (report?.kind === 'unchanged') {
      /*
      | «عوض نشده» یعنی «همان قبلی». اگر قبلی را نداشته باشیم — مثلاً
      | چون فرایند تازه بالا آمده و resultId از جای دیگری آمده —
      | خالی برگرداندن یعنی خطاهای واقعی را پاک کرده‌ایم.
      */
      const previous = this.lastFull.get(uri);
      if (previous) return previous;
      this.logger.debug('server said unchanged but we have nothing cached', { file: filePath });
      this.resultIds.delete(uri);
      return [];
    }

    const items = report?.items ?? [];
    this.lastFull.set(uri, items);
    /*
    | `relatedDocuments` برای سرورهایی است که `interFileDependencies`
    | دارند: خطای فایل *دیگری* که این فایل شکسته است. الان کنار
    | گذاشته می‌شود چون هر فایل خودش هم پرسیده می‌شود و نتیجه‌اش
    | دوباره‌کاری است؛ فقط ثبت می‌شود که دیده شده.
    */
    if (report?.relatedDocuments) {
      this.logger.debug('ignoring relatedDocuments', {
        file: filePath,
        count: Object.keys(report.relatedDocuments).length,
      });
    }
    return items;
  }

  /**
   * مسیر مکمل: سرورهایی که فقط push دارند.
   *
   * صبر کوتاه و مشروط: اگر پیش از این چیزی برای این uri آمده باشد،
   * فوراً برمی‌گردد؛ وگرنه تا سررسید منتظر اولین پیام می‌ماند.
   */
  private async waitForPush(uri: string): Promise<readonly DiagnosticLike[]> {
    const known = this.pushed.get(uri);
    if (known) return known;

    const waitMs = this.options.pushWaitMs ?? DEFAULT_PUSH_WAIT_MS;
    await new Promise<void>(resolve => {
      const waiter = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        /*
        | P-05/SE-F-032 — نسخهٔ اول `removeWaiter(uri, resolve)` را صدا
        | می‌زد، ولی فهرست waiterها تابعِ `waiter` را نگه می‌دارد نه
        | `resolve` را؛ فیلتر `waiter !== resolve` هیچ‌وقت هیچ را حذف
        | نمی‌کرد. یعنی هر بار که یک شنونده روی یک uri سررسید
        | می‌شد، یک بستهٔ مرده در map می‌ماند (نشت بی‌حد روی uriهای
        | پرجمعیت) و یک پیامِ بعدیِ همان uri همهٔ آن‌ها را fire
        | می‌کرد. حالا دقیقاً خودِ همان waiter حذف می‌شود.
        */
        this.removeWaiter(uri, waiter);
        resolve();
      }, waitMs);
      if (typeof timer.unref === 'function') timer.unref();

      const list = this.pushWaiters.get(uri);
      if (list) list.push(waiter);
      else this.pushWaiters.set(uri, [waiter]);
    });

    return this.pushed.get(uri) ?? [];
  }

  private subscribe(client: LspClient): void {
    if (this.subscribed.has(client)) return;
    this.subscribed.add(client);
    client.onDiagnostics((params: PublishDiagnosticsParams) => {
      this.pushed.set(params.uri, params.diagnostics);
      const waiters = this.pushWaiters.get(params.uri);
      if (!waiters) return;
      this.pushWaiters.delete(params.uri);
      for (const waiter of waiters) waiter();
    });
  }

  private removeWaiter(uri: string, waiter: () => void): void {
    const list = this.pushWaiters.get(uri);
    if (!list) return;
    const remaining = list.filter(entry => entry !== waiter);
    if (remaining.length > 0) this.pushWaiters.set(uri, remaining);
    else this.pushWaiters.delete(uri);
  }

  private toSchema(
    items: readonly DiagnosticLike[],
    fileId: string,
    filePath: string
  ): readonly Diagnostic[] {
    const max = this.options.maxPerFile ?? DEFAULT_MAX_PER_FILE;
    const kept = items.slice(0, max);
    const mapped = kept.map(item => toSchemaDiagnostic(item, fileId));

    if (items.length > kept.length) {
      /*
      | یک فایل با هزار خطا معمولاً یعنی پیکربندی اشتباه است، نه
      | هزار مشکل واقعی. بریدنش لازم است، ولی بی‌صدا بریدن یعنی
      | مصرف‌کننده فکر می‌کند دقیقاً همین تعداد مشکل هست.
      */
      this.logger.debug('truncated diagnostics', { file: filePath, total: items.length, kept: max });
      mapped.push({
        severity: 'info',
        code: null,
        line: 1,
        column: null,
        message: `${items.length - kept.length} more diagnostic(s) were dropped (limit ${max})`,
        source: 'semantic-engine',
        fileId,
      });
    }
    return mapped;
  }

  private async acquire(languageId: string): Promise<LspClient | null> {
    try {
      const client = await this.options.acquire(languageId);
      return client && client.isRunning ? client : null;
    } catch (error) {
      this.logger.debug('could not acquire a language server', { error: String(error) });
      return null;
    }
  }

  private async withDeadline<T>(
    work: Promise<T>,
    onTimeout: () => void,
    filePath: string
  ): Promise<T> {
    const budget =
      this.options.fileBudgetMs ??
      Math.round((this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS) * 1.5);

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        try {
          onTimeout();
        } catch {
          // بستن سند بهترین تلاش است.
        }
        reject(new Error(`diagnostics for ${filePath} took longer than ${budget}ms`));
      }, budget);
      if (typeof timer.unref === 'function') timer.unref();
    });
    work.catch(() => undefined);

    try {
      return await Promise.race([work, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * LSP → schema.
 *
 * سه تفاوت که هر کدام‌شان یک خروجی نامعتبر می‌سازند:
 * شماره خط صفرمبنا در برابر یک‌مبنا، `code` عددی در برابر رشته‌ای، و
 * شدت عددی در برابر رشته‌ای.
 */
export function toSchemaDiagnostic(item: DiagnosticLike, fileId?: string | null): Diagnostic {
  return {
    severity: severityOf(item.severity),
    code: item.code === undefined || item.code === null ? null : String(item.code),
    line: item.range.start.line + 1,
    column: item.range.start.character + 1,
    message: item.message,
    source: item.source && item.source.length > 0 ? item.source : 'lsp',
    fileId: fileId ?? null,
  };
}

/**
 * شدت.
 *
 * پروتکل می‌گوید نبودِ `severity` یعنی «کلاینت تصمیم بگیرد». اینجا
 * `warning` انتخاب شده و نه `error`: بالا بردن شدتِ چیزی که سرور
 * دربارهٔ آن نظری نداده، به فهرست خطاها مورد جعلی اضافه می‌کند.
 */
export function severityOf(severity: number | undefined): Diagnostic['severity'] {
  switch (severity) {
    case DiagnosticSeverity.Error:
      return 'error';
    case DiagnosticSeverity.Warning:
      return 'warning';
    case DiagnosticSeverity.Information:
      return 'info';
    case DiagnosticSeverity.Hint:
      return 'hint';
    default:
      return 'warning';
  }
}
