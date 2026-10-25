/**
 * تایپ‌های TypeScript مستقیماً derive شده از contracts/project-index.schema.json v2.0.0
 *
 * قانون: هر تغییر در schema باید اینجا منعکس شود.
 * هیچ تایپ schema-related ای خارج از این فایل تعریف نمی‌شود.
 */

import { ExtractionSource, Confidence } from './common.types';

// ─── Root ────────────────────────────────────────────────────────────────────

export interface LanguageSupportEntry {
  readonly symbols: 'full' | 'structural' | 'heuristic';
  readonly callGraph: boolean;
}

export interface ProjectIndex {
  readonly schemaVersion: '2.0.0';
  /**
   * نام کوتاه پروژه — همان `basename` ریشه. مصرف‌کننده‌ها (مثل
   * `BlueprintGenerator`) از آن به‌عنوان *نام* استفاده می‌کنند.
   */
  readonly root: string;
  /**
   * مسیر مطلق واقعی ریشه — SE-EXP-05.
   *
   * `root` نمی‌تواند هر دو نقش را بازی کند. `cli.ts` همان `root` را
   * به‌عنوان `workspaceRoot` به سرور MCP می‌داد، یعنی سرور فقط نام
   * یک پوشه را داشت نه مسیری که بشود از آن فایل خواند.
   */
  readonly rootPath?: string;
  readonly generatedAt: string; // ISO 8601
  readonly generatorVersion?: string;
  readonly languages: readonly string[];
  /**
   * سطح پشتیبانی هر زبان — SE-SYM-16 و SE-GRAPH-08.
   *
   * بدون این، «این فایل تابعی ندارد» و «توابعِ این زبان را
   * نمی‌فهمم» برای مصرف‌کننده یک شکل دارند.
   */
  readonly languageSupport?: Readonly<Record<string, LanguageSupportEntry>>;
  readonly incremental?: IncrementalInfo;
  /**
   * نتیجهٔ مرحلهٔ diagnostics زبان‌سرور (فاز ۳۴).
   *
   * **فقط وقتی نوشته می‌شود که آن مرحله واقعاً اجرا شده باشد.** نبودش یعنی
   * «بررسی نشده»، نه «چیزی پیدا نشد» — همان تفکیکی که برای `incremental` و
   * `languageSupport` رعایت شده و برای diagnostics رعایت نمی‌شد.
   */
  readonly diagnosticsRun?: DiagnosticsRunInfo;
  readonly git?: GitInfo;
  readonly files: readonly FileEntry[];
  readonly symbols: readonly SymbolEntry[];
  readonly graphs: Graphs;
  readonly diagnostics: readonly Diagnostic[];
  readonly metrics: ProjectMetrics;
  readonly vectorChunks?: readonly VectorChunk[]; // optional — فاز ۸
}

// ─── Incremental ─────────────────────────────────────────────────────────────

export interface IncrementalInfo {
  readonly mode: 'full' | 'incremental';
  readonly baseGeneratedAt: string | null;
  readonly changedFileIds: readonly string[];
  readonly removedFileIds: readonly string[];
}

// ─── Git ─────────────────────────────────────────────────────────────────────

export interface GitInfo {
  readonly commit: string;
  readonly branch: string;
  readonly isDirty: boolean;
  readonly remoteUrl: string | null;
}

// ─── File Entry ──────────────────────────────────────────────────────────────

export type FileRole =
  | 'service' | 'controller' | 'repository' | 'model'
  | 'util' | 'config' | 'test' | 'component' | 'hook'
  | 'middleware' | 'type-definition' | 'entrypoint' | 'unknown';

export interface FileEntry {
  readonly id: string;        // شناسه‌ی پایدار فایل، معمولاً hash(relativePath)
  readonly path: string;      // relative to root
  readonly language: string | null;
  readonly encoding: string;  // default: 'utf8'
  readonly size: number;      // bytes
  readonly lines: number;
  readonly hash: string;      // sha1 محتوا — برای staleness detection
  readonly modified: string;  // ISO 8601
  readonly binary: boolean;
  /**
   * محتوا برای تحلیل بریده شده چون فایل از `maxFileSizeBytes` بزرگ‌تر
   * بود.
   *
   * `hash` همچنان روی **کل** فایل محاسبه می‌شود — نبودن این تضمین
   * همان چیزی بود که تشخیص staleness را برای فایل‌های بزرگ از کار
   * می‌انداخت (SE-SCAN-01). ولی symbol و متریک از یک تکه آمده‌اند و
   * ناقص‌اند؛ این پرچم به مصرف‌کننده می‌گوید به آن‌ها تکیه نکند.
   */
  readonly truncated?: boolean;
  readonly role?: FileRole;
  readonly entryPoint?: boolean;
  readonly testFile: boolean;
  readonly generated: boolean;

