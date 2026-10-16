/**
 * P-07 (§24 / §25) — AI-oriented decision-quality validation.
 *
 * These tests do not exercise code paths; they take the seat of a consuming
 * AI and ask: for a realistic task, is everything the decision needs present
 * in the output, is nothing false present, and does the output ever claim
 * completeness it does not have? A tool that "executes successfully" but
 * leaves the AI unable to answer the task fails here (§13).
 *
 * Fixture: a small project with a *known* semantic shape —
 *
 *   src/core.ts        exports `kernel` (f1)
 *   src/api.ts         exports `login`  (f2)  → calls kernel   (line 7)
 *   src/cli.ts         exports `run`    (f3)  → calls kernel   (line 9)
 *   src/util.ts        exports `pad`    (f4)  → no call on kernel
 *   src/core.test.ts   test file importing core
 *
 * Ground truth the AI is expected to be able to derive:
 *   - kernel is defined in src/core.ts
 *   - exactly 2 distinct callers reference kernel (api.login, cli.run)
 *   - changing kernel impacts 2 files (api, cli), not util
 *   - the answer is complete only when it says so (truncated false).
 */

import { ProjectIndexReader } from '../ProjectIndexReader';
import { ExplainSymbolTool } from './ExplainSymbolTool';
import { ImpactAnalysisTool } from './ImpactAnalysisTool';
import { FindSymbolTool } from './FindSymbolTool';
import { GetDependenciesTool } from './GetDependenciesTool';
import {
  ProjectIndex,
  SymbolEntry,
  FileEntry,
  CallEdge,
  DependencyEdge,
} from '../../core/types/project-index.types';
import { makeConfidence } from '../../core/types/common.types';

const ROOT = '/tmp/p07-fixture';

function file(id: string, p: string, extra: Partial<FileEntry> = {}): FileEntry {
  return {
    id, path: p, language: 'typescript', encoding: 'utf8', size: 100, lines: 20,
    hash: `h-${id}`, modified: '2026-01-01T00:00:00.000Z', binary: false,
    testFile: p.endsWith('.test.ts'), generated: false, imports: [], ...extra,
  } as FileEntry;
}

function symbol(id: string, fileId: string, name: string, line: number): SymbolEntry {
  return {
    id, fileId, parentId: null, kind: 'function', name, fullyQualifiedName: name,
    line, endLine: line + 4, signature: `function ${name}()`, source: 'tree-sitter',
    confidence: makeConfidence(100), exported: true,
  } as SymbolEntry;
}

function call(caller: string, callee: string, line: number): CallEdge {
  return {
    id: `ce-${caller}-${callee}-${line}`, caller, callee, kind: 'direct', line,
    callerKind: 'symbol',
    provenance: { basis: 'ast', confidence: 95, extractor: 'typescript-api' },
  } as CallEdge;
}

function dep(from: string, to: string): DependencyEdge {
  return { from, to, kind: 'import', provenance: { basis: 'import-resolved', confidence: 90, extractor: 'typescript-api' } };
}

function fixtureIndex(): ProjectIndex {
  const files = [
    file('f1', 'src/core.ts'),
    file('f2', 'src/api.ts'),
    file('f3', 'src/cli.ts'),
    file('f4', 'src/util.ts'),
    file('f5', 'src/core.test.ts', { imports: [{ from: './core', type: 'local', resolvedFileId: 'f1', specifiers: [] }] }),
  ];
  const symbols = [
    symbol('s-kernel', 'f1', 'kernel', 3),
    symbol('s-login', 'f2', 'login', 6),
    symbol('s-run', 'f3', 'run', 8),
    symbol('s-pad', 'f4', 'pad', 2),
  ];
  const callGraph = [call('s-login', 's-kernel', 7), call('s-run', 's-kernel', 9)];
  const dependencyGraph = [
    dep('f2', 'f1'), dep('f3', 'f1'), dep('f5', 'f1'),
  ];
  return {
    schemaVersion: '2.0.0', root: 'fixture', rootPath: ROOT,
    generatedAt: '2026-01-01T00:00:00.000Z', languages: ['typescript'],
    files, symbols,
    graphs: {
      callGraph,
      typeGraph: [],
      dependencyGraph,
      reverseDependencyGraph: dependencyGraph.map(d => ({ ...d, from: d.to, to: d.from, kind: 'imported-by' })),
    },
    diagnostics: [],
    metrics: { totalFiles: 5, totalLoc: 100, totalSymbols: 4, avgCyclomaticComplexity: 1, languageBreakdown: { typescript: 5 } },
  } as unknown as ProjectIndex;
}

