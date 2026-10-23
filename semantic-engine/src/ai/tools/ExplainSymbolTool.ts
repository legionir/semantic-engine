/**
 * ExplainSymbolTool — همه‌چیزِ یک symbol، در یک تماس — GAP-03.
 *
 * سند شکاف‌ها این را «ارزان‌ترین برد کل سند» نامیده و دلیلش را هم
 * گفته: **تمام داده از قبل موجود است، فقط پراکنده.** امروز مدل برای
 * فهمیدن یک symbol باید چهار ابزار جدا صدا بزند و خودش وصله کند:
 *
 * ```
 * find_symbol      → امضا، خط، kind
 * get_dependencies → چه چیزی را صدا می‌زند
 * impact_analysis  → چه کسی آن را صدا می‌زند
 * find_tests       → کدام تست‌ها پوششش می‌دهند
 * ```
 *
 * چهار رفت‌وبرگشت، چهار قالب متفاوت، و هیچ‌کدام نمی‌گویند این
 * اطلاعات چقدر قابل اتکاست.
 *
 * ── تصمیم: `confidence` بخشِ اصلیِ خروجی است، نه یک ضمیمه ──────────
 *
 * نمونهٔ خروجی در سند، فیلدی به نام `confidence` دارد که برای هر
 * بخش می‌گوید داده از کجا آمده (`resolved` در برابر `name-match`).
 * این تنها چیزی است که خروجی را از «چهار تماس، دستی وصله‌شده» متمایز
 * می‌کند: مدل می‌تواند ببیند `calledBy` از یک حدسِ نام آمده و به آن
 * تکیه نکند.
 *
 * ── چه چیزی *ساخته* نمی‌شود ────────────────────────────────────────
 *
 * هیچ فیلدی که داده‌اش نیست، با عدد پیش‌فرض پر نمی‌شود. `complexity`
 * که محاسبه نشده `null` است، نه صفر؛ `git` که نیست، غایب است نه
 * `{commitCount: 0}`. صفرِ ساختگی از نبودِ فیلد بدتر است چون شبیه
 * دادهٔ واقعی است.
 */

import { AiTool, AiToolOutput } from './types';
import { ProjectIndexReader } from '../ProjectIndexReader';
import { GraphQueryEngine, GraphEdge } from '../../graphs/GraphQueryEngine';
import { FindTestsTool } from './FindTestsTool';
import { SymbolEntry } from '../../core/types/project-index.types';
import { DECLARATION_KINDS } from '../../symbols/heuristic/SymbolExtractionHelpers';
import { HIGH_CONFIDENCE_THRESHOLD } from '../../graphs/EdgeProvenance';
import type { ExplainSymbolInput, RelatedSymbol, SymbolExplanation } from './explainSymbolTypes';
import { diagnosticsCaveat, displaySymbolName, summarize } from './explainSymbolText';

export type { ExplainSymbolInput, SymbolExplanation } from './explainSymbolTypes';
export { diagnosticsCaveat, displaySymbolName } from './explainSymbolText';

