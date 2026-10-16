/**
 * LspSymbolExtractor — استخراج symbol از زبان‌سرور — LSP-07.
 *
 * جانشین `LSPSymbolExtractor` قدیمی که فاز ۱۰ حذفش کرد. آن نسخه از
 * `vscode.commands` می‌خواست symbolها را بدهد؛ این نسخه خودش با
 * سرور حرف می‌زند (`LspClient`، فاز ۳۲).
 *
 * ── اولویت ۹۰ و نه ۱۰۰ ─────────────────────────────────────────────
 *
 * نسخهٔ قبلی ۱۰۰ بود، یعنی «هرجا هست، حرف آخر را می‌زند». اندازه‌گیری
 * فاز ۳۳ نشان داد این فرض غلط است. روی همان fixture:
 *
 * ```
 * زبان‌سرور بهتر است در : سلسله‌مراتب (پارامتر-پراپرتی سازنده،
 *                          اعضای namespace)، endLine واقعی
 * زبان‌سرور بدتر است در : kind — `type X = …` را Class می‌نامد و
 *                          `const` را variable؛ و `detail` هرگز
 *                          نمی‌فرستد، پس امضا و پارامتر از آن در
 *                          نمی‌آید
 * ```
 *
 * ۹۰ یعنی هنوز اول است ولی فاصله‌ای هست برای منبعی که واقعاً دقیق‌تر
 * باشد، و مهم‌تر: نتیجه‌اش با نتیجهٔ پایین‌دستی **ادغام** می‌شود
 * (SE-SYM-01) نه اینکه جایش را بگیرد.
 *
 * ── سه چیزی که این کلاس اصلاح می‌کند ────────────────────────────────
 *
 * ۱. **SE-LSP-02** — نام‌های import شده به‌عنوان `Variable` سطح‌بالا
 *    برمی‌گردند. حذف می‌شوند، وگرنه هر فایل به تعداد importهایش
 *    symbol جعلی می‌گیرد.
 * ۲. **SE-LSP-08** — `type X = …` با `kind = Class` می‌آید. از روی
 *    خطِ خودِ اعلان اصلاح می‌شود.
 * ۳. **SE-SYM-02** — هر درخواست سررسید دارد و کل استخراج یک فایل هم
 *    بودجهٔ زمانی دارد. سرور کند نباید اسکن را نگه دارد.
 */

import {
  ISymbolExtractor,
  SymbolExtractionResult,
} from '../ISymbolExtractor';
import { ExtractionSource, Result, ok } from '../../core/types/common.types';
import { SymbolEntry, SymbolKind } from '../../core/types/project-index.types';
import { DocumentSymbolLike } from '../types';
import { flattenDocumentSymbols } from './LSPMappers';
import { findImportLineSpans, isInsideSpans } from './importSpans';
import { LspClient } from '../../lsp/LspClient';
import { CapabilityProbe, isUsable } from '../../lsp/CapabilityProbe';
import { isHierarchical } from '../../lsp/protocol';
import { ILogger, silentLogger } from '../../host/Logger';

/** کلاینت را کی و چطور می‌گیریم. فاز ۳۶ اینجا `LspServerManager` می‌گذارد. */
export type LspClientProvider = (languageId: string) => Promise<LspClient | null>;

export interface LspSymbolExtractorOptions {
  readonly acquire: LspClientProvider;
  /** زبان‌هایی که این استخراج‌گر ادعا می‌کند. پیش‌فرض: خانوادهٔ TS/JS. */
  readonly languages?: readonly string[];
  readonly probe?: CapabilityProbe;
  readonly logger?: ILogger;
  /** سررسید یک درخواست `documentSymbol`. */
  readonly requestTimeoutMs?: number;
  /**
   * سقف کل کاری که برای *یک فایل* انجام می‌شود.
   *
   * جدا از سررسید درخواست، چون کارهای این مسیر فقط یک درخواست نیست:
   * کاوش قابلیت، باز کردن سند، و بستنش هم هست. اگر فقط لایهٔ انتقال
   * سررسید داشته باشد، هر مسیری که از آن رد نشود بی‌سقف است — و
   * SE-SYM-02 دربارهٔ همین بود.
   */
  readonly fileBudgetMs?: number;
  /** اگر داده نشود، اولین فایلی که دیده شود برای کاوش قابلیت به کار می‌رود. */
  readonly probeFile?: string;
}

