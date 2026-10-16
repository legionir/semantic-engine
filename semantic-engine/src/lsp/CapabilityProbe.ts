/**
 * CapabilityProbe — اعلام‌شده ≠ پیاده‌شده — LSP-15.
 *
 * سند `LSP-ARCHITECTURE.md` (بخش ۲.۷) هشدار داده بود و فاز ۳۳ روی
 * `tsgo 7.0.2` دوباره اندازه‌اش گرفت. سرور این‌ها را **اعلام** می‌کند
 * و در عمل:
 *
 * ```
 * قابلیت                       اعلام‌شده   نتیجهٔ واقعی
 * documentSymbol               ✔          array(7)
 * hover                        ✔          markdown
 * references                   ✔          array(2)
 * diagnostic (pull)            ✔          items → خطاهای واقعی
 * rename                       ✔          WorkspaceEdit
 * callHierarchy                ✔          array(1)
 * codeAction only=quickfix     ✔          array(0)        ← بی‌اثر
 * semanticTokens               ✔          {"data":[]}     ← بی‌اثر
 * inlayHint                    ✔          null            ← بی‌اثر
 * ```
 *
 * سه‌تای آخر «پشتیبانی می‌شوند» و هیچ‌وقت چیزی برنمی‌گردانند. ابزاری
 * که به یک مدل اعلام شود و همیشه آرایهٔ خالی بدهد، **بدتر از نبودنش**
 * است: مدل آن را امتحان می‌کند، جواب خالی می‌گیرد، و نتیجه می‌گیرد که
 * چیزی وجود ندارد.
 *
 * و از فاز ۳۲ (SE-LSP-05) می‌دانیم کد خطا هم راه‌حل نیست: متد ناشناخته
 * روی این سرور ‎-32600 می‌دهد نه ‎-32601. پس تنها سنجهٔ قابل اتکا این
 * است که **یک بار واقعاً درخواست بدهیم و به نتیجه نگاه کنیم**.
 *
 * هزینه‌اش یک بار در هر جلسه است، و نتیجه کش می‌شود.
 */

import { pathToFileURL } from 'url';
import { LspClient } from './LspClient';
import { ILogger, silentLogger } from '../host/Logger';

/** قابلیت‌هایی که این پروژه واقعاً مصرف می‌کند. */
export type LspCapability =
  | 'documentSymbol'
  | 'hover'
  | 'references'
  | 'definition'
  | 'diagnostic'
  | 'rename'
  | 'callHierarchy'
  | 'organizeImports';

export const PROBED_CAPABILITIES: readonly LspCapability[] = [
  'documentSymbol',
  'hover',
  'references',
  'definition',
  'diagnostic',
  'rename',
  'callHierarchy',
  'organizeImports',
];

export type CapabilityVerdict =
  /** درخواست جواب بامعنی داد. */
  | 'works'
  /** سرور جواب داد ولی خالی — اعلام‌شده و بی‌اثر. */
  | 'empty'
  /** سرور اعلام نکرده بود، پس اصلاً پرسیده نشد. */
  | 'not-declared'
  /** درخواست خطا داد یا به‌موقع جواب نداد. */
  | 'failed';

export interface CapabilityReport {
  readonly serverId: string;
  readonly languageId: string;
  readonly probeFile: string;
  readonly verdicts: Readonly<Record<LspCapability, CapabilityVerdict>>;
  readonly durationMs: number;
}

export interface CapabilityProbeOptions {
  readonly logger?: ILogger;
  /** سررسید هر درخواست کاوش. کاوش نباید ایندکس را نگه دارد. */
  readonly timeoutMs?: number;
  /**
   * سقف کل کاوش.
   *
   * هشت درخواست پشت سر هم، هرکدام با سررسید مستقل، روی یک سرور مرده
   * یعنی هشت برابر آن سررسید انتظار. سقف کل، این را می‌بندد و
   * باقی‌مانده را `failed` علامت می‌زند.
   */
  readonly totalBudgetMs?: number;
}

/** فقط `works` یعنی می‌شود رویش حساب کرد. */
export function isUsable(report: CapabilityReport | undefined, capability: LspCapability): boolean {
  return report?.verdicts[capability] === 'works';
}

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_PROBE_BUDGET_MS = 15_000;

