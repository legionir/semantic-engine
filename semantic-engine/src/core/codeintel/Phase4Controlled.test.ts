import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ProjectIndexReader } from '../../ai/ProjectIndexReader';
import { Phase4ProviderRegistry, Phase4ConstraintGraph, Phase4ContextBuilder, Phase4ImpactAnalyzer, Phase4SemanticRenamer } from './Phase4Controlled';
import { TransactionalEditEngine } from './Phase2Transactions';
import { makeConfidence } from '../types/common.types';

function reader(): ProjectIndexReader {
  const file = { id: 'f1', path: 'src/a.ts', language: 'typescript', encoding: 'utf8', size: 10, lines: 1, hash: 'h1', modified: '2026-01-01T00:00:00Z', binary: false, testFile: false, generated: false, imports: [], symbolIds: ['s1'] };
  const test = { id: 'ft', path: 'src/a.test.ts', language: 'typescript', encoding: 'utf8', size: 10, lines: 1, hash: 'ht', modified: '2026-01-01T00:00:00Z', binary: false, testFile: true, generated: false, imports: [], symbolIds: [] };
  const symbol = { id: 's1', fileId: 'f1', parentId: null, kind: 'function', name: 'alpha', fullyQualifiedName: 'alpha', line: 1, endLine: 1, exported: true, calls: [], source: 'parser', confidence: 'high' };
  return new ProjectIndexReader({ schemaVersion: '2.0.0', root: 'fixture', generatedAt: '2026-01-01T00:00:00Z', languages: ['typescript'], files: [file, test], symbols: [symbol], graphs: { callGraph: [], typeGraph: [], dependencyGraph: [], reverseDependencyGraph: [] }, diagnostics: [], metrics: {} } as any);
}

