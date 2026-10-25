/**
 * LspEnrichmentService — استفادهٔ بودجه‌دار از زبان‌سرور — LSP-08 و LSP-17.
 *
 * ── چرا بودجه ───────────────────────────────────────────────────────
 *
 * اندازه‌گیری `LSP-ARCHITECTURE.md` بخش ۲.۵: هر `references` روی
 * `tsgo` حدود ۳۷ میلی‌ثانیه است. روی همین مخزن با ۷٬۲۹۳ symbol یعنی
 * **بیش از چهار دقیقه** فقط برای یک فیلد. بدون سقف، غنی‌سازی از
 * خودِ ایندکس‌سازی گران‌تر می‌شود.
 *
 * پس: سقف تعداد، سقف زمان دیواری، و اولویت‌دهی. آنچه از بودجه جا
 * می‌ماند، همان مقداری می‌ماند که پیش از این بود — نه صفر، نه غلط.
 *
 * ── چه چیزی غنی می‌شود ──────────────────────────────────────────────
 *
 * **`referenceCount`** — امروز روی همین مخزن فقط ۵۱۴ از ۷٬۲۹۳ symbol
 * عدد دارند، و همان‌ها هم از گراف حدسی می‌آیند. `textDocument/references`
 * جواب خودِ کامپایلر است.
 *
 * **یال‌های فراخوانی با `basis: 'resolved'`** — جایگزین
 * `findByName` سراسری (SE-GRAPH-03). آن fallback «اولین symbol
 * هم‌نام در کل پروژه» را برمی‌داشت؛ روی همین مخزن ۷۷۲ یال از آن راه
 * ساخته می‌شد و هر `log()` یا `get()` می‌توانست به جای بی‌ربطی وصل
 * شود. `callHierarchy/incomingCalls` همان را از کامپایلر می‌پرسد.
 *
 * ── SE-SYM-07 ───────────────────────────────────────────────────────
 *
 * نسخهٔ حذف‌شدهٔ `enrichWithHoverData` به‌ازای **هر** symbol یک hover
 * می‌فرستاد، ترتیبی. اینجا hover پیش‌فرض **خاموش** است
 * (`maxHoverQueries: 0`)، و اگر روشن شود از همان محدودکنندهٔ همزمانی
 * و همان بودجه رد می‌شود که بقیه.
 */

import * as path from 'path';
import { CallEdge, FileEntry, SymbolEntry } from '../core/types/project-index.types';
import { EdgeIdentity, makeEdgeId, provenanceFor } from '../graphs/EdgeProvenance';
import { ILogger, silentLogger } from '../host/Logger';
import { LspClient } from './LspClient';

export * from './lspEnrichmentTypes';
export { prioritize, findEnclosing, columnOfName, isModuleItem } from './lspEnrichmentHelpers';
import {
  BATCH_BUDGET, EnrichmentBudget, EnrichmentInput, EnrichmentResult, EnrichmentStats,
} from './lspEnrichmentTypes';
import {
  CallHierarchyItem, IncomingCall, columnOfName, findEnclosing, isModuleItem, prioritize,
  readFileOrNull, safeFsPath,
} from './lspEnrichmentHelpers';

export interface LspEnrichmentServiceOptions {
  readonly acquire: (languageId: string) => Promise<LspClient | null>;
  /**
   * زبان‌هایی که این سرویس سراغشان می‌رود.
   *
   * بدون این، نامزدها از *همهٔ* فایل‌ها می‌آمدند و سرور TypeScript
   * دربارهٔ کلیدهای `tsconfig.json` هم پرسیده می‌شد. جوابش هم
   * می‌آمد — `strict = 3` — که «سه بار این کلمه در فایل هست»
   * است، نه «سه ارجاع کد». هم بودجه هدر می‌رفت هم عدد بی‌معنی
   * وارد ایندکس می‌شد (SE-LSP-16).
   */
  readonly languages?: readonly string[];
  readonly logger?: ILogger;
  readonly budget?: EnrichmentBudget;
  readonly requestTimeoutMs?: number;
}