export class ExplainSymbolTool implements AiTool<ExplainSymbolInput> {
  readonly name = 'explain_symbol';
  readonly description =
    'Everything known about one symbol in a single call: signature, complexity, calls, callers, tests, git, scores, diagnostics, and how trustworthy each part is. Diagnostics come from a language-server pass that is opt-in (--lsp-diagnostics): an empty list without a diagnosticsRun record on the index means "not checked", not "clean".';
  readonly inputSchema = {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Symbol id' },
      name: { type: 'string', description: 'Symbol name (alternative to id)' },
      path: { type: 'string', description: 'File path, to disambiguate a name' },
      limit: { type: 'integer', default: 20 },
      minConfidence: { type: 'integer', default: 0 },
    },
    required: [],
  };

  private engine: GraphQueryEngine | undefined;
  /*
  | تست‌ها از خودِ `find_tests` می‌آیند و نه از یک پیمایش موازی.
  | آن ابزار بیش از نگاشت `testIds` می‌داند (تطبیق نام فایل،
  | پوشهٔ همسایه)، و دو پیاده‌سازی یعنی دو جواب متفاوت برای یک
  | سؤال — که دقیقاً همان چیزی است که این فاز می‌خواهد از بین
  | ببرد.
  */
  private readonly tests: FindTestsTool;

  constructor(private readonly reader: ProjectIndexReader) {
    this.tests = new FindTestsTool(reader);
  }

  async execute(input: ExplainSymbolInput): Promise<AiToolOutput> {
    try {
      const found = this.resolveSymbol(input);
      if ('error' in found) return { success: false, error: found.error, items: found.items };

      const explanation = await this.explain(found.symbol, input);
      return {
        success: true,
        items: [
          {
            id: explanation.id,
            name: explanation.symbol,
            kind: explanation.kind,
            path: explanation.file,
            line: explanation.line,
            source: 'explain-symbol',
            metadata: explanation as unknown as Record<string, unknown>,
          },
        ],
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        items: [],
      };
    }
  }

  /**
   * پیدا کردن symbol از id یا نام.
   *
   * نام مبهم، خطا **نیست**: فهرست نامزدها برمی‌گردد تا مدل بتواند
   * دوباره با `path` بپرسد. خطا دادن اینجا یعنی یک رفت‌وبرگشت
   * اضافه برای چیزی که خودمان می‌دانیم.
   */
  private resolveSymbol(
    input: ExplainSymbolInput
  ): { symbol: SymbolEntry } | { error: string; items: AiToolOutput['items'] } {
    if (input.id) {
      const symbol = this.reader.getSymbolById(input.id);
      if (!symbol) return { error: `No symbol with id ${input.id}`, items: [] };
      return { symbol };
    }

    if (!input.name) return { error: 'Either id or name is required', items: [] };

    let candidates = this.reader.getSymbolsByName(input.name);
    if (input.path) {
      const file = this.reader.getFileByPath(input.path);
      candidates = file ? candidates.filter(symbol => symbol.fileId === file.id) : [];
    }

    if (candidates.length === 0) {
      return { error: `No symbol named ${input.name}`, items: [] };
    }
    if (candidates.length > 1) {
      return {
        error: `${candidates.length} symbols are named ${input.name}; pass id or path`,
        items: candidates.map(symbol => ({
          id: symbol.id,
          name: symbol.fullyQualifiedName || symbol.name,
          kind: symbol.kind,
          path: this.reader.getFileById(symbol.fileId)?.path,
          line: symbol.line,
          source: 'explain-symbol:candidate',
        })),
      };
    }

    return { symbol: candidates[0] };
  }

  private async explain(
    symbol: SymbolEntry,
    input: ExplainSymbolInput
  ): Promise<SymbolExplanation> {
    const limit = input.limit ?? 20;
    const minConfidence = input.minConfidence ?? 0;
    const engine = (this.engine ??= new GraphQueryEngine(this.reader.projectIndex));
    const file = this.reader.getFileById(symbol.fileId);

    /*
    | برای یک سمبل اعلانی، خودِ گره لبه‌ای ندارد — لبه‌ها به اعضایش وصل‌اند.
    | پس owners = خودِ سمبل + اعضا، و یال‌ها روی همان مجموعه گرفته می‌شوند.
    */
    /*
    | یک سمبل اعلانی — کلاس، اینترفیس، enum، struct — خودش معمولاً هیچ لبه‌ای
    | ندارد: فراخوانی‌ها به سازنده و متدها وصل‌اند و importها به فایل. پس
    | یال‌ها روی «مالک‌ها» (خودِ سمبل + اعضایش) گرفته می‌شوند و روی *سمبل
    | مقابل* یکتا؛ وگرنه explain_symbol روی یک کلاسِ پر از مصرف‌کننده،
    | همان چیزی را برمی‌گرداند که یک کلاس بدون مصرف‌کننده برمی‌گرداند.
    */
    const isDeclaration = DECLARATION_KINDS.has(symbol.kind);
    const members = isDeclaration
      ? this.reader.getSymbolsForFile(symbol.fileId).filter(entry => entry.parentId === symbol.id)
      : [];
    const owners: readonly SymbolEntry[] = members.length > 0 ? [symbol, ...members] : [symbol];

    const ownerIds = new Set(owners.map(owner => owner.id));

    const union = (
      pick: (id: string) => readonly GraphEdge[],
      otherEnd: (edge: GraphEdge) => string
    ): { edges: GraphEdge[]; fromMembers: number } => {
      const taken = new Set<string>();
      const edges: GraphEdge[] = [];
      let fromMembers = 0;
      for (const owner of owners) {
        for (const edge of pick(owner.id)) {
          const other = otherEnd(edge);
          /*
          | «خود» یعنی خودِ سمبل به‌همراه اعضایش: یک متد که متد دیگر همان
          | کلاس را صدا می‌زند، نه مصرف‌کننده است و نه وابستگی. اگر این
          | صافی نزند، هر کلاسِ چندمتد در `calls` خودش را نشان می‌دهد.
          */
          if (ownerIds.has(other) || taken.has(other)) continue;
          taken.add(other);
          if (owner !== symbol) fromMembers++;
          edges.push(edge);
        }
      }
      return { edges, fromMembers };
    };

    const callUnion = union(id => engine.callees(id, { minConfidence }), edge => edge.to);
    const callerUnion = union(id => engine.callers(id, { minConfidence }), edge => edge.from);

    const calls = callUnion.edges.slice(0, limit).map(edge => this.related(edge.to, edge));
    const calledBy = callerUnion.edges.slice(0, limit).map(edge => this.related(edge.from, edge));
    /* SE-AI-HONESTY (P-06) — members بعد از این متغیر برش می‌خورد؛ flag
       همین‌جا با شمارش کاملِ اعضا محاسبه می‌شود. */
    const truncation = {
      calls: callUnion.edges.length > calls.length,
      calledBy: callerUnion.edges.length > calledBy.length,
      members: members.length > limit,
      any: callUnion.edges.length > calls.length
        || callerUnion.edges.length > calledBy.length
        || members.length > limit,
      limit,
    };

    const referencedBy = (() => {
      const sources = new Set<string>();
      const files = new Set<string>();
      for (const edge of callerUnion.edges) {
        sources.add(edge.from);
        const path = this.reader.getFileById(
          this.reader.getSymbolById(edge.from)?.fileId ?? edge.from
        )?.path;
        if (path) files.add(path);
      }
      return { sources: sources.size, files: files.size };
    })();

    const memberComplexities = members
      .map(entry => entry.complexity)
      .filter((value): value is number => typeof value === 'number');

    /*
    | diagnosticهای همین symbol: آن‌هایی که خطشان داخل بدنه است.
    | فاز ۳۴ آن‌ها را روی `FileEntry` گذاشت؛ اینجا فقط برش
    | می‌خورند.
    */
    const diagnostics = (file?.diagnostics ?? [])
      .filter(entry => entry.line >= symbol.line && entry.line <= symbol.endLine)
      .map(entry => ({ severity: entry.severity, line: entry.line, message: entry.message }));

    return {
      id: symbol.id,
      symbol: displaySymbolName(symbol),
      /* SE-AI-HONESTY (P-06) — counts before the `limit` slice + slice flags. */
      callsCount: callUnion.edges.length,
      calledByCount: callerUnion.edges.length,
      truncated: truncation,
      kind: symbol.kind,
      file: file?.path,
      line: symbol.line,
      endLine: symbol.endLine,
      signature: symbol.signature ?? symbol.name,
      visibility: symbol.visibility ?? 'public',
      exported: symbol.exported ?? false,
      deprecated: symbol.deprecated ?? false,
      documentation: symbol.documentation ?? null,
      complexity: symbol.complexity ?? null,
      referenceCount: symbol.referenceCount ?? null,
      parameters: symbol.parameters ?? [],
      returnType: symbol.returnType ?? null,
      calls,
      calledBy,
      tests: await this.testsFor(symbol),
      /*
      | فیلدهای اختیاری فقط وقتی می‌آیند که داده‌شان هست. صفرِ
      | ساختگی از نبودِ فیلد بدتر است — شبیه دادهٔ واقعی است.
      */
      ...(file?.gitMetrics
        ? {
            git: {
              commitCount: file.gitMetrics.commitCount,
              hotspotScore: file.gitMetrics.hotspotScore,
            },
          }
        : {}),
      ...(file?.aiMetadata?.aiScore
        ? {
            aiScore: {
              importance: file.aiMetadata.aiScore.importance,
              hotness: file.aiMetadata.aiScore.hotness,
              readPriority: file.aiMetadata.aiScore.readPriority,
            },
          }
        : {}),
      ...(members.length > 0
        ? {
            memberCount: members.length,
            members: members.slice(0, limit).map(entry => ({
              id: entry.id,
              name: entry.name,
              kind: entry.kind,
              line: entry.line,
              visibility: entry.visibility ?? 'public',
              signature: entry.signature ?? entry.name,
              complexity: entry.complexity ?? null,
              exported: entry.exported ?? false,
            })),
            /*
            | «چقدر پیچیده است» برای کلاس پرسیده می‌شود، نه برای اعلان خالیِ
            | آن. جمع اعضا همان پاسخ است؛ null یعنی عددی در کار نبوده.
            */
            aggregateComplexity: memberComplexities.length > 0
              ? memberComplexities.reduce((sum, value) => sum + value, 0)
              : null,
          }
        : {}),
      ...(symbol.kind === 'class' || members.length > 0 ? { referencedBy } : {}),
      ...(callUnion.fromMembers + callerUnion.fromMembers > 0
        ? {
            aggregation: {
              owners: owners.length,
              fromMembers: callUnion.fromMembers + callerUnion.fromMembers,
            },
          }
        : {}),
      diagnostics,
      /*
      | نبودِ diagnostics دو معنی دارد و مصرف‌کننده باید فرقش را بداند:
      | یا زبان‌سرور اجرا نشده، یا اجرا شده و چیزی پیدا نکرده — و یک حالت
      | سوم هم هست: اجرا شده، ولی فایل *بعد از* آن مرحله عوض شده و یافته‌های
      | کهنه‌اش پاک شده (SE-INC-11). «نبود» را «تمیز» خواندن، همان خطایی است
      | که SE-EXP-14 برای هشدارهای استخراج بست. هیچ‌کدام از این سه نیازمند
      | فیلد تازه نیست: `diagnosticsRun` و `file.modified` در خود داده هست.
      */
      ...(() => {
        const note = diagnosticsCaveat(this.reader.projectIndex, file?.modified);
        return note ? { diagnosticsNote: note } : {};
      })(),
      confidence: {
        symbol: symbol.confidence,
        source: symbol.source,
        calls: summarize(calls),
        calledBy: summarize(calledBy),
        weakCalls: calls.filter(entry => entry.confidence < HIGH_CONFIDENCE_THRESHOLD).length,
        weakCalledBy: calledBy.filter(entry => entry.confidence < HIGH_CONFIDENCE_THRESHOLD).length,
      },
    };
  }

  private async testsFor(
    symbol: SymbolEntry
  ): Promise<{ path: string; reason: string }[]> {
    const file = this.reader.getFileById(symbol.fileId);
    const result = await this.tests.execute({
      symbolId: symbol.id,
      path: file?.path,
      fileId: symbol.fileId,
    });
    if (!result.success) return [];
    return result.items
      .filter((item): item is typeof item & { path: string } => typeof item.path === 'string')
      .map(item => ({ path: item.path, reason: item.source }));
  }

  private related(nodeId: string, edge: GraphEdge): RelatedSymbol {
    const symbol = this.reader.getSymbolById(nodeId);
    const file = symbol
      ? this.reader.getFileById(symbol.fileId)
      : this.reader.getFileById(nodeId);

    return {
      id: nodeId,
      /*
      | مقصدی که symbol نیست، یا یک فایل است (فراخوانی سطح ماژول،
      | فاز ۳۷) یا فقط یک نام خارجی مثل `console.log`. هر دو حالت
      | همان‌طور که هستند گزارش می‌شوند.
      */
      name: symbol ? displaySymbolName(symbol) : file?.path || nodeId,
      path: file?.path,
      line: symbol?.line,
      basis: edge.basis,
      confidence: edge.confidence,
    };
  }
}
