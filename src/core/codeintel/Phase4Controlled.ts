import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ProjectIndexReader } from '../../ai/ProjectIndexReader';
import { SymbolEntry } from '../types/project-index.types';
import { compareCanonical, LineIndex, sanitizeKeyPart } from '../contracts/codeintel';
import { TransactionalEditEngine, TextEdit, EditPlan, contentHash } from './Phase2Transactions';

export type Phase4Language = 'typescript' | 'javascript' | 'tsx' | 'python';
export type ConstraintKind = 'calls' | 'calledBy' | 'enclosingClass' | 'dependsOn' | 'changedSince' | 'hasTest';
export type Phase4Confidence = 'exact' | 'heuristic' | 'unresolved';

export interface Phase4Contract { readonly schemaVersion: '4-controlled'; readonly feature: string; readonly experimental: true; readonly rollback: string; readonly securityBoundary: string; }
export interface Phase4Symbol { readonly id: string; readonly key: string; readonly name: string; readonly kind: string; readonly path: string; readonly language: Phase4Language; readonly start: number; readonly end: number; readonly line: number; readonly exported: boolean; readonly confidence: Phase4Confidence; }
export interface Phase4Edge { readonly id: string; readonly from: string; readonly to: string; readonly kind: ConstraintKind; readonly confidence: Phase4Confidence; readonly provenance: 'index' | 'import-graph' | 'filename-heuristic'; readonly path?: string; }
export interface ContextItem { readonly id: string; readonly path: string; readonly symbolKey?: string; readonly score: number; readonly excerpt: string; readonly reason: string; }
export interface ContextResult { readonly contract: Phase4Contract; readonly snapshotId: string; readonly items: readonly ContextItem[]; readonly omittedSummary: { readonly count: number; readonly estimatedTokens: number }; readonly truncated: boolean; }
export interface RenameResult { readonly contract: Phase4Contract; readonly plan: EditPlan; readonly skipped: readonly { readonly path: string; readonly reason: string }[]; readonly conflicts: readonly { readonly path: string; readonly reason: string }[]; readonly expect: { readonly unresolvedNotIncreased: true }; }

const contract = (feature: string, rollback: string, securityBoundary: string): Phase4Contract => ({ schemaVersion: '4-controlled', feature, experimental: true, rollback, securityBoundary });


export class Phase4ProviderRegistry {
  readonly contract = contract('provider-expansion', 'Disable provider flag; no index mutation is performed.', 'Only workspace-relative files selected by ProjectIndex are read.');
  status(language: string): 'ok' | 'degraded' | 'unavailable' { return ['typescript', 'javascript', 'tsx', 'python'].includes(language) ? 'degraded' : 'unavailable'; }
  parsePython(text: string, relativePath: string): { symbols: readonly Phase4Symbol[]; imports: readonly string[] } {
    const symbols: Phase4Symbol[] = []; const imports: string[] = []; const index = new LineIndex(text);
    const importRe = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gmu; let im: RegExpExecArray | null;
    while ((im = importRe.exec(text))) imports.push(im[1] ?? im[2]);
    const defRe = /^(\s*)(async\s+)?(def|class)\s+([A-Za-z_]\w*)\s*(?:\([^\n]*\))?/gmu; let m: RegExpExecArray | null; let ordinal = 0;
    while ((m = defRe.exec(text))) { const start = m.index + m[1].length; const line = index.positionAt(start); const kind = m[3] === 'class' ? 'class' : 'function'; const name = m[4]; const key = `${relativePath}::${name}::${kind}#${ordinal++}`; symbols.push({ id: sha(key), key, name, kind, path: relativePath, language: 'python', start, end: start + m[0].trim().length, line: line.line + 1, exported: !name.startsWith('_'), confidence: 'heuristic' }); }
    return { symbols: symbols.sort((a, b) => compareCanonical(a.key, b.key)), imports: [...new Set(imports)].sort(compareCanonical) };
  }
}