/** فقط این‌ها فراخوانی می‌شوند؛ برای بقیه `callHierarchy` بی‌معنی است. */
const CALLABLE_KINDS = new Set(['function', 'method', 'constructor']);

/** همان خانواده‌ای که `LspSymbolExtractor` ادعا می‌کند. */
const DEFAULT_ENRICHED_LANGUAGES = [
  'typescript',
  'typescriptreact',
  'javascript',
  'javascriptreact',
] as const;

export class LspEnrichmentService {
  private readonly logger: ILogger;
  private readonly budget: EnrichmentBudget;

  constructor(private readonly options: LspEnrichmentServiceOptions) {
    this.logger = (options.logger ?? silentLogger).child('lsp:enrich');
    this.budget = options.budget ?? BATCH_BUDGET;
  }

  async enrich(input: EnrichmentInput): Promise<EnrichmentResult> {
    const startedAt = Date.now();
    const languageId = input.languageId ?? 'typescript';
    const client = await this.acquire(languageId);

    const empty = (reason: string): EnrichmentResult => {
      this.logger.debug('enrichment skipped', { reason });
      return {
        symbols: input.symbols,
        callEdges: [],
        stats: {
          consideredSymbols: 0,
          referenceQueries: 0,
          callHierarchyQueries: 0,
          hoverQueries: 0,
          enrichedSymbols: 0,
          resolvedEdges: 0,
          durationMs: Date.now() - startedAt,
          budgetExhausted: false,
        },
      };
    };

    if (!client) return empty('no language server');

    const fileById = new Map(input.files.map(file => [file.id, file]));
    const symbolsByFile = new Map<string, SymbolEntry[]>();
    for (const symbol of input.symbols) {
      const list = symbolsByFile.get(symbol.fileId);
      if (list) list.push(symbol);
      else symbolsByFile.set(symbol.fileId, [symbol]);
    }

    const languages = new Set(this.options.languages ?? DEFAULT_ENRICHED_LANGUAGES);
    const inScope = new Set(
      input.files.filter(file => file.language && languages.has(file.language)).map(file => file.id)
    );
    const candidates = prioritize(
      { ...input, symbols: input.symbols.filter(symbol => inScope.has(symbol.fileId)) },
      this.budget.maxSymbols
    );
    if (candidates.length === 0) return empty('nothing worth enriching');

    const counters = { references: 0, callHierarchy: 0, hover: 0 };
    const referenceCounts = new Map<string, number>();
    const documentation = new Map<string, string>();
    const edges: CallEdge[] = [];
    let exhausted = false;

    const deadline = startedAt + this.budget.maxWallClockMs;
    const outOfTime = (): boolean => Date.now() >= deadline;

    /*
    | یک سند باز به‌ازای هر فایل، نه به‌ازای هر symbol. باز و بستهٔ
    | مکرر یک فایل روی سروری که هر بار برنامه را بازبینی می‌کند،
    | همان هزینه‌ای است که بودجه می‌خواهد جلویش را بگیرد. شمارش
    | مرجع فاز ۳۲ این را ارزان می‌کند.
    */
    const opened = new Set<string>();
    const linesOf = new Map<string, string[]>();
    /*
    | P-05/continuation-9-P-1 — دامنهٔ پیش‌فرض یک *خانواده* است
    | (ts-server هم TS و هم JS را سرو می‌کند)، ولی `languageId` اعلامی در
    | didOpen برای هر فایل باید واقعیِ خودش باشد: باز کردن `.js` با
    | `typescript` معنای بررسی را عوض می‌کند (checkJs/JS-specific) و
    | یافته‌های سرور به فایلِ اشتباه نسبت داده می‌شود. یک سرور، یک
    | languageId به‌ازای هر سند — نه برای همه.
    */
    const languageIdFor = (filePath: string): string => {
      const ext = path.extname(filePath).toLowerCase();
      if (ext === '.tsx') return 'typescriptreact';
      if (ext === '.jsx') return 'javascriptreact';
      if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return 'javascript';
      return languageId;
    };
    const openFor = (symbol: SymbolEntry): string | null => {
      const file = fileById.get(symbol.fileId);
      if (!file) return null;
      const absolute = this.absolute(input.workspaceRoot, file.path);
      if (!opened.has(absolute)) {
        try {
          /*
          | متن لازم است، نه فقط برای سرور بلکه برای پیدا کردن
          | **ستون** نام. بدون آن، موقعیت روی ستون صفر می‌افتد که
          | معمولاً کلیدواژه است و سرور «اینجا چیزی نیست» می‌دهد —
          | یعنی غنی‌سازی بی‌صدا هیچ‌چیز برنمی‌گرداند.
          |
          | `IndexPipeline` محتوا را پیش از این مرحله آزاد کرده
          | (SE-EXT-03)، پس اگر در دست نبود از دیسک خوانده می‌شود؛
          | فقط برای همان چند صد فایلی که در بودجه‌اند.
          */
          const content = input.contentOf?.(file.id) ?? readFileOrNull(absolute);
          client.openDocument(absolute, languageIdFor(file.path), content ?? undefined);
          if (content !== undefined && content !== null) linesOf.set(absolute, content.split('\n'));
          opened.add(absolute);
        } catch (error) {
          this.logger.debug('could not open document', { file: file.path, error: String(error) });
          return null;
        }
      }
      return absolute;
    };

    const work = async (symbol: SymbolEntry): Promise<void> => {
      if (outOfTime()) {
        exhausted = true;
        return;
      }
      const absolute = openFor(symbol);
      if (!absolute) return;

      /*
      | ستون صفر معمولاً روی کلیدواژه (`export`) می‌افتد و سرور
      | «اینجا چیزی نیست» می‌دهد. ستونِ خودِ نام، ارزان‌ترین راه
      | رسیدن به موقعیتی است که سرور بشناسد.
      */
      const position = {
        line: symbol.line - 1,
        character: columnOfName(linesOf.get(absolute), symbol),
      };

      if (counters.references < this.budget.maxReferenceQueries) {
        counters.references++;
        const count = await this.referenceCount(client, absolute, symbol, position);
        if (count !== null) referenceCounts.set(symbol.id, count);
      }

      if (
        CALLABLE_KINDS.has(symbol.kind) &&
        counters.callHierarchy < this.budget.maxCallHierarchyQueries
      ) {
        counters.callHierarchy++;
        const found = await this.incomingEdges(
          client,
          absolute,
          symbol,
          position,
          input,
          fileById,
          symbolsByFile
        );
        edges.push(...found);
      }

      if (counters.hover < this.budget.maxHoverQueries) {
        counters.hover++;
        const text = await this.hover(client, absolute, position);
        if (text) documentation.set(symbol.id, text);
      }
    };

    await this.runWithConcurrency(candidates, work);

    for (const absolute of opened) client.closeDocument(absolute);

    if (outOfTime()) exhausted = true;
    /*
    | P-05/continuation-9-P-3 — `budgetExhausted` فقط references را صریحاً
    | علامت می‌زد؛ برخورد دقیق با `maxCallHierarchyQueries` یا
    | `maxHoverQueries` (بودجه‌های سفارشی) flag را set نمی‌کرد، یعنی
    | مصرف‌کننده «کامل» می‌خواند درحالی‌که یک بودجه تمام شده بود (§16).
    */
    if (counters.references >= this.budget.maxReferenceQueries) exhausted = true;
    if (counters.callHierarchy >= this.budget.maxCallHierarchyQueries) exhausted = true;
    if (this.budget.maxHoverQueries > 0 && counters.hover >= this.budget.maxHoverQueries) exhausted = true;

    const symbols = input.symbols.map(symbol => {
      const count = referenceCounts.get(symbol.id);
      const docs = documentation.get(symbol.id);
      if (count === undefined && docs === undefined) return symbol;
      return {
        ...symbol,
        referenceCount: count ?? symbol.referenceCount,
        documentation: docs ?? symbol.documentation,
      };
    });

    const stats: EnrichmentStats = {
      consideredSymbols: candidates.length,
      referenceQueries: counters.references,
      callHierarchyQueries: counters.callHierarchy,
      hoverQueries: counters.hover,
      enrichedSymbols: referenceCounts.size,
      resolvedEdges: edges.length,
      durationMs: Date.now() - startedAt,
      budgetExhausted: exhausted,
    };

    if (exhausted) {
      /*
      | «نگاه نکردیم» با «چیزی نبود» یکی نیست — همان درسی که فاز ۳۴
      | برای بودجهٔ diagnostics نوشت.
      */
      this.logger.warn('enrichment budget exhausted', {
        considered: stats.consideredSymbols,
        enriched: stats.enrichedSymbols,
        ms: stats.durationMs,
      });
    }
    this.logger.debug('enrichment finished', { ...stats });

    return { symbols, callEdges: edges, stats };
  }

