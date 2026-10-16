import { AiTool, AiToolInput, AiToolOutput } from './types';
import { ProjectIndexReader } from '../ProjectIndexReader';
import { TransactionalEditEngine } from '../../core/codeintel/Phase2Transactions';
import { Phase4ConstraintGraph, Phase4ContextBuilder, Phase4ImpactAnalyzer, Phase4ProviderRegistry, Phase4SemanticRenamer } from '../../core/codeintel/Phase4Controlled';

const fail = (error: string): AiToolOutput => ({ success: false, error, items: [] });
const ok = (items: AiToolOutput['items'], metadata: Record<string, unknown>): AiToolOutput => ({ success: true, items, metadata });

export class Phase4ProviderStatusTool implements AiTool {
  readonly name = 'provider_status';
  readonly description = 'Experimental Phase 4 language-provider status; unsupported languages are explicit.';
  readonly inputSchema = { type: 'object', properties: { languages: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 } }, required: ['languages'] };
  private readonly providers = new Phase4ProviderRegistry();
  async execute(input: AiToolInput): Promise<AiToolOutput> { const languages = Array.isArray(input.languages) ? input.languages.filter((x): x is string => typeof x === 'string') : []; if (!languages.length) return fail('INVALID_ARGUMENT: languages'); return ok(languages.sort().map(language => ({ id: language, name: language, kind: 'language_provider', source: 'phase4-controlled', metadata: { status: this.providers.status(language), experimental: true } })), { experimental: true, trust: 'untrusted-source-content' }); }
}

export class Phase4ImpactTool implements AiTool {
  readonly name = 'impact_analyze_v4';
  readonly description = 'Experimental bounded impact analysis with explicit constraint provenance.';
  readonly inputSchema = { type: 'object', properties: { symbolId: { type: 'string' }, includeHeuristic: { type: 'boolean' } }, required: ['symbolId'] };
  constructor(private readonly reader: ProjectIndexReader) {}
  async execute(input: AiToolInput): Promise<AiToolOutput> { if (typeof input.symbolId !== 'string') return fail('INVALID_ARGUMENT: symbolId'); const result = new Phase4ImpactAnalyzer(new Phase4ConstraintGraph(this.reader)).analyze(input.symbolId, input.includeHeuristic === true); return ok(result.items.map(e => ({ id: e.id, name: e.kind, kind: e.kind, path: e.path, source: 'phase4-constraint-graph', metadata: { ...e } })), { experimental: true, symbolId: result.symbolId, warnings: result.warnings, trust: 'untrusted-source-content' }); }
}

export class Phase4ContextTool implements AiTool {
  readonly name = 'context_build_v4';
  readonly description = 'Experimental deterministic context builder with a hard token budget.';
  readonly inputSchema = { type: 'object', properties: { seed: { type: 'string', minLength: 1, maxLength: 200 }, budgetTokens: { type: 'integer', minimum: 1, maximum: 100000 }, limit: { type: 'integer', minimum: 1, maximum: 1000 }, goal: { type: 'string', minLength: 1, maxLength: 500, description: 'Natural-language goal; selects retrieval direction/class only (Phase 3 semantic layer).' } }, required: ['seed'] };
  constructor(private readonly reader: ProjectIndexReader, private readonly workspaceRoot?: string) {}
  async execute(input: AiToolInput): Promise<AiToolOutput> { if (!this.workspaceRoot) return fail('DISABLED: Phase 4 workspaceRoot is not configured'); if (typeof input.seed !== 'string') return fail('INVALID_ARGUMENT: seed'); try { const result = await new Phase4ContextBuilder(this.reader, this.workspaceRoot).build(input.seed, typeof input.budgetTokens === 'number' ? input.budgetTokens : 2000, typeof input.limit === 'number' ? input.limit : 100, typeof input.goal === 'string' ? input.goal : undefined); return ok(result.items.map(item => ({ id: item.id, name: item.symbolKey ?? item.path, kind: 'context_item', path: item.path, relevanceScore: item.score, excerpt: item.excerpt, source: 'phase4-context-builder', metadata: { reason: item.reason } })), { ...result.contract, snapshotId: result.snapshotId, omittedSummary: result.omittedSummary, truncated: result.truncated, trust: 'untrusted-source-content' }); } catch (error) { return fail(error instanceof Error ? error.message : String(error)); } }
}

export class Phase4RenameTool implements AiTool {
  readonly name = 'semantic_rename_v4';
  readonly description = 'Experimental approval-gated exact semantic rename plan; planning never writes files.';
  readonly inputSchema = { type: 'object', properties: { symbolId: { type: 'string' }, replacement: { type: 'string', pattern: '^[A-Za-z_$][\\w$]*$' }, includeHeuristic: { type: 'boolean' } }, required: ['symbolId', 'replacement'] };
  constructor(private readonly reader: ProjectIndexReader, private readonly workspaceRoot?: string, private readonly engine?: TransactionalEditEngine) {}
  async execute(input: AiToolInput): Promise<AiToolOutput> { if (!this.workspaceRoot || !this.engine) return fail('DISABLED: Phase 4 edits are not configured'); if (typeof input.symbolId !== 'string' || typeof input.replacement !== 'string') return fail('INVALID_ARGUMENT: symbolId/replacement'); try { const result = await new Phase4SemanticRenamer(this.reader, this.workspaceRoot, this.engine).plan(input.symbolId, input.replacement, input.includeHeuristic === true); return ok([{ id: result.plan.id, name: 'semantic rename plan', kind: 'edit_plan', source: 'phase4-semantic-rename', metadata: { plan: result.plan, skipped: result.skipped, conflicts: result.conflicts, expect: result.expect } }], { ...result.contract, approved: false, approvalRequired: true, trust: 'untrusted-source-content' }); } catch (error) { return fail(error instanceof Error ? error.message : String(error)); } }
}
