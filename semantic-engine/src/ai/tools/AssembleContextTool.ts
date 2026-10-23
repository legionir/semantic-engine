/**
 * AssembleContextTool — جمع‌آوری context بهینه برای یک task.
 *
 * ## بازنویسی فاز ۴۲ (GAP-06 + GAP-07)
 *
 * نسخهٔ قبلی یک آرایهٔ رشته می‌ساخت، بخش‌ها را به ترتیب ثابت پشت هم
 * می‌چسباند، و در پایان از انتها می‌بُرید. سه پیامد داشت که هر سه
 * روی ایندکس واقعی اندازه‌گیری شدند:
 *
 * - «تست‌های مرتبط» آخرین بخش بود، پس با بودجهٔ ۴۰۰ توکن همیشه اولین
 *   قربانی می‌شد — حتی وقتی مرتبط‌ترین چیزِ موجود بود.
 * - هیچ آیتمی امتیاز نداشت. ترتیب، ترتیبِ *پیمایش* بود نه ترتیبِ
 *   *ربط*. سیگنال‌هایی که موتور می‌ساخت (`aiScore`, `hotspotScore`,
 *   `churnRank`, `complexity`, `testIds`) اینجا اصلاً خوانده نمی‌شدند.
 * - `includeRecentChanges` هرگز چیزی برنمی‌گرداند (SE-AI-05).
 *
 * حالا مسیر این است:
 *
 * ```
 * دانه‌ها ─▶ GraphQueryEngine.subgraph ─▶ فاصلهٔ گرافی هر نامزد
 *                                          │
 *                       سیگنال‌های ایندکس ─┴─▶ ContextRanker ─▶ امتیاز ۰..۱
 *                                                                │
 *                                        بخش‌های امتیازدار ─▶ TokenBudget
 * ```
 *
 * `TokenBudget` به‌جای بریدن از انتها، بر اساس امتیاز انتخاب می‌کند و
 * به بخش‌های «هدف» و «تست» سهم تضمین‌شده می‌دهد.
 */

import * as path from 'path';

import { AiTool, AiToolInput, AiToolOutput, AiToolResultItem } from './types';
import { ProjectIndexReader } from '../ProjectIndexReader';
import type { IEmbeddingGenerator } from '../../vector/EmbeddingGenerator';
import { ContextDiscoverer } from '../discovery/ContextDiscoverer';
import type { BlueprintIndex } from '../discovery/BlueprintIndex';
import { GitClient } from '../../core/git/GitClient';
import { GraphQueryEngine } from '../../graphs/GraphQueryEngine';
import { ContextRanker, RankCandidate, RankedCandidate } from '../ranking/ContextRanker';
import { BudgetSection, TokenBudget, estimateTokens } from '../ranking/TokenBudget';
import type { FileEntry, SymbolEntry } from '../../core/types/project-index.types';

/*
| نمادهای کم‌اطلاعات: یک property/constant/variable که خودِ پرس‌وجو نامزدش
| نکرده، برای ایجنت ارزش خبری ندارد و فقط context را پُر و توکن را می‌سوزاند.
| در گسترشِ همسایگی حذف می‌شوند، مگر آن‌که جست‌وجو صریحاً آن را نامزد کرده باشد.
*/
const TRIVIAL_SYMBOL_KINDS: ReadonlySet<string> = new Set(['property', 'constant', 'variable']);

export interface AssembleContextInput extends AiToolInput {
  readonly task: string;
  readonly targetFiles?: readonly string[];
  readonly targetSymbols?: readonly string[];
  readonly maxTokens?: number;
  readonly includeTests?: boolean;
  readonly includeRecentChanges?: boolean;
  readonly dependencyDepth?: number;
}