const reader = () => new ProjectIndexReader(fixtureIndex());

describe('P-07 §25: can a consuming AI make the right decision from this output alone?', () => {
  test('task "where is kernel defined" — explain_symbol answers with path + line, not just a name', async () => {
    const out = await new ExplainSymbolTool(reader()).execute({ name: 'kernel' });
    expect(out.success).toBe(true);
    const e = out.items[0]?.metadata as Record<string, unknown>;
    // The AI needs a location it can act on, plus the facts that make the
    // answer attributable (source/confidence), not merely "found".
    expect(e.file).toBe('src/core.ts');
    expect(e.line).toBe(3);
    expect(e.endLine).toBe(7);
    expect(typeof e.signature).toBe('string');
    expect(e.confidence).toEqual(expect.objectContaining({ symbol: expect.any(Number), source: expect.any(String) }));
    // Completeness is explicit: nothing was cut, so the tool must not leave
    // the AI guessing whether the caller list is everything.
    expect(e.truncated).toEqual(expect.objectContaining({ any: false, calledBy: false }));
    expect(e.calledByCount).toBe(2);
  });

  test('task "who calls kernel" — the caller set equals ground truth and is traceable to files', async () => {
    const out = await new ExplainSymbolTool(reader()).execute({ name: 'kernel' });
    const e = out.items[0]?.metadata as Record<string, unknown>;
    const callers = (e.calledBy as { name: string; path?: string }[]).map(c => c.name).sort();
    // Exactly the two real callers; util.pad must not leak in (a false
    // "impacted" claim is as damaging as a missing one — §15).
    expect(callers).toEqual(['login', 'run']);
    for (const c of e.calledBy as Record<string, unknown>[]) {
      expect(typeof c.path).toBe('string'); // every edge attributable to a file
    }
  });

  test('task "which files change if kernel changes" — impact_analysis returns exactly api+cli (+ test importer when level includes it)', async () => {
    const out = await new ImpactAnalysisTool(reader()).execute({ id: 's-kernel', level: 'file', depth: 2 });
    expect(out.success).toBe(true);
    const paths = out.items.map(i => i.path).filter(Boolean).sort();
    expect(paths).toContain('src/api.ts');
    expect(paths).toContain('src/cli.ts');
    expect(paths).not.toContain('src/util.ts'); // no call → never claimed impacted
    const meta = out.metadata as Record<string, unknown>;
    expect(meta.truncated).toBe(false);
    expect(meta.candidateCount).toBe(out.items.length);
  });

  test('budget cut is never reported as complete (§24b): a capped impact page says so', async () => {
    /*
    | Ground truth above is small; to test the *claim*, widen the fixture
    | programmatically: many callers, one page. The AI must be able to see
    | that more exist and therefore must not stop at this answer.
    */
    const files = [file('f1', 'src/core.ts')];
    const symbols = [symbol('s-kernel', 'f1', 'kernel', 3)];
    const callGraph: CallEdge[] = [];
    for (let i = 0; i < 10; i++) {
      files.push(file(`fc${i}`, `src/caller${i}.ts`));
      symbols.push(symbol(`sc${i}`, `fc${i}`, `c${i}`, 2));
      callGraph.push(call(`sc${i}`, 's-kernel', 3));
    }
    const index = {
      schemaVersion: '2.0.0', root: 'fixture', rootPath: ROOT,
      generatedAt: '2026-01-01T00:00:00.000Z', languages: ['typescript'],
      files, symbols,
      graphs: { callGraph, typeGraph: [], dependencyGraph: [] },
      diagnostics: [],
      metrics: { totalFiles: 11, totalLoc: 220, totalSymbols: 11, avgCyclomaticComplexity: 1, languageBreakdown: { typescript: 11 } },
    } as unknown as ProjectIndex;
    const rich = new ProjectIndexReader(index);

    const impact = await new ImpactAnalysisTool(rich).execute({ id: 's-kernel', level: 'symbol', depth: 2, limit: 4 });
    const imeta = impact.metadata as Record<string, unknown>;
    expect(impact.items).toHaveLength(4);
    expect(imeta.truncated).toBe(true);           // the cap is declared
    expect(imeta.droppedByLimit).toBe(true);      // and attributed to the page, not the walk
    expect(imeta.candidateCount).toBe(10);        // honest total before slicing

    const explained = await new ExplainSymbolTool(rich).execute({ id: 's-kernel', limit: 4 });
    const emeta = explained.items[0]?.metadata as Record<string, unknown>;
    expect(emeta.calledByCount).toBe(10);
    expect((emeta.truncated as Record<string, unknown>).calledBy).toBe(true);

    /*
    | The decision the AI must be able to make from the metadata alone:
    | "4 of 10 — raise the limit". Nothing in the payload forces it to
    | guess from list length, and nothing claims completeness.
    */
  });

  test('empty scope is honest, not silence (§16): kernel with no callers says so', async () => {
    const out = await new ExplainSymbolTool(reader()).execute({ name: 'pad' });
    const e = out.items[0]?.metadata as Record<string, unknown>;
    expect((e.calledBy as unknown[])).toHaveLength(0);
    expect(e.calledByCount).toBe(0);
    expect((e.truncated as Record<string, unknown>).any).toBe(false);
    // A zero answer is machine-distinct from a hidden/capped answer.
    expect(e.diagnosticsNote === undefined || typeof e.diagnosticsNote === 'string').toBe(true);
  });

  test('provenance stays traceable through the answer (§14 traceability)', async () => {
    const out = await new ExplainSymbolTool(reader()).execute({ name: 'kernel' });
    const e = out.items[0]?.metadata as Record<string, unknown>;
    for (const c of e.calledBy as Record<string, unknown>[]) {
      expect(c).toEqual(expect.objectContaining({
        confidence: expect.any(Number), // each edge carries its own trust
      }));
    }
    expect(typeof (e.confidence as Record<string, unknown>).source).toBe('string'); // which extractor claimed it
  });

  test('get_dependencies agrees with impact_analysis on the same question (cross-tool consistency, §14)', async () => {
    /*
    | دو ابزار، یک پرسش: «چه چیزی به core.ts وابسته است». اگر جواب‌شان
    | DIFFER کند و هیچ‌کدام نگوید کدام کامل است، AI نمی‌تواند اتکا کند.
    */
    const r = reader();
    const deps = await new GetDependenciesTool(r).execute({ id: 'f1', direction: 'backward', depth: 1 });
    const depPaths = deps.items.map(i => i.path).filter(Boolean).sort();
    expect(depPaths).toContain('src/api.ts');
    expect(depPaths).toContain('src/cli.ts');
    expect(depPaths).toContain('src/core.test.ts');
    expect(depPaths).not.toContain('src/util.ts');

    const impact = await new ImpactAnalysisTool(r).execute({ id: 'f1', level: 'file', depth: 1, minConfidence: 0 });
    const impactPaths = impact.items.map(i => i.path).filter(Boolean).sort();
    for (const p of depPaths) {
      expect(impactPaths).toContain(p); // impact must not contradict a dependency edge
    }
  });

  test('find_symbol answers "where is it defined" with the real definition site', async () => {
    const out = await new FindSymbolTool(reader()).execute({ name: 'kernel' });
    expect(out.success).toBe(true);
    expect(out.items[0]).toEqual(expect.objectContaining({ name: 'kernel', path: 'src/core.ts', line: 3 }));
    expect(out.metadata).toEqual(expect.objectContaining({ matchCount: 1, truncated: false }));
  });
});