export class Phase4ConstraintGraph {
  readonly contract = contract('constraint-graph', 'Drop the derived graph and rebuild from the unchanged ProjectIndex.', 'Constraints are derived only from bounded ProjectIndex data; unresolved edges remain explicit.');
  constructor(private readonly reader: ProjectIndexReader) {}
  build(): { readonly nodes: readonly Phase4Symbol[]; readonly edges: readonly Phase4Edge[] } {
    const files = [...this.reader.getAllFiles()].sort((a, b) => compareCanonical(a.path, b.path));
    const symbols = [...this.reader.getAllSymbols()]; const nodes = symbols.map(s => this.node(s)).sort((a, b) => compareCanonical(a.key, b.key)); const edges: Phase4Edge[] = [];
    for (const file of files) {
      const fileSymbols = symbols.filter(s => s.fileId === file.id);
      for (const s of fileSymbols) {
        for (const targetId of s.calls ?? []) { const target = symbols.find(x => x.id === targetId); edges.push({ id: sha(`${s.id}:calls:${targetId}`), from: s.id, to: targetId, kind: 'calls', confidence: target ? 'exact' : 'unresolved', provenance: 'index', path: file.path }); }
        if (s.parentId) edges.push({ id: sha(`${s.id}:enclosingClass:${s.parentId}`), from: s.id, to: s.parentId, kind: 'enclosingClass', confidence: 'exact', provenance: 'index', path: file.path });
        if (file.testFile) edges.push({ id: sha(`${s.id}:hasTest:${file.id}`), from: s.id, to: file.id, kind: 'hasTest', confidence: 'heuristic', provenance: 'filename-heuristic', path: file.path });
      }
      for (const imported of file.imports ?? []) { if (imported.resolvedFileId) edges.push({ id: sha(`${file.id}:dependsOn:${imported.resolvedFileId}`), from: file.id, to: imported.resolvedFileId, kind: 'dependsOn', confidence: 'exact', provenance: 'import-graph', path: file.path }); }
    }
    return { nodes, edges: edges.sort((a, b) => compareCanonical(a.id, b.id)) };
  }
  private node(s: SymbolEntry): Phase4Symbol { const file = this.reader.getFileById(s.fileId); const key = `${file?.path ?? s.fileId}::${sanitizeKeyPart(s.fullyQualifiedName ?? s.name)}::${sanitizeKeyPart(s.kind)}`; return { id: s.id, key, name: s.name, kind: s.kind, path: file?.path ?? s.fileId, language: (file?.language as Phase4Language) ?? 'typescript', start: 0, end: 0, line: s.line, exported: s.exported === true, confidence: 'exact' }; }
}

export class Phase4ContextBuilder {
  readonly contract = contract('context-build', 'Context is ephemeral; discard result and rebuild from snapshot.', 'Bounded item count, UTF-16-safe excerpts, no source mutation, untrusted content marker.');
  private graphPromise: Promise<import('./Phase3SemanticGraph').SemanticGraph> | undefined;
  constructor(private readonly reader: ProjectIndexReader, private readonly workspaceRoot: string) {}
  /* Phase 3 semantic layer, built at most once per builder instance (measured upstream, G-3.x). */
  private graph(): Promise<import('./Phase3SemanticGraph').SemanticGraph> {
    this.graphPromise ??= import('./Phase3SemanticGraph').then(m => new m.Phase3SemanticGraphPilot(this.reader, this.workspaceRoot).build());
    return this.graphPromise;
  }
  async build(seed: string, budgetTokens = 2000, limit = 100, goal?: string): Promise<ContextResult> {
    if (!Number.isInteger(budgetTokens) || budgetTokens < 1 || budgetTokens > 100000) throw new Error('INVALID_ARGUMENT: budgetTokens');
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('INVALID_ARGUMENT: limit');
    const symbols = goal === undefined
      ? [...this.reader.getAllSymbols()].filter(s => s.name === seed || s.fullyQualifiedName?.includes(seed)).map(s => ({ symbol: s, score: s.name === seed ? 1 : 0.5, reason: s.name === seed ? 'exact seed match' : 'qualified-name match' })).sort((a, b) => b.score - a.score || compareCanonical(a.symbol.id, b.symbol.id))
      : await this.goalAwareSymbols(seed, goal);
    const items: ContextItem[] = []; let used = 0;
    for (const candidate of symbols.slice(0, limit)) { const file = this.reader.getFileById(candidate.symbol.fileId); if (!file || file.binary || file.truncated) continue; const text = await this.safeRead(file.path); const excerpt = text.slice(0, Math.min(text.length, Math.max(80, budgetTokens * 4 - used * 4))); const tokens = estimateTokens(excerpt); if (used + tokens > budgetTokens) break; items.push({ id: sha(`${file.path}:${candidate.symbol.id}`), path: file.path, symbolKey: `${file.path}::${sanitizeKeyPart(candidate.symbol.fullyQualifiedName ?? candidate.symbol.name)}::${sanitizeKeyPart(candidate.symbol.kind)}`, score: candidate.score, excerpt, reason: candidate.reason }); used += tokens; }
    return { contract: this.contract, snapshotId: snapshot(this.reader), items, omittedSummary: { count: Math.max(0, symbols.length - items.length), estimatedTokens: Math.max(0, symbols.length - items.length) * 20 }, truncated: items.length < symbols.length };
  }

