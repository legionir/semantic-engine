/**
 * AiToolRegistry — ثبت و اجرای همه‌ی AI tools.
 */

import * as path from 'path';
import { ProjectIndexReader } from './ProjectIndexReader';
import { GraphSnapshotStore } from '../core/codeintel/GraphSnapshotStore';
import { PROJECT_OUTPUT_DIR } from '../core/config/ProjectPaths';
import { AiTool, AiToolInput, AiToolOutput } from './tools/types';
import { FindSymbolTool } from './tools/FindSymbolTool';
import { GetDependenciesTool } from './tools/GetDependenciesTool';
import { GetFileSummaryTool } from './tools/GetFileSummaryTool';
import { SemanticSearchTool } from './tools/SemanticSearchTool';
import { AssembleContextTool } from './tools/AssembleContextTool';
import { ImpactAnalysisTool } from './tools/ImpactAnalysisTool';
import { ExplainSymbolTool } from './tools/ExplainSymbolTool';
import { DiscoverContextTool } from './tools/DiscoverContextTool';
import type { BlueprintIndex } from './discovery/BlueprintIndex';
import { FindTestsTool } from './tools/FindTestsTool';
import { GetRecentChangesTool } from './tools/GetRecentChangesTool';
import { GetConfigUsageTool } from './tools/GetConfigUsageTool';
import { SimulateMutationTool } from './tools/SimulateMutationTool';
import { DetectArchitectureViolationsTool } from './tools/DetectArchitectureViolationsTool';
import { GetGitHotspotsTool } from './tools/GetGitHotspotsTool';
import { ToolResultCache } from './tools/ToolResultCache';
import { ToolInputValidator } from './tools/ToolInputValidator';
import { TOOL_DOCS } from './tools/toolDocs';
import { ADVANCED_TOOL_NAMES, AGENT_TOOL_NAMES, INTERNAL_TOOL_NAMES, createAgentTools } from './tools/AgentTools';
import {
  CodeReadTool,
  CodeFoldTool,
  ProjectInfoTool,
  ProjectListFilesTool,
  DiagnosticsGetTool,
  SearchTextTool,
  SymbolInspectTool,
  GainsReportTool,
  CodeOutlineTool,
  SymbolFindTool,
} from './tools/Phase1ReadTools';
import { StructuralSearchTool, RuleTestTool, SyntaxTreeDumpTool, EditPlanTool, EditApprovalTool, EditApplyTool, EditRollbackTool, EditStatusTool } from './tools/Phase2StructuralTools';
import { TransactionalEditEngine } from '../core/codeintel/Phase2Transactions';
import { SymbolReferencesTool, SemanticGraphInspectTool } from './tools/Phase3SemanticTools';
import { Phase4ProviderStatusTool, Phase4ImpactTool, Phase4ContextTool, Phase4RenameTool } from './tools/Phase4ControlledTools';

export interface AiToolRegistryOptions {
  readonly reader: ProjectIndexReader;
  readonly workspaceRoot?: string;
  /**
   * پوشهٔ artifact پروژه (جایی که `project-index.json` واقعاً هست).
   *
   * تا فاز ۳ این مسیر از `resolveProjectIndexPath(workspaceRoot)` حدس زده
   * می‌شد، یعنی همیشه داخل root؛ وقتی artifact به data directory می‌رود آن
   * حدس به فایل ناموجود می‌رسد و `query_index` از کار می‌افتد.
   */
  readonly artifactRoot?: string;
  readonly projectHash?: string;
  readonly enableCache?: boolean;
  /** SE-AI-07 — تا فاز ۴۵ هیچ‌کدام از این دو به کش پاس داده نمی‌شد. */
  readonly cacheMaxSize?: number;
  readonly cacheTtlMs?: number;
  readonly vectorStoreOptions?: import('../vector/VectorStore').VectorStoreOptions;
  /**
   * blueprint، اگر کنار project-index موجود باشد.
   *
   * SE-BP-06 — تا فاز ۴۳ هیچ‌کس blueprint را بازنمی‌خواند؛ حالا
   * `discover_context` از آن به‌عنوان منبع دوم دانه استفاده می‌کند.
   */
  readonly blueprint?: BlueprintIndex;
  /** v2 is disabled unless explicitly configured with a workspace root. */
  readonly enablePhase2Edits?: boolean;
  readonly phase2JournalDirectory?: string;
  /** Experimental capabilities are opt-in and disabled by default. */
  readonly experimental?: Readonly<Record<string, boolean>>;
  /** Also list the specialist tools (`ADVANCED_TOOL_NAMES`). Off by default to keep the surface small. */
  readonly allTools?: boolean;
}

