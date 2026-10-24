import { isDeniedPath } from '../../core/contracts/fileProvider';
import { SourceSecurityGuard } from '../../services/source/SourceSecurityGuard';
import * as fs from 'fs/promises';
import { AiTool, AiToolInput, AiToolOutput } from './types';
import { ProjectIndexReader } from '../ProjectIndexReader';
import { FileEntry } from '../../core/types/project-index.types';
import { contentHash, EditPlan, TextEdit, TransactionalEditEngine } from '../../core/codeintel/Phase2Transactions';
import { dumpSyntaxTree, languageForPath, parseRulePack, readRulePack, searchTextStructurally, StructuralLanguage, StructuralRule } from '../../core/codeintel/Phase2Structural';

const fail = (error: string): AiToolOutput => ({ success: false, error, items: [] });
const ok = (items: AiToolOutput['items'], metadata?: Record<string, unknown>): AiToolOutput => ({ success: true, items, ...(metadata ? { metadata } : {}) });

abstract class StructuralTool {
  constructor(protected readonly reader: ProjectIndexReader, protected readonly workspaceRoot?: string) {}
  protected files(input: AiToolInput): FileEntry[] { const requested = typeof input.path === 'string' ? this.reader.getFileByPath(input.path) : undefined; return (requested ? [requested] : [...this.reader.getAllFiles()]).filter(f => !f.binary && !isDeniedPath(f.path)).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0); }
  protected absolute(relative: string): string { if (!this.workspaceRoot) throw new Error('workspaceRoot is not configured'); return require('path').resolve(this.workspaceRoot, relative); }
  private readonly guard = new SourceSecurityGuard();
  protected async source(file: FileEntry): Promise<string> {
    /* Same boundary as code_read: secrets/.git are never read, and a symlink must not leave the workspace. */
    if (isDeniedPath(file.path)) throw new Error(`DENIED: ${file.path} is on the secret/.git denylist`);
    if (!this.workspaceRoot) throw new Error('workspaceRoot is not configured');
    const checked = this.guard.validateRelativePath(this.workspaceRoot, file.path);
    if (!checked.ok || !checked.resolvedPath) throw new Error(checked.reason ?? 'Source path denied');
    return (await fs.readFile(checked.resolvedPath, 'utf8')).replace(/^\uFEFF/u, '');
  }
}

export class StructuralSearchTool extends StructuralTool implements AiTool {
  readonly name = 'structural_search'; readonly description = 'Search source files using deterministic structural patterns and named metavariables.';
  readonly inputSchema = { type: 'object', properties: { pattern: { type: 'string', minLength: 1 }, language: { type: 'string' }, path: { type: 'string' }, maxResults: { type: 'integer', minimum: 1, maximum: 10000 }, ruleId: { type: 'string' } }, required: ['pattern', 'language'] };
  async execute(input: AiToolInput): Promise<AiToolOutput> {
    if (!this.workspaceRoot) return fail('DISABLED: workspaceRoot is not configured');
    if (typeof input.pattern !== 'string' || typeof input.language !== 'string') return fail('INVALID_ARGUMENT: pattern and language are required');
    const max = typeof input.maxResults === 'number' ? input.maxResults : 100; const items: AiToolOutput['items'][number][] = []; let truncated = false;
    for (const file of this.files(input)) {
      if (file.language && input.language !== file.language && languageForPath(file.path) !== input.language) continue;
      let text: string; try { text = await this.source(file); } catch (error) { return fail(`IO_ERROR: ${error instanceof Error ? error.message : String(error)}`); }
      // Adapter errors already carry honest prefixes (UNSUPPORTED_LANGUAGE,
      // INVALID_PATTERN, AST_GREP_*): surface them verbatim, never wrapped.
      let result: ReturnType<typeof searchTextStructurally>;
      try { result = searchTextStructurally(text, { pattern: input.pattern, language: input.language as StructuralLanguage, path: file.path, maxResults: Math.max(1, max - items.length), ...(typeof input.ruleId === 'string' ? { ruleId: input.ruleId } : {}) }); }
      catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
      truncated ||= result.truncated;
      items.push(...result.matches.map(m => ({ id: m.id, name: m.path, kind: 'structural_match', path: m.path, line: m.line, source: 'structural-search', excerpt: m.text, metadata: { start: m.start, end: m.end, column: m.column, captures: m.captures, language: m.language, ruleId: m.ruleId } })));
      if (items.length >= max) { truncated = true; break; }
    }
    /*
    | SE-AI-HONESTY (P-06) — صفحه پر شد و اسکن قطع شد؛ پس شمارشِ کل
    | موجود نیست. `matchesAtLeast` به AI می‌گوید حداقل همین‌قدر تطبیق
    | هست و ممکن است بیشتر باشد — نه اینکه لیست کامل است.
    */
    const capped = items.length >= max;
    return ok(items.slice(0, max), { returnedTokens: items.reduce((n, i) => n + Math.ceil((i.excerpt ?? '').length / 4), 0), truncated, max, ...(capped || truncated ? { matchesAtLeast: items.length } : { matchCount: items.length }) });
  }
}