export interface AssembleContextOptions {
  /**
   * ریشهٔ مطلقِ workspace برای دستورات git.
   *
   * اگر داده نشود، `projectIndex.rootPath` استفاده می‌شود. اینکه
   * سازنده بتواند صریح بگوید، برای مصرف‌کننده‌هایی لازم است که ایندکس
   * را از جای دیگری خوانده‌اند (`AiToolRegistry` دقیقاً همین حالت را
   * دارد و `workspaceRoot` اش تا فاز ۴۲ به این ابزار نمی‌رسید).
   */
  readonly workspaceRoot?: string;
  /**
   * blueprint، اگر در دسترس باشد، به‌عنوان منبع دوم برای کشف نامزد
   * استفاده می‌شود (GAP-04 / SE-BP-06).
   */
  readonly blueprint?: BlueprintIndex;
}

/** بخشی از context، همراه با سهم تضمین‌شده‌اش. */
type SectionName =
  | 'targetFiles'
  | 'targetSymbols'
  | 'relatedFiles'
  | 'relatedSymbols'
  | 'tests'
  | 'recentChanges';

interface Entity {
  readonly id: string;
  readonly section: SectionName;
  readonly name: string;
  readonly kind: string;
  readonly path?: string;
  readonly line?: number;
  readonly text: string;
  readonly hops: number | null;
}

const SECTION_HEADERS: Readonly<Record<SectionName, string>> = {
  targetFiles: '=== Target Files ===',
  targetSymbols: '=== Target Symbols ===',
  relatedFiles: '=== Related Files ===',
  relatedSymbols: '=== Related Symbols ===',
  tests: '=== Related Tests ===',
  recentChanges: '=== Recent Changes ===',
};

/*
| سهم‌های تضمین‌شده.
|
| «هدف» تضمین دارد چون بدون آن، کل خروجی می‌تواند دربارهٔ همسایه‌ها
| باشد و خودِ چیزی که قرار است تغییر کند بیفتد. «تست» تضمین دارد چون
| معیار پذیرش فاز ۴۲ همین است و چون آخرین بخش است — یعنی دقیقاً همان
| جایی که برشِ از انتها می‌خورد.
|
| بخش‌های بدون تضمین در پاس دومِ بودجه، آزادانه رقابت می‌کنند.
*/
const SECTION_GUARANTEE: Readonly<Partial<Record<SectionName, number>>> = {
  targetFiles: 0.2,
  targetSymbols: 0.1,
  tests: 0.15,
  /*
  | SE-AI-18 — «تغییرات اخیر» تضمین می‌گیرد چون **صریحاً درخواست
  | شده** است (`includeRecentChanges` پیش‌فرضش false است). بدون
  | تضمین، سطرهای commit امتیازِ صفر می‌گیرند — رتبه‌بند دربارهٔ یک
  | سطر commit هیچ سیگنالی ندارد و صادقانه چیزی نمی‌گوید — و در
  | استخر سراسری همیشه آخر می‌ایستند.
  |
  | اندازه‌گیری‌ای که این را لازم کرد: با بودجهٔ ۲۰۰ توکن یک سطر
  | commit می‌آمد و با بودجهٔ ۴۰۰ توکن هیچ سطری. یعنی بودجهٔ بیشتر،
  | خروجی کمتر.
  */
  recentChanges: 0.1,
};

const SECTION_ORDER: readonly SectionName[] = [
  'targetFiles',
  'targetSymbols',
  'relatedFiles',
  'relatedSymbols',
  'tests',
  'recentChanges',
];