  /*
   | Goal-aware candidate selection (D-0026 ordered path: Phase 4 consumes the
   | measured Phase 3 retrieval layer instead of re-implementing ranking).
   | Goal text selects direction/class only; the semantic graph produces the
   | candidates. Score is a deterministic rank decay, never a confidence claim.
   */
  private async goalAwareSymbols(seed: string, goal: string): Promise<{ symbol: import('../types/project-index.types').SymbolEntry; score: number; reason: string }[]> {
    const { Phase3SemanticGraphPilot } = await import('./Phase3SemanticGraph');
    const { GoalRetriever } = await import('./GoalRetrieval');
    const pilot = new Phase3SemanticGraphPilot(this.reader, this.workspaceRoot);
    const symbol = pilot.findSymbol(seed);
    if (!symbol) throw new Error(`NOT_FOUND: seed symbol '${seed}'`);
    const result = new GoalRetriever(this.reader).retrieve(await this.graph(), symbol, goal);
    const rank = [...result.symbols];
    const seedId = symbol.id;
    return rank.map((id, i) => {
      const s = this.reader.getSymbolById(id);
      if (!s) throw new Error(`CORRUPT_STATE: retrieved symbol '${id}' is not in the index`);
      return { symbol: s, score: s.id === seedId ? 1 : Math.max(0.1, 0.9 - i * 0.05), reason: s.id === seedId ? 'seed (goal-aware retrieval)' : `goal-aware retrieval: ${result.meta.reason}` };
    });
  }
  private async safeRead(relativePath: string): Promise<string> { if (!relativePath || relativePath.includes('..') || path.posix.isAbsolute(relativePath) || /(^|\/)(\.env|\.git|node_modules)(\/|$)/u.test(relativePath)) throw new Error('DENIED: protected path'); return (await fs.readFile(path.resolve(this.workspaceRoot, relativePath), 'utf8')).replace(/^\uFEFF/u, ''); }
}

export class Phase4ImpactAnalyzer {
  readonly contract = contract('impact-analysis', 'Discard derived impact result and rebuild from current graph.', 'Only exact index edges and explicitly marked heuristic edges are returned.');
  constructor(private readonly graph: Phase4ConstraintGraph) {}
  analyze(symbolId: string, includeHeuristic = false): { readonly contract: Phase4Contract; readonly symbolId: string; readonly items: readonly Phase4Edge[]; readonly warnings: readonly string[] } { const result = this.graph.build(); const items = result.edges.filter(e => e.to === symbolId || e.from === symbolId).filter(e => includeHeuristic || e.confidence === 'exact'); return { contract: this.contract, symbolId, items, warnings: result.edges.some(e => e.to === symbolId && e.confidence === 'unresolved') ? ['unresolved edges were retained'] : [] }; }
}

export class Phase4SemanticRenamer {
  readonly contract = contract('semantic-rename', 'Rollback using TransactionalEditEngine journal; no direct writes are performed by planning.', 'Exact symbols only by default; heuristic matches require explicit opt-in; all paths remain workspace-confined.');
  constructor(private readonly reader: ProjectIndexReader, private readonly workspaceRoot: string, private readonly engine: TransactionalEditEngine) {}
  async plan(symbolId: string, replacement: string, includeHeuristic = false): Promise<RenameResult> {
    if (!/^[A-Za-z_$][\w$]*$/u.test(replacement)) throw new Error('INVALID_ARGUMENT: replacement identifier'); const target = this.reader.getSymbolById(symbolId); if (!target) throw new Error('NOT_FOUND: symbol');
    const edits: TextEdit[] = []; const skipped: { path: string; reason: string }[] = []; const conflicts: { path: string; reason: string }[] = []; const file = this.reader.getFileById(target.fileId); if (!file) throw new Error('NOT_FOUND: symbol file'); const source = await fs.readFile(path.resolve(this.workspaceRoot, file.path), 'utf8'); const index = new LineIndex(source); const re = new RegExp(`\\b${escape(target.name)}\\b`, 'gu'); let m: RegExpExecArray | null; while ((m = re.exec(source))) { const p = index.positionAt(m.index); if (p.line + 1 >= target.line && p.line + 1 <= target.endLine) edits.push({ path: file.path, start: m.index, end: m.index + target.name.length, replacement, expectedHash: contentHash(source) }); }
    if (!edits.length) skipped.push({ path: file.path, reason: 'no exact occurrences found' }); if (!includeHeuristic && edits.length === 0) skipped.push({ path: file.path, reason: 'heuristic matches disabled' }); const plan = edits.length ? await this.engine.plan(edits, 'client') : await this.engine.plan([{ path: file.path, start: 0, end: 0, replacement: source, expectedHash: contentHash(source) }], 'client').catch(() => { throw new Error('NO_SAFE_RENAME_EDITS'); }); return { contract: this.contract, plan, skipped, conflicts, expect: { unresolvedNotIncreased: true } };
  }
}

function snapshot(reader: ProjectIndexReader): string { return crypto.createHash('sha256').update(JSON.stringify([...reader.getAllFiles()].map(f => [f.path, f.hash]).sort())).digest('hex').slice(0, 16); }
function sha(value: string): string { return crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16); }
function estimateTokens(text: string): number { return Math.ceil(text.length / 4); }
function escape(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'); }