  readonly exports?: readonly ExportEntry[];
  readonly imports?: readonly ImportEntry[];
  readonly symbolIds?: readonly string[];
  readonly diagnostics?: readonly Diagnostic[];
  readonly outline?: readonly string[];
  readonly metrics?: FileMetrics;
  readonly gitMetrics?: GitFileMetrics;
  readonly configUsages?: readonly ConfigUsageEntry[];
  readonly lsp?: LspInfo;
  readonly aiMetadata?: AiMetadata;
  readonly blueprintRef?: { readonly moduleId: string | null };
}

// ─── Export / Import ─────────────────────────────────────────────────────────

export interface ExportEntry {
  readonly name: string;
  readonly kind: 'named' | 'default' | 're-export' | 'namespace';
  readonly symbolId?: string | null;
  readonly reExportFrom?: string | null;
  /** صادرات صرفاً تایپی (`export type { … }`). */
  readonly typeOnly?: boolean;
}

export interface ImportSpecifier {
  readonly imported: string;
  readonly local?: string;
  readonly isDefault?: boolean;
  readonly isNamespace?: boolean;
}

export interface ImportEntry {
  readonly from: string;
  readonly type: 'package' | 'local' | 'builtin';
  readonly resolvedFileId?: string | null; // پر می‌شود در فاز ۴
  readonly specifiers?: readonly ImportSpecifier[];
  readonly dynamic?: boolean;
  /**
   * وابستگی صرفاً تایپی (`import type { … }`).
   *
   * چنین وابستگی‌ای در زمان اجرا وجود ندارد. علامت‌نزدنش یعنی گراف
   * یال‌هایی دارد که هرگز اجرا نمی‌شوند، و هر تحلیل «اگر این را عوض
   * کنم چه می‌شکند» بیش از حد بدبین می‌شود (SE-DEP-07).
   */
  readonly typeOnly?: boolean;
}

// ─── Symbol Entry ────────────────────────────────────────────────────────────

export type SymbolKind =
  | 'class' | 'interface' | 'enum' | 'struct' | 'trait'
  | 'function' | 'method' | 'variable' | 'constant'
  | 'namespace' | 'module' | 'property' | 'type-alias' | 'decorator';

export type SymbolVisibility = 'public' | 'private' | 'protected' | 'internal';

export interface Parameter {
  readonly name: string;
  readonly type: string | null;
  readonly optional?: boolean;
  readonly defaultValue?: string | null;
  readonly rest?: boolean;
}

export interface SymbolEntry {
  readonly id: string;          // hash(fileId + fqName + kind) یا مشابه
  readonly fileId: string;      // → FileEntry.id
  readonly parentId: string | null;

  readonly kind: SymbolKind;
  readonly name: string;
  readonly fullyQualifiedName?: string;
  readonly signature?: string;
  readonly visibility?: SymbolVisibility;
  readonly line: number;        // 1-based
  readonly endLine: number;     // 1-based
  readonly documentation?: string | null;
  readonly deprecated?: boolean;
  readonly exported?: boolean;

  readonly async?: boolean;
  readonly generator?: boolean;
  readonly abstract?: boolean;
  readonly static?: boolean;
  readonly readonly?: boolean;

  readonly parameters?: readonly Parameter[];
  readonly returnType?: string | null;
  readonly throws?: readonly string[];
  readonly sideEffects?: boolean | null;

  readonly generics?: readonly string[];
  readonly extends?: readonly string[];
  readonly implements?: readonly string[];

  readonly complexity?: number | null;
  readonly referenceCount?: number | null;

  readonly calls?: readonly string[];
  readonly calledBy?: readonly string[];
  readonly testIds?: readonly string[];

  readonly source: ExtractionSource;
  readonly confidence: Confidence;
}

// ─── Graphs ──────────────────────────────────────────────────────────────────

export interface Graphs {
  readonly callGraph: readonly CallEdge[];
  readonly typeGraph: readonly TypeEdge[];
  readonly dependencyGraph: readonly DependencyEdge[];
  readonly reverseDependencyGraph?: readonly ReverseDependencyEdge[];
}