export class AssembleContextTool implements AiTool<AssembleContextInput> {
  readonly name = 'assemble_context';
  readonly description =
    'Assemble a token-optimized context for a coding task. Items are ranked by keyword match, graph distance, and the index own importance/hotness/churn signals; the budget guarantees a share to targets and tests instead of truncating from the end.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Description of the coding task' },
      targetFiles: { type: 'array', items: { type: 'string' }, description: 'Relative paths of target files' },
      targetSymbols: { type: 'array', items: { type: 'string' }, description: 'Symbol ids of target symbols' },
      maxTokens: { type: 'integer', default: 4000 },
      includeTests: { type: 'boolean', default: true },
      includeRecentChanges: { type: 'boolean', default: false },
      dependencyDepth: { type: 'integer', default: 1 },
    },
    required: ['task'],
  };

  private readonly ranker = new ContextRanker();
  private readonly budget = new TokenBudget();
  private graph: GraphQueryEngine | null = null;
  private discovererInstance: ContextDiscoverer | null = null;

  constructor(
    private readonly reader: ProjectIndexReader,
    private readonly embeddingGenerator?: IEmbeddingGenerator,
    private readonly options: AssembleContextOptions = {}
  ) {}

  private discoverer(): ContextDiscoverer {
    if (!this.discovererInstance) {
      this.discovererInstance = new ContextDiscoverer(this.reader, {
        ...(this.options.blueprint ? { blueprint: this.options.blueprint } : {}),
        ...(this.embeddingGenerator ? { embeddingGenerator: this.embeddingGenerator } : {}),
      });
    }
    return this.discovererInstance;
  }

  async execute(input: AssembleContextInput): Promise<AiToolOutput> {
    try {
      if (typeof input.task !== 'string' || input.task.trim().length === 0) return { success: false, error: 'task is required and must be a non-empty string', items: [] };
      if (input.targetFiles !== undefined && (!Array.isArray(input.targetFiles) || input.targetFiles.some(file => typeof file !== 'string'))) return { success: false, error: 'targetFiles must be an array of strings', items: [] };
      if (input.targetSymbols !== undefined && (!Array.isArray(input.targetSymbols) || input.targetSymbols.some(symbol => typeof symbol !== 'string'))) return { success: false, error: 'targetSymbols must be an array of strings', items: [] };
      if (input.maxTokens !== undefined && (!Number.isInteger(input.maxTokens) || input.maxTokens < 1)) return { success: false, error: 'maxTokens must be a positive integer', items: [] };
      if (input.dependencyDepth !== undefined && (!Number.isInteger(input.dependencyDepth) || input.dependencyDepth < 1)) return { success: false, error: 'dependencyDepth must be a positive integer', items: [] };
      if (input.includeTests !== undefined && typeof input.includeTests !== 'boolean') return { success: false, error: 'includeTests must be a boolean', items: [] };
      if (input.includeRecentChanges !== undefined && typeof input.includeRecentChanges !== 'boolean') return { success: false, error: 'includeRecentChanges must be a boolean', items: [] };

      const maxTokens = input.maxTokens ?? 4000;
      const includeTests = input.includeTests ?? true;
      const includeRecentChanges = input.includeRecentChanges ?? false;
      const dependencyDepth = input.dependencyDepth ?? 1;

      const targetFiles = (input.targetFiles ?? [])
        .map(p => this.reader.getFileByPath(p))
        .filter((f): f is FileEntry => !!f);

      const targetSymbols = (input.targetSymbols ?? [])
        .map(id => this.reader.getSymbolById(id))
        .filter((s): s is SymbolEntry => !!s);

      const seeds = [...targetFiles.map(f => f.id), ...targetSymbols.map(s => s.id)];

      /*
      | فاصلهٔ گرافی از یک پیمایش BFS می‌آید (فاز ۳۹). نسخهٔ قبلی
      | `GetDependenciesTool` را دو بار صدا می‌زد — یک‌بار forward و
      | یک‌بار backward — و آن ابزار DFS با سقف است، پس نه عمق
      | برمی‌گرداند و نه تضمین می‌کند نزدیک‌ترین‌ها را دیده باشد.
      */
      const hopsById = new Map<string, number>();
      if (seeds.length > 0) {
        const graph = this.graphEngine();
        const sub = graph.subgraph(seeds, {
          direction: 'both',
          depth: dependencyDepth,
          maxNodes: 400,
        });
        for (const node of sub.nodes) {
          const previous = hopsById.get(node.id);
          if (previous === undefined || node.depth < previous) hopsById.set(node.id, node.depth);
        }
      }

      const keywordById = new Map<string, number>();
      let searchSeeded = false;

      if (seeds.length === 0) {
        /*
        | بدون هدف صریح، کشف را به `ContextDiscoverer` می‌سپاریم
        | (فاز ۴۳). نسخهٔ قبلی همین‌جا `semantic_search` می‌کرد و
        | نتیجه‌اش را با `hops = 1` ثابت می‌گذاشت — یعنی «فاصلهٔ
        | گرافی» یک عددِ ساختگی بود، نه چیزی که پیمایش شده باشد. و
        | چون گسترشی در کار نبود، هیچ فایلی که نامش با task هم‌خوان
        | نبود دیده نمی‌شد.
        */
        const discovery = await this.discoverer().discover({
          task: input.task,
          /* A larger budget can hold more candidates; a fixed 30 left most of an 8k budget unused. */
          limit: Math.min(80, Math.max(30, Math.floor(maxTokens / 100))),
          expansionDepth: dependencyDepth + 1,
          ...(includeTests ? { includeTests: true } : {}),
        });

        for (const candidate of discovery.candidates) {
          hopsById.set(candidate.id, candidate.hops);
          if (candidate.origin === 'search') keywordById.set(candidate.id, candidate.score);
        }
        searchSeeded = true;
      }

      const seedSet = new Set(seeds);
      const entities: Entity[] = [];

      for (const f of targetFiles) {
        entities.push(this.fileEntity(f, 'targetFiles', 0));
      }
      for (const s of targetSymbols) {
        entities.push(this.symbolEntity(s, 'targetSymbols', 0));
      }

      for (const [id, hops] of hopsById) {
        if (seedSet.has(id)) continue;
        const f = this.reader.getFileById(id);
        if (f) {
          // فایل‌های تستی به بخش خودشان می‌روند، نه به «مرتبط».
          if (f.testFile) continue;
          entities.push(this.fileEntity(f, 'relatedFiles', hops));
          continue;
        }
        const s = this.reader.getSymbolById(id);
        if (s) {
          // نمادِ کم‌اطلاعاتِ ناخواسته وارد context نمی‌شود (بالا را ببین).
          if (TRIVIAL_SYMBOL_KINDS.has(s.kind) && !keywordById.has(s.id)) continue;
          entities.push(this.symbolEntity(s, 'relatedSymbols', hops));
        }
      }

      if (includeTests) {
        for (const testFile of this.findRelatedTests(targetFiles, targetSymbols)) {
          entities.push(this.fileEntity(testFile, 'tests', hopsById.get(testFile.id) ?? null));
        }
      }

      let recentChangesNote: string | undefined;
      if (includeRecentChanges) {
        const outcome = await this.recentChanges();
        recentChangesNote = outcome.note;
        outcome.lines.forEach((line, i) => {
          entities.push({
            id: `commit-${i}`,
            section: 'recentChanges',
            name: line,
            kind: 'commit',
            text: line,
            // یک commit فاصلهٔ گرافی ندارد؛ `null` یعنی «اندازه‌گیری
            // نشده» و رتبه‌بند وزنش را بازتوزیع می‌کند.
            hops: null,
          });
        });
      }

      const ranked = this.rankEntities(entities, keywordById, searchSeeded);

      const sections = this.buildSections(entities, ranked);
      const assembled = this.budget.assemble(sections, {
        maxTokens,
        preamble: `Task: ${input.task}`,
      });

      const keptIds = new Set<string>();
      for (const section of assembled.sections) {
        for (const id of section.keptIds) keptIds.add(id);
      }

      const items: AiToolResultItem[] = ranked
        .filter(r => keptIds.has(r.id) && r.payload!.section !== 'recentChanges')
        .map(r => {
          const entity = r.payload!;
          return {
            id: entity.id,
            name: entity.name,
            kind: entity.kind,
            ...(entity.path ? { path: entity.path } : {}),
            ...(entity.line !== undefined ? { line: entity.line } : {}),
            relevanceScore: Math.round(r.score * 1000) / 1000,
            source: entity.section.startsWith('target') ? 'target' : 'index',
            metadata: {
              section: entity.section,
              graphHops: entity.hops,
              signals: r.contributions.map(c => c.signal),
            },
          };
        });

      const byName = new Map(assembled.sections.map(s => [s.name, s]));

      return {
        success: true,
        items,
        context: assembled.text,
        metadata: {
          targetFiles: byName.get('targetFiles')?.kept ?? 0,
          targetSymbols: byName.get('targetSymbols')?.kept ?? 0,
          relatedFiles: byName.get('relatedFiles')?.kept ?? 0,
          relatedSymbols: byName.get('relatedSymbols')?.kept ?? 0,
          tests: byName.get('tests')?.kept ?? 0,
          estimatedTokens: assembled.usedTokens,
          maxTokens,
          truncated: assembled.truncated,
          budget: {
            usedTokens: assembled.usedTokens,
            maxTokens: assembled.maxTokens,
            sections: assembled.sections,
          },
          ...(recentChangesNote ? { recentChanges: recentChangesNote } : {}),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        items: [],
      };
    }
  }

  private graphEngine(): GraphQueryEngine {
    if (!this.graph) this.graph = new GraphQueryEngine(this.reader.projectIndex);
    return this.graph;
  }

  /**
   * سیگنال‌های خام هر موجودیت را از ایندکس بیرون می‌کشد.
   *
   * این تابع همان جایی است که GAP-06 دربارهٔ آن نوشته بود «موتور
   * این‌ها را محاسبه می‌کند و دور می‌ریزد».
   */
  private rankEntities(
    entities: readonly Entity[],
    keywordById: ReadonlyMap<string, number>,
    searchSeeded: boolean
  ): RankedCandidate<Entity>[] {
    const churnRanks: number[] = [];
    for (const f of this.reader.getAllFiles()) {
      const rank = f.gitMetrics?.churnRank;
      if (typeof rank === 'number') churnRanks.push(rank);
    }
    const churnRankOutOf = churnRanks.length > 0 ? Math.max(...churnRanks) : undefined;

    const candidates: RankCandidate<Entity>[] = entities.map(entity => {
      const symbol = this.reader.getSymbolById(entity.id);
      const file = symbol
        ? this.reader.getFileById(symbol.fileId)
        : this.reader.getFileById(entity.id);

      const aiScore = file?.aiMetadata?.aiScore;
      const git = file?.gitMetrics;

      return {
        id: entity.id,
        payload: entity,
        signals: {
          ...(searchSeeded ? { keyword: keywordById.get(entity.id) ?? null } : {}),
          graphHops: entity.hops,
          referenceCount: symbol ? symbol.referenceCount ?? null : null,
          importance: aiScore?.importance ?? null,
          hotness: aiScore?.hotness ?? null,
          readPriority: aiScore?.readPriority ?? null,
          hotspotScore: git?.hotspotScore ?? null,
          churnRank: git?.churnRank ?? null,
          complexity: symbol?.complexity ?? null,
          testCount: symbol?.testIds?.length ?? null,
          exported: symbol?.exported ?? null,
        },
      };
    });

    return this.ranker.rank<Entity>(candidates, { churnRankOutOf });
  }

  private buildSections(
    entities: readonly Entity[],
    ranked: readonly RankedCandidate<Entity>[]
  ): BudgetSection[] {
    const scoreById = new Map(ranked.map(r => [r.id, r.score]));

    return SECTION_ORDER.map(name => {
      const items = entities
        .filter(e => e.section === name)
        .map(e => ({ id: e.id, text: e.text, score: scoreById.get(e.id) ?? 0 }));

      const guarantee = SECTION_GUARANTEE[name];
      return {
        name,
        header: SECTION_HEADERS[name],
        items,
        ...(guarantee !== undefined ? { guarantee } : {}),
      };
    }).filter(section => section.items.length > 0);
  }

  private fileEntity(file: FileEntry, section: SectionName, hops: number | null): Entity {
    return {
      id: file.id,
      section,
      name: file.path,
      kind: 'file',
      path: file.path,
      text: this.summarizeFile(file),
      hops,
    };
  }

  private symbolEntity(symbol: SymbolEntry, section: SectionName, hops: number | null): Entity {
    return {
      id: symbol.id,
      section,
      name: symbol.name,
      kind: symbol.kind,
      path: this.reader.getFileById(symbol.fileId)?.path,
      line: symbol.line,
      text: this.summarizeSymbol(symbol),
      hops,
    };
  }

  /**
   * SE-AI-05.
   *
   * قبلاً: `new GitClient(path.dirname(targetFiles[0].path))`. مقدار
   * `path` در ایندکس نسبی است، پس `cwd` نامعتبر می‌شد، `git` خطا
   * می‌داد و `catch` بی‌صدا ردش می‌کرد — یعنی قابلیت اعلام‌شده هرگز
   * چیزی برنمی‌گرداند و مصرف‌کننده هم خبردار نمی‌شد.
   *
   * حالا ریشهٔ مطلق از `options.workspaceRoot` یا `rootPath` ایندکس
   * می‌آید، و اگر هیچ‌کدام نبود، **در متادیتا اعلام می‌شود**. سکوت،
   * همان چیزی بود که باگ را دو سال زنده نگه داشت.
   */
  private async recentChanges(): Promise<{ lines: string[]; note?: string }> {
    const root = this.options.workspaceRoot ?? this.reader.projectIndex.rootPath;

    if (!root) return { lines: [], note: 'unavailable: no workspace root' };
    if (!path.isAbsolute(root)) {
      return { lines: [], note: `unavailable: workspace root is not absolute (${root})` };
    }

    try {
      const commits = await new GitClient(root).getLog(5);
      if (commits.length === 0) return { lines: [], note: 'no commits found' };
      return {
        lines: commits.map(c => `- ${c.date} | ${c.author}: ${c.message.split('\n')[0]}`),
      };
    } catch (error) {
      return {
        lines: [],
        note: `unavailable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private summarizeFile(file: FileEntry): string {
    const summary = file.aiMetadata?.summary ?? '';
    return `- ${file.path} (${file.language ?? 'unknown'}, ${file.lines} lines)${summary ? ': ' + summary : ''}`;
  }

  private summarizeSymbol(symbol: SymbolEntry): string {
    const file = this.reader.getFileById(symbol.fileId);
    return `- ${symbol.kind} ${symbol.name} (${file?.path}:${symbol.line}): ${symbol.signature ?? ''}`;
  }

  private findRelatedTests(
    files: readonly FileEntry[],
    symbols: readonly SymbolEntry[]
  ): FileEntry[] {
    const paths = new Set(files.map(f => f.path));
    for (const sym of symbols) {
      const file = this.reader.getFileById(sym.fileId);
      if (file) paths.add(file.path);
    }

    const found: FileEntry[] = [];
    for (const file of this.reader.getAllFiles()) {
      if (!file.testFile) continue;
      for (const p of paths) {
        const base = p.replace(/\.[^.]+$/, '');
        if (file.path.toLowerCase().includes(base.toLowerCase())) {
          found.push(file);
          break;
        }
      }
    }
    return found;
  }
}

/** برای مصرف‌کننده‌هایی که می‌خواهند پیش از فراخوانی، بودجه را تخمین بزنند. */
export { estimateTokens };