export class RuleTestTool extends StructuralTool implements AiTool {
  readonly name = 'structural_rule_test'; readonly description = 'Run a validated project-scoped structural rule pack without editing files.';
  readonly inputSchema = { type: 'object', properties: { rules: { type: 'string' }, rulePath: { type: 'string' }, path: { type: 'string' }, maxResults: { type: 'integer', minimum: 1 } }, anyOf: [{ required: ['rules'] }, { required: ['rulePath'] }] };
  async execute(input: AiToolInput): Promise<AiToolOutput> {
    if (!this.workspaceRoot) return fail('DISABLED: workspaceRoot is not configured');
    try {
      const pack = typeof input.rules === 'string' ? parseRulePack(input.rules) : typeof input.rulePath === 'string' ? await readRulePack(this.absolute(input.rulePath)) : (() => { throw new Error('rules or rulePath is required'); })();
      const rows: AiToolOutput['items'][number][] = [];
      for (const rule of pack.rules) {
        const result = await new StructuralSearchTool(this.reader, this.workspaceRoot).execute({ pattern: rule.pattern, language: rule.language, ...(typeof input.path === 'string' ? { path: input.path } : {}), maxResults: input.maxResults ?? 1000, ruleId: rule.id });
        // F-11: a rule that ERRORS must fail the call, never masquerade as
        // "passed" with zero rows.
        if (!result.success) return result;
        rows.push(...result.items.map(item => ({ ...item, kind: `rule:${rule.severity}`, name: rule.message, metadata: { ...item.metadata, ruleId: rule.id, message: rule.message, severity: rule.severity } })));
      }
      return ok(rows, { ruleCount: pack.rules.length, passed: rows.length === 0 });
    } catch (error) { return fail(`INVALID_RULE_PACK: ${error instanceof Error ? error.message : String(error)}`); }
  }
}

export class SyntaxTreeDumpTool extends StructuralTool implements AiTool {
  readonly name = 'syntax_tree_dump'; readonly description = 'Dump the deterministic syntax-debug tree for a source file.';
  readonly inputSchema = { type: 'object', properties: { path: { type: 'string' }, language: { type: 'string' } }, required: ['path', 'language'] };
  async execute(input: AiToolInput): Promise<AiToolOutput> { if (!this.workspaceRoot || typeof input.path !== 'string' || typeof input.language !== 'string') return fail('INVALID_ARGUMENT: path and language are required'); const file = this.reader.getFileByPath(input.path); if (!file) return fail('NOT_FOUND: source file'); try { const tree = await dumpSyntaxTree(await this.source(file), input.language as StructuralLanguage); return ok([{ id: `${file.id}:tree`, name: file.path, kind: 'syntax_tree', path: file.path, line: 1, source: 'syntax-tree-dump', excerpt: JSON.stringify(tree), metadata: { language: input.language } }]); } catch (error) { return fail(`IO_ERROR: ${error instanceof Error ? error.message : String(error)}`); } }
}

export class EditPlanTool extends StructuralTool implements AiTool {
  readonly name = 'edit_plan'; readonly description = 'Create a dry-run transactional edit plan; no source is written.';
  readonly inputSchema = { type: 'object', properties: { edits: { type: 'array', items: { type: 'object' } }, source: { enum: ['structural-search', 'client'] } }, required: ['edits'] };
  constructor(reader: ProjectIndexReader, workspaceRoot: string | undefined, private readonly engine?: TransactionalEditEngine) { super(reader, workspaceRoot); }
  async execute(input: AiToolInput): Promise<AiToolOutput> { if (!this.engine || !Array.isArray(input.edits)) return fail('DISABLED: transactional edits are not configured'); try { const plan = await this.engine.plan(input.edits as TextEdit[], input.source === 'structural-search' ? 'structural-search' : 'client'); return ok([{ id: plan.id, name: plan.id, kind: 'edit_plan', source: 'transactional-edit', excerpt: plan.diff, metadata: { planId: plan.id, editCount: plan.edits.length, diff: plan.diff, approvalRequired: true, readOnlyPreview: true } }]); } catch (error) { return fail(error instanceof Error ? error.message : String(error)); } }
}