/**
 * از کجا آمدن یک یال و چقدر می‌شود به آن اعتماد کرد.
 *
 * بدون این، یالی که از «اولین symbol هم‌نام در کل پروژه» ساخته شده از
 * یالی که مستقیم از AST خوانده شده قابل تشخیص نیست. تعریف کامل و
 * جدول اعتماد در `graphs/EdgeProvenance.ts`.
 */
export interface EdgeProvenance {
  readonly extractor: 'lsp' | 'tree-sitter' | 'typescript-api' | 'heuristic';
  readonly confidence: number;
  /*
  | همین اتحاد در `src/graphs/EdgeProvenance.ts` هم هست (آن‌جا با
  | نام `EdgeBasis`) و هر دو باید با هم حرکت کنند. افزودن
  | `resolved` در فاز ۳۷ فقط در یک طرف انجام شد و کامپایلر گرفت —
  | که تنها دلیل امن بودن این تکرار است.
  */
  readonly basis:
    | 'resolved'
    | 'ast'
    | 'import-resolved'
    | 'declared'
    | 'name-match'
    | 'unresolved';
  readonly location?: { readonly file: string; readonly line: number };
}

export interface CallEdge {
  readonly id: string;
  /**
   * symbolId — یا fileId وقتی فراخوانی در سطح ماژول است و داخل هیچ
   * symbolای نمی‌افتد. `callerKind` می‌گوید کدام است.
   *
   * SE-GRAPH-02: تا فاز ۳۷ اینجا فقط نوشته بود «symbolId» و در عمل
   * روی همین مخزن **۵۷٪** یال‌ها fileId بودند (۹٬۹۰۶ از ۱۷٬۴۸۵).
   * مصرف‌کننده‌ای که به توضیح اعتماد می‌کرد، همه را بی‌صدا دور
   * می‌ریخت.
   */
  readonly caller: string;
  /** پیش‌فرض `symbol`؛ `file` یعنی فراخوانی در سطح ماژول است. */
  readonly callerKind?: 'symbol' | 'file';
  readonly callee: string;  // symbolId or external name
  readonly kind: 'direct' | 'conditional' | 'async' | 'callback' | 'external' | 'recursive';
  readonly line?: number | null;
  readonly provenance: EdgeProvenance;
}

export interface TypeEdge {
  readonly parent: string;  // symbolId
  readonly child: string;   // symbolId
  readonly kind: 'extends' | 'implements';
  readonly provenance: EdgeProvenance;
}

export interface DependencyEdge {
  readonly from: string;  // fileId
  /** fileId، یا `pkg:<name>` برای هرچه فایلِ این پروژه نیست. */
  readonly to: string;
  readonly kind: 'import' | 'package' | 'dynamic-import';
  readonly provenance: EdgeProvenance;
}

export interface ReverseDependencyEdge {
  readonly from: string;  // fileId or symbolId that is depended upon
  readonly to: string;    // fileId or symbolId that depends on it
  readonly kind: 'imported-by' | 'called-by' | 'extends' | 'implements';
  readonly provenance: EdgeProvenance;
}

// ─── Diagnostic ──────────────────────────────────────────────────────────────

export interface Diagnostic {
  readonly severity: 'error' | 'warning' | 'info' | 'hint';
  readonly code?: string | null;
  readonly line: number;
  readonly column?: number | null;
  readonly message: string;
  readonly source: string;
  readonly fileId?: string | null;
}

// ─── Diagnostics Run ─────────────────────────────────────────────────────────

export interface DiagnosticsRunInfo {
  /** فایل‌هایی که دست‌کم یک diagnostic از زبان‌سرور گرفتند. */
  readonly filesWithFindings: number;
  /** فایل‌هایی که به‌خرب رفتن بودجه بررسی نشدند — «نگاه نشده». */
  readonly filesSkippedByBudget: number;
  readonly budgetMs: number;
  /** ISO 8601 — پایان مرحله. */
  readonly completedAt: string;
}

// ─── LSP Info ────────────────────────────────────────────────────────────────