/**
 * Phase 2 mutation tools — and the status read that observes them — are never
 * served from, or stored into, the result cache. A cached `edit_apply`
 * success would report a second identical call as applied without re-checking
 * approval and preconditions, and a cached `edit_status` would report a stale
 * transaction state after rollback; each call must execute honestly.
 */
const NON_CACHEABLE_TOOLS: ReadonlySet<string> = new Set([
  'edit_plan',
  'edit_approve',
  'edit_apply',
  'edit_rollback',
  'edit_status',
  // Phase 3 (D-0021): results bind to the persisted snapshot store, which is
  // shared mutable state the (tool, input, projectHash) cache key cannot see.
  // A cached success would mask a handle that has since gone stale or been
  // superseded — stale/mismatched handles must fail closed on every call.
  'symbol_references',
  'semantic_graph_inspect',
  // These read source bytes from disk on every call. The cache key only sees the index hash, so a
  // file edited after indexing would keep answering from the cache — hiding STALE_HANDLE and
  // serving old source. Their cost is one file read, so they always execute.
  'code_read',
  'code_fold',
  'search_text',
  'structural_search',
  // The agent-facing tools only route to the tools above and below; caching
  // happens (or is refused) at the tool that does the work.
  ...AGENT_TOOL_NAMES.filter(name => !['project_info', 'find_symbol', 'explain_symbol', 'find_tests'].includes(name)),
]);

const INTERNAL_TOOLS: ReadonlySet<string> = new Set(INTERNAL_TOOL_NAMES);
const ADVANCED_TOOLS: ReadonlySet<string> = new Set(ADVANCED_TOOL_NAMES);

export class AiToolRegistry {
  private readonly tools = new Map<string, AiTool>();
  private readonly cache: ToolResultCache;
  private readonly validator = new ToolInputValidator();
  private projectHash: string | undefined;

  constructor(private readonly options: AiToolRegistryOptions) {
    this.cache = new ToolResultCache({
      /*
      | SE-AI-07 — رجیستری هرگز `ttl`/`maxSize` را پاس نمی‌داد، پس
      | کش همیشه با پیش‌فرض‌های سازنده کار می‌کرد و هیچ‌کس نمی‌توانست
      | تنظیمش کند.
      */
      ...(options.cacheMaxSize !== undefined ? { maxSize: options.cacheMaxSize } : {}),
      ...(options.cacheTtlMs !== undefined ? { ttlMs: options.cacheTtlMs } : {}),
    });
    this.projectHash = options.projectHash;
    this.registerBuiltInTools();
  }

  /** تعداد ورودی‌های کش — برای اینکه «کش کار می‌کند» قابل اثبات باشد. */
  get cacheSize(): number {
    return this.cache.size();
  }

  /**
   * SE-AI-02 — بی‌اعتبارسازی هنگام تغییر ایندکس.
   *
   * `AiToolCommandHandler` رجیستری را برای همیشه کش می‌کرد، پس بعد
   * از هر اسکن مجدد یا به‌روزرسانی incremental، ابزارها **ایندکس
   * قدیمی** را سرو می‌کردند تا وقتی پنجره بسته شود. کشِ نتایج هم
   * فقط هنگام *خواندن* hash را می‌سنجید، یعنی ورودی‌های کهنه تا
   * وقتی کسی سراغشان نرود در حافظه می‌ماندند.
   */
  invalidate(projectHash?: string): void {
    if (projectHash !== undefined && projectHash === this.projectHash) return;
    this.projectHash = projectHash ?? this.projectHash;
    this.cache.clear();
  }