/**
 * یک بار در هر جلسه، به‌ازای (سرور × زبان).
 *
 * کاوش روی یک فایل واقعی از خود پروژه انجام می‌شود، نه روی یک قطعهٔ
 * ساختگی: سروری مثل `tsgo` تا فایل را جزو برنامه نبیند جواب تهی
 * می‌دهد، و آن‌وقت کاوش، «بی‌اثر» را برای قابلیتی گزارش می‌کند که
 * فقط ورودی بدی گرفته بود.
 */
export class CapabilityProbe {
  private readonly cache = new Map<string, CapabilityReport>();
  private readonly inFlight = new Map<string, Promise<CapabilityReport>>();
  /*
  | P-05/SE-F-031 — `forget()` قبلاً فقط `cache` را پاک می‌کرد؛ کاوشِ
  | درحال‌پرواز در `inFlight` می‌ماند، فراخوان‌های هم‌زمانِ بعدی همان
  | promise کهنه را تحویل می‌گرفتند و در پایان نتیجه را دوباره در
  | cache می‌نوشت — یعنی forget عملاً بی‌اثر بود. حالا یک epoch
  | سراسری هست: هر forget epoch را بالا می‌برد و inFlightها را دور
  | می‌ریزد، و یک کاوش فقط وقتی نتیجه‌اش را می‌نویسد که epochِ شروع
  | با epochِ فعلی برابر باشد. (re-probe بعداً اتفاق می‌افتد؛ forget
  | رویداد کمیابی است، پس conservative-invalidation هزینه‌ای ندارد.)
  */
  private epoch = 0;
  private readonly logger: ILogger;
  private readonly timeoutMs: number;
  private readonly budgetMs: number;

  constructor(options: CapabilityProbeOptions = {}) {
    this.logger = (options.logger ?? silentLogger).child('lsp:probe');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.budgetMs = options.totalBudgetMs ?? DEFAULT_PROBE_BUDGET_MS;
  }

  /** نتیجهٔ کش‌شده، بدون اجرای کاوش. */
  cached(serverId: string, languageId: string): CapabilityReport | undefined {
    return this.cache.get(`${serverId}:${languageId}`);
  }

  forget(serverId?: string): void {
    this.epoch++;
    if (!serverId) {
      this.cache.clear();
      this.inFlight.clear();
      return;
    }
    for (const key of Array.from(this.cache.keys())) {
      if (key.startsWith(`${serverId}:`) || key.startsWith(`${serverId}@`)) this.cache.delete(key);
    }
    for (const key of Array.from(this.inFlight.keys())) {
      if (key.startsWith(`${serverId}:`) || key.startsWith(`${serverId}@`)) this.inFlight.delete(key);
    }
  }