describe('Phase 4 controlled expansion', () => {
  test('provider statuses are explicit and Python parser is deterministic', () => {
    const registry = new Phase4ProviderRegistry();
    expect(registry.status('python')).toBe('degraded');
    expect(registry.status('rust')).toBe('unavailable');
    const result = registry.parsePython('import os\n\ndef alpha():\n    return 1\n', 'main.py');
    expect(result.imports).toEqual(['os']);
    expect(result.symbols[0].key).toContain('main.py::alpha::function');
    expect(result.symbols[0].confidence).toBe('heuristic');
  });

  test('constraint graph retains test and index provenance', () => {
    const graph = new Phase4ConstraintGraph(reader()).build();
    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges.some(e => e.kind === 'hasTest')).toBe(false);
    expect(graph.edges.every(e => e.provenance === 'index' || e.provenance === 'filename-heuristic')).toBe(true);
  });

  test('context builder enforces budget and produces stable snapshot', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'phase4-'));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/a.ts'), 'export function alpha() { return 1; }');
    const result = await new Phase4ContextBuilder(reader(), root).build('alpha', 100);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].excerpt).toContain('alpha');
    expect(result.snapshotId).toHaveLength(16);
    await fs.rm(root, { recursive: true, force: true });
  });

  test('context builder rejects invalid budgets and protected paths', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'phase4-'));
    await expect(new Phase4ContextBuilder(reader(), root).build('alpha', 0)).rejects.toThrow('budgetTokens');
    await fs.rm(root, { recursive: true, force: true });
  });

  test('impact analysis excludes heuristic edges unless explicitly requested', () => {
    const result = new Phase4ImpactAnalyzer(new Phase4ConstraintGraph(reader())).analyze('s1');
    expect(result.items.every(item => item.confidence === 'exact')).toBe(true);
    expect(result.contract.experimental).toBe(true);
  });

  test('semantic rename creates a plan and never applies it', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'phase4-'));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    const source = 'export function alpha() { return alpha(); }';
    await fs.writeFile(path.join(root, 'src/a.ts'), source);
    const engine = new TransactionalEditEngine(root, '.journal');
    const result = await new Phase4SemanticRenamer(reader(), root, engine).plan('s1', 'beta');
    expect(result.plan.edits.length).toBeGreaterThan(0);
    expect(result.plan.approved).toBe(false);
    expect(await fs.readFile(path.join(root, 'src/a.ts'), 'utf8')).toBe(source);
    expect(result.expect.unresolvedNotIncreased).toBe(true);
    await fs.rm(root, { recursive: true, force: true });
  });

  test('rename rejects invalid identifiers before planning', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'phase4-'));
    const engine = new TransactionalEditEngine(root, '.journal');
    await expect(new Phase4SemanticRenamer(reader(), root, engine).plan('s1', 'not-valid-name')).rejects.toThrow('replacement identifier');
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe('Phase 4 goal-aware context building (D-0027 gate: recall@budget)', () => {
  const FILES: Record<string, string> = {
    'src/math.ts': 'export function add(a: number, b: number) {\n  return a + b;\n}\n',
    'src/use.ts': "import { add } from './math';\nexport const total = add(1, 2);\n",
    'src/count.ts': "import { total } from './use';\nexport const grand = total * 2;\n",
  };
  function goalReader() {
    const files = Object.keys(FILES).map((p, i) => ({ id: `f${i}`, path: p, language: 'typescript', encoding: 'utf8', size: FILES[p].length, lines: FILES[p].split('\n').length - 1, hash: `h${i}`, modified: '2026-01-01T00:00:00Z', binary: false, testFile: false, generated: false }));
    const symbols: import('../types/project-index.types').SymbolEntry[] = [
      { id: 's-add', fileId: 'f0', parentId: null, kind: 'function', name: 'add', fullyQualifiedName: 'add', line: 1, endLine: 3, exported: true, source: 'typescript-api', confidence: makeConfidence(100) },
      { id: 's-total', fileId: 'f1', parentId: null, kind: 'variable', name: 'total', fullyQualifiedName: 'total', line: 2, endLine: 2, exported: true, source: 'typescript-api', confidence: makeConfidence(100) },
      { id: 's-grand', fileId: 'f2', parentId: null, kind: 'variable', name: 'grand', fullyQualifiedName: 'grand', line: 2, endLine: 2, exported: true, source: 'typescript-api', confidence: makeConfidence(100) },
    ];
    return new ProjectIndexReader({ schemaVersion: '2.0.0', root: 'fixture', rootPath: '/', generatedAt: '2026-01-01T00:00:00Z', languages: ['typescript'], files, symbols, graphs: { callGraph: [], typeGraph: [], dependencyGraph: [], reverseDependencyGraph: [] }, diagnostics: [], metrics: { totalFiles: 3, totalLoc: 7, totalSymbols: 3, avgCyclomaticComplexity: 1, languageBreakdown: { typescript: 3 } } });
  }
  async function goalRoot() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'phase4-goal-'));
    for (const [rel, content] of Object.entries(FILES)) { await fs.mkdir(path.join(root, path.dirname(rel)), { recursive: true }); await fs.writeFile(path.join(root, rel), content); }
    return root;
  }

  test('goal-aware build recalls the transitive closure within budget, name-only does not', async () => {
    const root = await goalRoot();
    try {
      const builder = new Phase4ContextBuilder(goalReader(), root);
      const result = await builder.build('grand', 2000, 100, 'Show grand and everything it depends on transitively');
      const paths = result.items.map(i => i.path);
      expect(paths).toContain('src/math.ts');
      expect(paths).toContain('src/use.ts');
      expect(paths).toContain('src/count.ts');
      expect(result.items.every(i => i.reason.startsWith('goal-aware') || i.reason.startsWith('seed'))).toBe(true);
      const used = result.items.reduce((a, i) => a + Math.ceil(i.excerpt.length / 4), 0);
      expect(used).toBeLessThanOrEqual(2000);
      const legacy = await builder.build('grand', 2000, 100);
      expect(legacy.items.map(i => i.path)).toEqual(['src/count.ts']); // name-only: seed file only
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  test('goal-aware build is deterministic and fails closed on unknown seed', async () => {
    const root = await goalRoot();
    try {
      const builder = new Phase4ContextBuilder(goalReader(), root);
      const a = JSON.stringify(await builder.build('add', 500, 100, 'Show all usages of add'));
      const b = JSON.stringify(await builder.build('add', 500, 100, 'Show all usages of add'));
      expect(a).toBe(b);
      await expect(builder.build('nonexistent', 500, 100, 'anything')).rejects.toThrow('NOT_FOUND');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