  private registerBuiltInTools(): void {
    this.register(new FindSymbolTool(this.options.reader));
    this.register(new GetDependenciesTool(this.options.reader));
    this.register(new GetFileSummaryTool(this.options.reader));
    this.register(new SemanticSearchTool(this.options.reader, undefined, this.options.vectorStoreOptions));
    this.register(new AssembleContextTool(this.options.reader, undefined, {
      ...(this.options.workspaceRoot ? { workspaceRoot: this.options.workspaceRoot } : {}),
      ...(this.options.blueprint ? { blueprint: this.options.blueprint } : {}),
    }));
    this.register(new DiscoverContextTool(this.options.reader, {
      ...(this.options.blueprint ? { blueprint: this.options.blueprint } : {}),
    }));
    this.register(new ImpactAnalysisTool(this.options.reader, {
      ...(this.options.blueprint ? { blueprint: this.options.blueprint } : {}),
    }));
    this.register(new ExplainSymbolTool(this.options.reader));
    this.register(new FindTestsTool(this.options.reader));
    this.register(new GetRecentChangesTool(this.options.workspaceRoot));
    this.register(new GetConfigUsageTool(this.options.reader));
    this.register(new SimulateMutationTool(this.options.reader));
    this.register(new DetectArchitectureViolationsTool(this.options.reader));
    this.register(new GetGitHotspotsTool(this.options.reader, this.options.workspaceRoot));
    // Phase 1 v1 read-only surface. These tools are additive and require an
    // explicit workspaceRoot for source access; the index-only tools remain
    // usable when source access is unavailable.
    this.register(new CodeReadTool(this.options.reader, this.options.workspaceRoot));
    this.register(new CodeFoldTool(this.options.reader, this.options.workspaceRoot));
    this.register(new ProjectInfoTool(this.options.reader));
    this.register(new ProjectListFilesTool(this.options.reader));
    this.register(new DiagnosticsGetTool(this.options.reader));
    this.register(new SearchTextTool(this.options.reader, this.options.workspaceRoot));
    this.register(new SymbolInspectTool(this.options.reader));
    this.register(new GainsReportTool(this.options.reader, this.options.workspaceRoot));
    this.register(new CodeOutlineTool(this.options.reader));
    this.register(new SymbolFindTool(this.options.reader));
    for (const tool of createAgentTools((name, input) => this.execute(name, input), this.options.reader)) {
      this.register(tool);
    }
    const phase2Engine = this.options.enablePhase2Edits && this.options.workspaceRoot
      ? new TransactionalEditEngine(this.options.workspaceRoot, this.options.phase2JournalDirectory)
      : undefined;
    this.register(new StructuralSearchTool(this.options.reader, this.options.workspaceRoot));
    this.register(new RuleTestTool(this.options.reader, this.options.workspaceRoot));
    this.register(new SyntaxTreeDumpTool(this.options.reader, this.options.workspaceRoot));
    this.register(new EditPlanTool(this.options.reader, this.options.workspaceRoot, phase2Engine));
    this.register(new EditApprovalTool(phase2Engine));
    this.register(new EditApplyTool(phase2Engine));
    this.register(new EditRollbackTool(phase2Engine));
    this.register(new EditStatusTool(phase2Engine));
    // Phase 3 is experimental: no tool is exposed unless the host opts in.
    if (this.options.experimental?.['semantic-graph'] === true && this.options.workspaceRoot) {
      // D-0021: Phase 3 tools run against the persisted snapshot store (durable
      // handles, fail-closed stale/mismatch rejection) instead of per-call rebuilds.
      const graphStore = new GraphSnapshotStore(path.join(this.options.workspaceRoot, PROJECT_OUTPUT_DIR, 'graph-snapshots'));
      this.register(new SymbolReferencesTool(this.options.reader, this.options.workspaceRoot, graphStore));
      this.register(new SemanticGraphInspectTool(this.options.reader, this.options.workspaceRoot, graphStore));
    }
    // Phase 4 remains opt-in and independently bounded. No Phase 4 tool is
    // exposed unless the host explicitly enables controlled-expansion.
    if (this.options.experimental?.['controlled-expansion'] === true) {
      this.register(new Phase4ProviderStatusTool());
      this.register(new Phase4ImpactTool(this.options.reader));
      if (this.options.workspaceRoot) this.register(new Phase4ContextTool(this.options.reader, this.options.workspaceRoot));
      const phase4Engine = this.options.enablePhase2Edits && this.options.workspaceRoot
        ? new TransactionalEditEngine(this.options.workspaceRoot, this.options.phase2JournalDirectory)
        : undefined;
      if (this.options.workspaceRoot && phase4Engine) this.register(new Phase4RenameTool(this.options.reader, this.options.workspaceRoot, phase4Engine));
    }
  }

  register(tool: AiTool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): AiTool | undefined {
    return this.tools.get(name);
  }