const DEFAULT_LANGUAGES = [
  'typescript',
  'typescriptreact',
  'javascript',
  'javascriptreact',
] as const;

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export class LspSymbolExtractor implements ISymbolExtractor {
  readonly name: ExtractionSource = 'lsp';
  readonly priority = 90;

  private readonly languages: ReadonlySet<string>;
  private readonly probe: CapabilityProbe;
  private readonly logger: ILogger;
  private readonly availability = new Map<string, boolean>();

  constructor(private readonly options: LspSymbolExtractorOptions) {
    this.languages = new Set(options.languages ?? DEFAULT_LANGUAGES);
    this.probe = options.probe ?? new CapabilityProbe({ logger: options.logger });
    this.logger = (options.logger ?? silentLogger).child('lsp:symbols');
  }

  /**
   * در دسترس بودن، به‌ازای زبان کش می‌شود (SE-SYM-03).
   *
   * ولی «کش» اینجا فقط جواب *منفی نهایی* و *مثبت* را نگه می‌دارد؛
   * زنده بودن کلاینت هر بار از خودش پرسیده می‌شود، چون سرور ممکن است
   * وسط اسکن بمیرد.
   */
  async isAvailable(languageId: string): Promise<boolean> {
    if (!this.languages.has(languageId)) return false;

    const cached = this.availability.get(languageId);
    if (cached === false) return false;

    const client = await this.acquire(languageId);
    if (!client) {
      this.availability.set(languageId, false);
      return false;
    }
    if (cached === true) return true;

    /*
    | تا وقتی فایلی برای کاوش نداریم نمی‌شود قابلیت را سنجید. در آن
    | حالت «در دسترس» می‌گوییم و کاوش را به اولین `extract` موکول
    | می‌کنیم — که اگر بی‌اثر بود، همان‌جا نتیجهٔ خالی و هشدار
    | می‌دهد.
    */
    const probeFile = this.options.probeFile;
    if (!probeFile) return true;

    const report = await this.probe.probe(client, languageId, probeFile);
    const usable = isUsable(report, 'documentSymbol');
    this.availability.set(languageId, usable);
    if (!usable) {
      this.logger.info('language server declares documentSymbol but returns nothing; not using it', {
        language: languageId,
        verdict: report.verdicts.documentSymbol,
      });
    }
    return usable;
  }

  async extract(
    fileId: string,
    filePath: string,
    content: string,
    languageId: string
  ): Promise<Result<SymbolExtractionResult>> {
    const client = await this.acquire(languageId);
    if (!client) {
      return ok(empty([`no language server available for ${languageId}`]));
    }

    try {
      return ok(
        await this.withDeadline(
          this.runExtraction(client, fileId, filePath, content, languageId),
          () => client.closeDocument(filePath),
          filePath
        )
      );
    } catch (error) {
      /*
      | سرور کند یا مرده نباید استخراج فایل را بترکاند — فقط این
      | فایل را به استخراج‌گر بعدی می‌سپارد. `partial: true` یعنی
      | مدیر ادغام می‌کند نه اینکه اینجا بایستد.
      */
      const message = error instanceof Error ? error.message : String(error);
      this.logger.debug('extraction failed; leaving it to the next extractor', {
        file: filePath,
        error: message,
      });
      return ok(empty([message]));
    }
  }

  /**
   * خودِ کار، بدون سررسید — سررسید یک لایه بیرون‌تر است تا *همهٔ*
   * مسیرها را بپوشاند، نه فقط درخواست `documentSymbol`. کاوش قابلیت
   * هم یک رفت‌وبرگشت است و یک‌بار همین‌جا معلق شد.
   */
  private async runExtraction(
    client: LspClient,
    fileId: string,
    filePath: string,
    content: string,
    languageId: string
  ): Promise<SymbolExtractionResult> {
    {
      /*
      | کاوش قابلیت با همین فایل، اگر هنوز انجام نشده. اولین فایل
      | یک زبان، بهترین نمونهٔ کاوش است: واقعی است و جزو برنامه.
      */
      const report =
        this.probe.cached(client.serverKey, languageId) ??
        (await this.probe.probe(client, languageId, this.options.probeFile ?? filePath, content));

      if (!isUsable(report, 'documentSymbol')) {
        this.availability.set(languageId, false);
        return empty([
          `language server ${client.serverKey} declares documentSymbol but returned ` +
            `${report.verdicts.documentSymbol}; falling back`,
        ]);
      }

      const raw = await client.withDocument(
        filePath,
        languageId,
        () =>
          client.documentSymbol(filePath, {
            timeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
          }),
        content
      );

      if (raw === null || raw === undefined) {
        return empty(['language server returned no document symbols']);
      }
      if (!isHierarchical(raw)) {
        /*
        | `SymbolInformation[]` (شکل تخت و منسوخ) سلسله‌مراتب و
        | `endLine` واقعی ندارد — یعنی دقیقاً آن دو چیزی که ارزش
        | این مسیر است. tree-sitter از آن بهتر است.
        */
        return empty(['language server returned the flat SymbolInformation shape']);
      }

      const lines = content.split('\n');
      const importSpans = findImportLineSpans(content, languageId);
      const kept = raw.filter(symbol => !isImportBinding(symbol, importSpans));
      const dropped = raw.length - kept.length;

      const symbols = flattenDocumentSymbols(kept, {
        fileId,
        filePath,
        kindNumbering: 'lsp',
        language: languageId,
      }).map(symbol => refineKind(symbol, lines));

      const warnings: string[] = [];
      if (dropped > 0) warnings.push(`dropped ${dropped} import binding(s) reported as symbols`);

      return { symbols, source: 'lsp', partial: false, warnings };
    }
  }

  async dispose(): Promise<void> {
    this.availability.clear();
    this.probe.forget();
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

  /**
   * سقف زمانی روی کل کار یک فایل — SE-SYM-02.
   *
   * وقتی سررسید برسد، کار پس‌زمینه رها می‌شود ولی سند به‌زور بسته
   * می‌شود؛ وگرنه شمارندهٔ مرجع همان‌جا گیر می‌کند و حافظهٔ سرور
   * فایل‌به‌فایل بالا می‌رود.
   */
  private async withDeadline<T>(
    work: Promise<T>,
    onTimeout: () => void,
    filePath: string
  ): Promise<T> {
    const budget =
      this.options.fileBudgetMs ??
      Math.round((this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS) * 1.5);

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        try {
          onTimeout();
        } catch {
          // بستن سند بهترین تلاش است؛ خطایش نباید جای خطای اصلی را بگیرد.
        }
        reject(new Error(`language server took longer than ${budget}ms on ${filePath}`));
      }, budget);
      if (typeof timer.unref === 'function') timer.unref();
    });

    // نتیجهٔ رهاشده نباید unhandled rejection بسازد.
    work.catch(() => undefined);

    try {
      return await Promise.race([work, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function empty(warnings: string[]): SymbolExtractionResult {
  /*
  | `partial: true` عمدی است: «چیزی ندادم» با «چیزی نبود» فرق دارد.
  | با ناقص اعلام کردن، مدیر به استخراج‌گر بعدی می‌رود و نتیجه‌ها را
  | ادغام می‌کند.
  */
  return { symbols: [], source: 'lsp', partial: true, warnings };
}

/**
 * آیا این symbol در واقع یک نام import شده است؟ — SE-LSP-02.
 *
 * فقط `Variable`های سطح‌بالا که کاملاً داخل خط‌های یک دستور import
 * می‌افتند. محدود نگه داشتنش عمدی است: یک تعریف واقعی هیچ‌وقت داخل
 * دستور import نیست، ولی محتاط بودن یعنی حداکثر چند symbol جعلی
 * می‌ماند — در حالی که گشاد بودن یعنی تعریف‌های واقعی حذف می‌شوند.
 */
export function isImportBinding(
  symbol: DocumentSymbolLike,
  importSpans: readonly { startLine: number; endLine: number }[]
): boolean {
  if (importSpans.length === 0) return false;
  return (
    isInsideSpans(symbol.range.start.line, importSpans) &&
    isInsideSpans(symbol.range.end.line, importSpans)
  );
}

/**
 * اصلاح `kind` از روی متن اعلان — SE-LSP-08.
 *
 * دو مورد اندازه‌گیری‌شده روی `tsgo`:
 *
 * ```
 * export type Alias = string;   → kind=5  (Class)     باید type-alias باشد
 * export const VERSION = '1';   → kind=13 (Variable)  باید constant باشد
 * ```
 *
 * اصلاح فقط وقتی انجام می‌شود که خطِ شروعِ همان symbol، با نام خودش،
 * کلیدواژه را نشان بدهد. یعنی حدس نمی‌زنیم؛ چیزی را که در متن نوشته
 * شده می‌خوانیم.
 */
export function refineKind(symbol: SymbolEntry, lines: readonly string[]): SymbolEntry {
  const line = lines[symbol.line - 1];
  if (!line) return symbol;

  const name = escapeForRegExp(symbol.name);
  const prefix = String.raw`^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?`;

  if (symbol.kind === 'class' && new RegExp(`${prefix}type\\s+${name}\\b`).test(line)) {
    return { ...symbol, kind: 'type-alias' as SymbolKind };
  }
  if (symbol.kind === 'variable' && new RegExp(`${prefix}const\\s+${name}\\b`).test(line)) {
    return { ...symbol, kind: 'constant' as SymbolKind };
  }
  return symbol;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