  /**
   * کاوش (یا برگرداندن نتیجهٔ کش‌شده).
   *
   * فراخوانی هم‌زمان برای یک کلید، یک کاوش می‌سازد نه چند تا — وگرنه
   * اولین موج فایل‌ها هرکدام یک کاوش راه می‌اندازند.
   */
  async probe(
    client: LspClient,
    languageId: string,
    probeFile: string,
    probeText?: string
  ): Promise<CapabilityReport> {
    const key = `${client.serverKey}:${languageId}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const running = this.inFlight.get(key);
    if (running) return running;

    const epochAtStart = this.epoch;
    const started = this.run(client, languageId, probeFile, probeText)
      .then(report => {
        /*
        | P-05/SE-F-031 — اگر وسط کاوش `forget()` اجرا شده باشد (epoch
        | عوض شده)، نتیجه متعلق به دنیای قبل است: آن را در cache
        | نمی‌نویسیم تا کاوشِ جدیدِ همان سرور با پاسخ کهنه پر نشود.
        */
        if (this.epoch === epochAtStart) {
          this.cache.set(key, report);
        }
        return report;
      })
      .finally(() => {
        if (this.epoch === epochAtStart) {
          this.inFlight.delete(key);
        }
      });

    this.inFlight.set(key, started);
    return started;
  }

  private async run(
    client: LspClient,
    languageId: string,
    probeFile: string,
    probeText?: string
  ): Promise<CapabilityReport> {
    const startedAt = Date.now();
    const deadline = startedAt + this.budgetMs;
    const outOfTime = (): boolean => Date.now() > deadline;
    const verdicts = {} as Record<LspCapability, CapabilityVerdict>;
    for (const capability of PROBED_CAPABILITIES) verdicts[capability] = 'not-declared';

    const capabilities = client.capabilities ?? {};
    const declared = (key: string): boolean => {
      const value = capabilities[key];
      return value !== undefined && value !== false && value !== null;
    };

    await client.withDocument(
      probeFile,
      languageId,
      async () => {
        /*
        | جای کاوش اهمیت دارد، و یک‌بار همین‌جا گیرمان انداخت:
        | `prepareCallHierarchy` روی یک `const` هیچ‌چیز برنمی‌گرداند،
        | پس کاوشی که روی آخرین symbol فایل لنگر بیندازد،
        | `callHierarchy` را «بی‌اثر» گزارش می‌کند در حالی که روی یک
        | تابع، درست کار می‌کند.
        |
        | خطای معکوس هم به‌اندازهٔ خطای اول بد است: ابزار سالمی که
        | مرده اعلام شود، همان‌قدر قابلیت را از مدل می‌گیرد. پس چند
        | لنگر امتحان می‌شود و اولین جواب ناخالی کافی است.
        */
        let anchors: { line: number; character: number }[] = [{ line: 0, character: 0 }];

        if (!outOfTime() && declared('documentSymbolProvider')) {
          verdicts.documentSymbol = await this.verdictOf(async () => {
            const symbols = await client.documentSymbol(probeFile, { timeoutMs: this.timeoutMs });
            const found = anchorsFrom(symbols);
            if (found.length > 0) anchors = found;
            return symbols;
          });
        }

        if (!outOfTime() && declared('hoverProvider')) {
          verdicts.hover = await this.bestVerdict(anchors, anchor =>
            client.request('textDocument/hover', this.at(probeFile, anchor), {
              timeoutMs: this.timeoutMs,
            })
          );
        }

        if (!outOfTime() && declared('referencesProvider')) {
          verdicts.references = await this.bestVerdict(anchors, anchor =>
            client.request(
              'textDocument/references',
              { ...this.at(probeFile, anchor), context: { includeDeclaration: true } },
              { timeoutMs: this.timeoutMs }
            )
          );
        }

        if (!outOfTime() && declared('definitionProvider')) {
          verdicts.definition = await this.bestVerdict(anchors, anchor =>
            client.request('textDocument/definition', this.at(probeFile, anchor), {
              timeoutMs: this.timeoutMs,
            })
          );
        }

        if (!outOfTime() && declared('diagnosticProvider')) {
          verdicts.diagnostic = await this.verdictOf(() =>
            client.request(
              'textDocument/diagnostic',
              { textDocument: { uri: client.uriFor(probeFile) } },
              { timeoutMs: this.timeoutMs }
            )
          );
        }

        if (!outOfTime() && declared('renameProvider')) {
          /*
          | `prepareRename` می‌پرسد «اینجا می‌شود تغییر نام داد؟» و
          | برخلاف `rename` هیچ ویرایشی نمی‌سازد. کاوش نباید
          | عوارض جانبی داشته باشد.
          */
          verdicts.rename = await this.bestVerdict(anchors, anchor =>
            client.request('textDocument/prepareRename', this.at(probeFile, anchor), {
              timeoutMs: this.timeoutMs,
            })
          );
        }

        if (!outOfTime() && declared('callHierarchyProvider')) {
          verdicts.callHierarchy = await this.bestVerdict(anchors, anchor =>
            client.request('textDocument/prepareCallHierarchy', this.at(probeFile, anchor), {
              timeoutMs: this.timeoutMs,
            })
          );
        }

        if (!outOfTime() && declared('codeActionProvider')) {
          verdicts.organizeImports = await this.verdictOf(() =>
            client.request(
              'textDocument/codeAction',
              {
                textDocument: { uri: client.uriFor(probeFile) },
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                context: { diagnostics: [], only: ['source.organizeImports'] },
              },
              { timeoutMs: this.timeoutMs }
            )
          );
        }
      },
      probeText
    );

    const report: CapabilityReport = {
      serverId: client.serverKey,
      languageId,
      probeFile,
      verdicts,
      durationMs: Date.now() - startedAt,
    };
    this.logger.debug('capability probe finished', {
      language: languageId,
      ms: report.durationMs,
      ...verdicts,
    });
    return report;
  }

  private uriOf(filePath: string): string {
    return pathToFileURL(filePath).toString();
  }

  private at(filePath: string, position: { line: number; character: number }) {
    return { textDocument: { uri: this.uriOf(filePath) }, position };
  }

  /**
   * نتیجه را به یک حکم تبدیل می‌کند.
   *
   * «خالی» یعنی سرور جواب داد ولی چیزی در آن نبود: آرایهٔ صفرتایی،
   * `null`، یا شیئی که هر آرایهٔ داخلش خالی است (`{"data":[]}` که
   * `semanticTokens` می‌دهد).
   */
  /**
   * چند لنگر را امتحان می‌کند و بهترین حکم را برمی‌گرداند.
   *
   * `works` > `empty` > `failed`: یک بار کار کردن کافی است تا
   * قابلیت «هست» باشد.
   */
  private async bestVerdict(
    anchors: readonly { line: number; character: number }[],
    run: (anchor: { line: number; character: number }) => Promise<unknown>
  ): Promise<CapabilityVerdict> {
    let best: CapabilityVerdict = 'failed';
    for (const anchor of anchors) {
      const verdict = await this.verdictOf(() => run(anchor));
      if (verdict === 'works') return verdict;
      if (verdict === 'empty') best = 'empty';
    }
    return best;
  }

  private async verdictOf(run: () => Promise<unknown>): Promise<CapabilityVerdict> {
    try {
      const value = await run();
      return isEmptyResult(value) ? 'empty' : 'works';
    } catch (error) {
      this.logger.debug('probe request failed', { error: String(error) });
      return 'failed';
    }
  }
}

/** حداکثر چند نقطه برای کاوش امتحان شود. */
const MAX_ANCHORS = 4;

/*
| ترتیب ترجیح: چیزی که «صدا زده می‌شود» بیشترین شانس را می‌دهد
| (Function=12, Method=6, Constructor=9) و بعد نوع‌ها (Class=5,
| Interface=11). اعداد از جدول یک‌مبنای LSP‌اند (`src/symbols/types.ts`).
*/
const ANCHOR_KIND_PREFERENCE = [12, 6, 9, 5, 11];

/** موقعیت‌های نامزد کاوش، از روی خروجی `documentSymbol`. */
export function anchorsFrom(symbols: unknown): { line: number; character: number }[] {
  if (!Array.isArray(symbols)) return [];

  const flat: { kind: number; position: { line: number; character: number } }[] = [];
  const walk = (list: unknown[]): void => {
    for (const item of list) {
      const symbol = item as {
        kind?: number;
        selectionRange?: { start: { line: number; character: number } };
        location?: { range: { start: { line: number; character: number } } };
        children?: unknown[];
      };
      const start = symbol.selectionRange?.start ?? symbol.location?.range?.start;
      if (start && typeof symbol.kind === 'number') {
        flat.push({ kind: symbol.kind, position: start });
      }
      if (Array.isArray(symbol.children)) walk(symbol.children);
    }
  };
  walk(symbols);

  const rank = (kind: number): number => {
    const index = ANCHOR_KIND_PREFERENCE.indexOf(kind);
    return index === -1 ? ANCHOR_KIND_PREFERENCE.length : index;
  };

  return flat
    .map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => rank(a.kind) - rank(b.kind) || a.index - b.index)
    .slice(0, MAX_ANCHORS)
    .map(entry => entry.position);
}

export function isEmptyResult(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return true;
    /*
    | `{"kind":"full","items":[]}` و `{"data":[]}`: کلید ساختاری
    | دارند ولی هیچ محتوایی. اگر هر آرایه‌ای که داخلش هست خالی باشد
    | و هیچ محتوای دیگری نباشد، نتیجه تهی است.
    */
    const arrays = entries.filter(([, item]) => Array.isArray(item));
    if (arrays.length > 0 && arrays.every(([, item]) => (item as unknown[]).length === 0)) {
      const others = entries.filter(([, item]) => !Array.isArray(item));
      return others.every(([, item]) => typeof item === 'string' || typeof item === 'boolean' || item === null);
    }
    return false;
  }
  return false;
}