export class EditApprovalTool implements AiTool {
  readonly name = 'edit_approve'; readonly description = 'Approve a previously previewed edit plan; approval does not apply it.';
  readonly inputSchema = { type: 'object', properties: { planId: { type: 'string' } }, required: ['planId'] };
  constructor(private readonly engine?: TransactionalEditEngine) {}
  async execute(input: AiToolInput): Promise<AiToolOutput> { if (!this.engine || typeof input.planId !== 'string') return fail('DISABLED: transactional edits are not configured'); try { const token = this.engine.approve(input.planId); return ok([], { planId: input.planId, approvalToken: token, applyRequired: true }); } catch (error) { return fail(error instanceof Error ? error.message : String(error)); } }
}

export class EditApplyTool implements AiTool {
  readonly name = 'edit_apply'; readonly description = 'Apply an explicitly approved transaction and journal originals for rollback.';
  readonly inputSchema = { type: 'object', properties: { planId: { type: 'string' }, approvalToken: { type: 'string' } }, required: ['planId', 'approvalToken'] };
  constructor(private readonly engine?: TransactionalEditEngine) {}
  async execute(input: AiToolInput): Promise<AiToolOutput> { if (!this.engine || typeof input.planId !== 'string' || typeof input.approvalToken !== 'string') return fail('DISABLED: transactional edits are not configured'); try { const record = await this.engine.apply(input.planId, input.approvalToken); return ok([], { transactionId: record.transactionId, status: record.status, rollbackAvailable: true }); } catch (error) { return fail(error instanceof Error ? error.message : String(error)); } }
}

export class EditRollbackTool implements AiTool {
  readonly name = 'edit_rollback'; readonly description = 'Rollback an applied transaction from its durable journal.';
  readonly inputSchema = { type: 'object', properties: { transactionId: { type: 'string' } }, required: ['transactionId'] };
  constructor(private readonly engine?: TransactionalEditEngine) {}
  async execute(input: AiToolInput): Promise<AiToolOutput> { if (!this.engine || typeof input.transactionId !== 'string') return fail('DISABLED: transactional edits are not configured'); try { const record = await this.engine.rollback(input.transactionId); return ok([], { transactionId: record.transactionId, status: record.status }); } catch (error) { return fail(error instanceof Error ? error.message : String(error)); } }
}

export class EditStatusTool implements AiTool {
  readonly name = 'edit_status'; readonly description = 'Inspect journaled transaction status without changing any file.';
  readonly inputSchema = { type: 'object', properties: { transactionId: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 1000 } } };
  constructor(private readonly engine?: TransactionalEditEngine) {}
  async execute(input: AiToolInput): Promise<AiToolOutput> {
    if (!this.engine) return fail('DISABLED: transactional edits are not configured');
    try {
      const records = await this.engine.recover();
      const selected = typeof input.transactionId === 'string' ? records.filter(r => r.transactionId === input.transactionId) : records;
      if (typeof input.transactionId === 'string' && selected.length === 0) return fail('NOT_FOUND: transaction');
      const limit = typeof input.limit === 'number' ? input.limit : 100;
      const rows = selected.slice(0, limit).map(r => ({ id: r.transactionId, name: r.status, kind: 'transaction', source: 'transaction-journal', metadata: { status: r.status, planId: r.plan.id, paths: r.plan.edits.map(e => e.path), editCount: r.plan.edits.length, updatedAt: r.updatedAt, diff: r.plan.diff.length > 4000 ? `${r.plan.diff.slice(0, 4000)}…` : r.plan.diff, diffTruncated: r.plan.diff.length > 4000 } }));
      return ok(rows, { count: rows.length, truncated: selected.length > rows.length });
    } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
  }
}

export function phase2EngineHash(text: string): string { return contentHash(text); }
export type Phase2Rule = StructuralRule;
export type Phase2Plan = EditPlan;