  // ── درون ────────────────────────────────────────────────────────────

  private async acquire(languageId: string): Promise<LspClient | null> {
    try {
      const client = await this.options.acquire(languageId);
      return client && client.isRunning ? client : null;
    } catch (error) {
      this.logger.debug('could not acquire a language server', { error: String(error) });
      return null;
    }
  }

  private absolute(workspaceRoot: string, filePath: string): string {
    return path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath);
  }

  private timeout(): number {
    return this.options.requestTimeoutMs ?? 10_000;
  }

  private async referenceCount(
    client: LspClient,
    absolute: string,
    symbol: SymbolEntry,
    position: { line: number; character: number }
  ): Promise<number | null> {
    try {
      const locations = await client.request<{ uri: string }[] | null>(
        'textDocument/references',
        {
          textDocument: { uri: client.uriFor(absolute) },
          position,
          context: { includeDeclaration: false },
        },
        { timeoutMs: this.timeout() }
      );
      return Array.isArray(locations) ? locations.length : null;
    } catch (error) {
      this.logger.debug('references failed', { symbol: symbol.name, error: String(error) });
      return null;
    }
  }

  private async hover(
    client: LspClient,
    absolute: string,
    position: { line: number; character: number }
  ): Promise<string | null> {
    try {
      const result = await client.request<{ contents?: { value?: string } | string } | null>(
        'textDocument/hover',
        { textDocument: { uri: client.uriFor(absolute) }, position },
        { timeoutMs: this.timeout() }
      );
      const contents = result?.contents;
      if (!contents) return null;
      if (typeof contents === 'string') return contents;
      return contents.value ?? null;
    } catch {
      return null;
    }
  }

  /**
   * یال‌های ورودی یک symbol، از خودِ کامپایلر — LSP-17.
   *
   * `from` می‌تواند یک فایل باشد و نه یک symbol (SE-LSP-13: سرور
   * نام فایل را مسیر مطلق می‌گذارد). آن حالت با `callerKind: 'file'`
   * ثبت می‌شود — همان کاری که `CallGraphBuilder` از فاز ۳۷ می‌کند —
   * نه اینکه یک مسیر مطلق ماشین وارد ایندکس شود.
   */
  private async incomingEdges(
    client: LspClient,
    absolute: string,
    symbol: SymbolEntry,
    position: { line: number; character: number },
    input: EnrichmentInput,
    fileById: ReadonlyMap<string, FileEntry>,
    symbolsByFile: ReadonlyMap<string, SymbolEntry[]>
  ): Promise<CallEdge[]> {
    try {
      const prepared = await client.request<CallHierarchyItem[] | null>(
        'textDocument/prepareCallHierarchy',
        { textDocument: { uri: client.uriFor(absolute) }, position },
        { timeoutMs: this.timeout() }
      );
      if (!prepared || prepared.length === 0) return [];

      const calls = await client.request<IncomingCall[] | null>(
        'callHierarchy/incomingCalls',
        { item: prepared[0] },
        { timeoutMs: this.timeout() }
      );
      if (!calls || calls.length === 0) return [];

      const pathToFileId = new Map<string, string>();
      for (const file of input.files) {
        pathToFileId.set(this.absolute(input.workspaceRoot, file.path), file.id);
      }

      const edges: CallEdge[] = [];
      /*
      | P-05/continuation-9-P-2 — نسخهٔ اول برای همهٔ rangeها `occurrence: 0`
      | می‌داد؛ دو `fromRanges` با یک خطِ یکسان (سناریوی طراحی‌شدهٔ
      | قرارداد occurrence: `f(g(), g())`) یک شناسه می‌گرفتند و هر نگاشتی
      | کلیدش شناسهٔ یال باشد، دومی را روی اولی می‌نوشت. حالا مثل
      | `CallGraphBuilder.occurrenceOf` از صفر شمارش می‌شود.
      */
      const occurrences = new Map<string, number>();
      for (const call of calls) {
        const fromPath = safeFsPath(call.from?.uri);
        if (!fromPath) continue;
        const fileId = pathToFileId.get(fromPath);
        if (!fileId) continue;   // خارج از ایندکس — مثلاً node_modules

        /*
        | SE-LSP-13: فراخوانی در سطح ماژول را سرور با `kind: 2`
        | (Module) و **مسیر مطلق فایل** به‌عنوان نام گزارش می‌کند.
        | آن آیتم کلِ فایل را پوشش می‌دهد و `selectionRange`ش روی
        | `0:0` است — پس جست‌وجوی symbol دربرگیرنده، آن را به
        | هرچه روی خط اول باشد می‌چسباند. باید صریح تشخیص داده
        | شود، نه با موقعیت.
        */
        const moduleLevel = isModuleItem(call.from, fromPath);
        const line = (call.from.selectionRange?.start.line ?? call.from.range.start.line) + 1;
        const caller = moduleLevel
          ? undefined
          : findEnclosing(symbolsByFile.get(fileId) ?? [], line);

        for (const range of call.fromRanges ?? [{ start: { line: line - 1, character: 0 } }]) {
          const callLine = range.start.line + 1;
          const identity: EdgeIdentity = {
            from: caller?.id ?? fileId,
            to: symbol.id,
            kind: 'direct',
            line: callLine,
          };
          const file = fileById.get(fileId);
          const occKey = `${identity.from}\u0000${identity.to}\u0000${identity.kind}\u0000${identity.line}`;
          const occurrence = occurrences.get(occKey) ?? 0;
          occurrences.set(occKey, occurrence + 1);
          edges.push({
            id: makeEdgeId({ ...identity, occurrence }),
            caller: identity.from,
            callerKind: caller ? 'symbol' : 'file',
            callee: symbol.id,
            kind: caller?.id === symbol.id ? 'recursive' : 'direct',
            line: callLine,
            provenance: provenanceFor('resolved', 'lsp', {
              file: file?.path ?? fromPath,
              line: callLine,
            }),
          });
        }
      }
      return edges;
    } catch (error) {
      this.logger.debug('call hierarchy failed', { symbol: symbol.name, error: String(error) });
      return [];
    }
  }

  /**
   * اجرای محدودشده.
   *
   * نه ترتیبی (که SE-SYM-07 بود: ۲۰٬۰۰۰ رفت‌وبرگشت پشت سر هم) و نه
   * `Promise.all` روی همه‌چیز (که سرور را زیر بار می‌برد و حافظه‌اش
   * را می‌ترکاند).
   */
  private async runWithConcurrency(
    items: readonly SymbolEntry[],
    work: (symbol: SymbolEntry) => Promise<void>
  ): Promise<void> {
    const limit = Math.max(1, this.budget.concurrency);
    let next = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        await work(items[index]);
      }
    };

    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  }
}

// ── اولویت‌دهی ─────────────────────────────────────────────────────────