export interface LspInfo {
  readonly available: boolean;
  readonly serverName?: string | null;
  readonly renameSupported?: boolean;
  readonly completionSupported?: boolean;
  readonly hoverSamples?: readonly { symbolId: string; hover: string }[];
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

export interface FileMetrics {
  readonly loc?: number;
  readonly blankLines?: number;
  readonly commentLines?: number;
  readonly classes?: number;
  readonly functions?: number;
  readonly methods?: number;
  readonly imports?: number;
  readonly exports?: number;
  readonly cyclomaticComplexity?: number;
  readonly maxNestingDepth?: number;
  readonly todoCount?: number;
  readonly fixmeCount?: number;
}

export interface GitContributor {
  readonly author: string;
  /**
   * شناسهٔ پایدار نویسنده — SE-GIT-04.
   *
   * تجمیع بر اساس *نام نمایشی* دو نفر هم‌نام را یکی می‌کند، و یک نفر
   * که نامش را عوض کرده را دو نفر. ایمیل در عمل پایدارتر است.
   */
  readonly email: string;
  readonly commitCount: number;
}

export interface GitFileMetrics {
  readonly commitCount: number;
  readonly lastCommitDate?: string;
  readonly lastCommitHash?: string;
  readonly topContributors?: readonly GitContributor[];
  /**
   * churn نرمال‌شده × پیچیدگی نرمال‌شده × ۱۰۰، محدود به ۱۰۰.
   *
   *   churn نرمال‌شده     = commitCount ÷ بیشترین commitCount پروژه
   *   پیچیدگی نرمال‌شده  = max(1, cyclomaticComplexity) ÷ ۱۰
   *
   * SE-GIT-04 فرمول را «کاملاً دلبخواهی و بدون مستند» نامیده بود.
   * دلبخواهی بودنش سر جایش است — هیچ تعریف عینی از «نقطهٔ داغ» وجود
   * ندارد — ولی حالا دست‌کم نوشته شده و مقایسه‌پذیری‌اش روشن است:
   * عدد **نسبی** است و فقط درون یک پروژه معنی دارد.
   */
  readonly hotspotScore: number;
  readonly churnRank?: number;
}

export type ConfigUsageKind =
  | 'env'
  | 'config-get'
  | 'dotenv'
  | 'env-file-reference';

export interface ConfigUsageEntry {
  readonly kind: ConfigUsageKind;
  readonly key: string;
  readonly line: number;
  readonly context?: string;
}

export interface ProjectMetrics {
  readonly totalFiles: number;
  readonly totalLoc: number;
  readonly totalSymbols: number;
  readonly avgCyclomaticComplexity: number;
  readonly languageBreakdown: Readonly<Record<string, number>>;
}

// ─── AI Metadata ─────────────────────────────────────────────────────────────

export interface AiScoreFactors {
  readonly referenceCountWeight?: number;
  readonly recentGitChangeWeight?: number;
  readonly importCountWeight?: number;
  readonly entryPointBonus?: number;
}

export interface AiScore {
  readonly importance: number;    // 0-100
  readonly readPriority: number;  // 0-100
  readonly hotness: number;       // 0-100
  readonly factors?: AiScoreFactors;
}

export interface AiMetadata {
  readonly summary?: string;
  readonly keywords?: readonly string[];
  readonly businessDomains?: readonly string[];
  readonly designPatterns?: readonly string[];
  readonly frameworks?: readonly string[];
  readonly relatedFileIds?: readonly string[];
  readonly estimatedTokenCost?: number;
  readonly aiScore?: AiScore;
}

// ─── Vector Chunk ────────────────────────────────────────────────────────────

export interface VectorChunk {
  /**
   * شناسهٔ **هویتی** — از `fileId` و `symbolId` ساخته می‌شود و به
   * محتوا وابسته نیست (SE-VEC-09).
   *
   * قبلاً هش محتوا داخل شناسه بود، پس کوچک‌ترین ویرایش یعنی «chunk
   * جدید» و embeddingِ قبلی دور ریخته می‌شد. شناسه باید بگوید *این
   * کدام تکه است*؛ اینکه *کهنه شده یا نه* کارِ `contentHash` است.
   */
  readonly id: string;
  readonly fileId: string;
  readonly symbolId?: string | null;
  readonly unit: 'class' | 'interface' | 'function' | 'method' | 'module';
  readonly content: string;
  /** هش محتوا — برای تشخیص کهنگی و استفادهٔ مجدد از embedding. */
  readonly contentHash?: string;
  /** مدلی که این embedding را ساخته؛ تعویض مدل یعنی بی‌اعتباری. */
  readonly embeddingModel?: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly tokenEstimate: number;
  readonly embedding?: readonly number[];
}