  /**
   * What a model is shown: the agent-facing tools first (in their presented
   * order), then whatever was opted into (specialist tools with `allTools`,
   * edits, experimental capabilities). The implementations behind the
   * agent-facing tools stay callable through `execute` but are never listed.
   *
   * Each entry is the tool's own description and schema completed with the
   * reviewed text in `toolDocs.ts` (when to use it, what it returns, what
   * every parameter means).
   */
  list(): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
    const order = new Map(AGENT_TOOL_NAMES.map((name, index) => [name, index]));
    return Array.from(this.tools.values())
      .filter(t => this.isListed(t.name))
      .sort((a, b) => (order.get(a.name) ?? order.size) - (order.get(b.name) ?? order.size))
      .map(t => this.describe(t));
  }

  /** True when `list()` offers the tool. */
  isListed(name: string): boolean {
    return this.isCallable(name) && this.tools.get(name)?.isAvailable?.() !== false;
  }

  /**
   * True when a remote caller may invoke the tool. Wider than `isListed` by
   * the tools that are registered but switched off (guarded edits): calling
   * one answers an explicit DISABLED, which is more useful than "not found".
   */
  isCallable(name: string): boolean {
    if (!this.tools.has(name) || INTERNAL_TOOLS.has(name)) return false;
    return !ADVANCED_TOOLS.has(name) || this.options.allTools === true;
  }

  private describe(tool: AiTool): { name: string; description: string; inputSchema: Record<string, unknown> } {
    const doc = TOOL_DOCS[tool.name];
    if (!doc) return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };

    const schema = JSON.parse(JSON.stringify(tool.inputSchema)) as Record<string, unknown>;
    const properties = (schema['properties'] ?? {}) as Record<string, Record<string, unknown>>;
    for (const [key, text] of Object.entries(doc.params)) {
      if (properties[key]) properties[key] = { ...properties[key], description: text };
    }
    for (const [key, patch] of Object.entries(doc.schemaPatch ?? {})) {
      if (properties[key]) properties[key] = { ...properties[key], ...patch };
    }
    return {
      name: tool.name,
      description: `${tool.description} ${doc.use} Returns: ${doc.returns}`,
      inputSchema: schema,
    };
  }

  /**
   * Parameters the tool does not declare are ignored by every tool; a typo
   * (`limt`) would otherwise look like a limit that was applied. They are
   * reported in `metadata.warnings` so the caller can correct itself.
   */
  private unknownParameterWarnings(tool: AiTool, input: AiToolInput): string[] {
    const declared = (tool.inputSchema as { properties?: Record<string, unknown> }).properties;
    if (!declared) return [];
    const known = Object.keys(declared);
    const warnings: string[] = [];
    for (const key of Object.keys(input)) {
      if (key in declared) continue;
      const near = known.find(candidate => editDistance(candidate.toLowerCase(), key.toLowerCase()) <= 2);
      warnings.push(
        `unknown parameter '${key}' was ignored${near ? `; did you mean '${near}'?` : ''} (accepted: ${known.join(', ') || 'none'})`
      );
    }
    return warnings;
  }

  /**
   * تنها مسیر اجرا — SE-AI-01.
   *
   * تا فاز ۴۵ دو مسیر واگرا وجود داشت: `execute()` کش داشت و
   * اعتبارسنجی نداشت، `executeWithValidation()` برعکس. سرور MCP فقط
   * دومی را صدا می‌زد، پس کش عملاً بی‌استفاده بود و هر مصرف‌کنندهٔ
   * دیگری بی‌اعتبارسنجی می‌ماند. حالا یک مسیر است که هر دو کار را
   * می‌کند.
   */
  async execute(name: string, input: AiToolInput): Promise<AiToolOutput> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { success: false, error: `Tool '${name}' not found`, items: [] };
    }

    const validation = this.validator.validate(tool, input);
    if (!validation.ok) {
      return { success: false, error: validation.error, items: [] };
    }

    const warnings = this.unknownParameterWarnings(tool, input);
    const result = await this.run(tool, name, input);
    if (warnings.length === 0) return result;
    return { ...result, metadata: { ...(result.metadata ?? {}), warnings } };
  }

  private async run(tool: AiTool, name: string, input: AiToolInput): Promise<AiToolOutput> {
    const hash = this.projectHash;
    if (this.options.enableCache !== false && hash && !NON_CACHEABLE_TOOLS.has(name)) {
      const cached = this.cache.get(name, input, hash);
      if (cached) return cached;

      const result = await tool.execute(input);
      // نتیجهٔ ناموفق کش نمی‌شود: یک خطای گذرا نباید تا انقضای ttl
      // به همهٔ فراخوانی‌های بعدی هم تحمیل شود.
      if (result.success) this.cache.set(name, input, hash, result);
      return result;
    }

    return tool.execute(input);
  }

  /**
   * نام قدیمی، همان رفتار.
   *
   * نگه داشته شده چون سرور MCP و `AiToolCommandHandler` صدایش
   * می‌زنند؛ حالا فقط یک نام دیگر برای `execute` است.
   */
  async executeWithValidation(name: string, input: AiToolInput): Promise<AiToolOutput> {
    return this.execute(name, input);
  }
}

/** Levenshtein distance; parameter names are short, so the simple form is enough. */
function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}
