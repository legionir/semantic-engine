import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ProjectIndexReader } from '../../ai/ProjectIndexReader';
import { Phase3SemanticGraphPilot } from './Phase3SemanticGraph';
import { GoalRetriever, CUE_LEXICON } from './GoalRetrieval';
import { ProjectIndex, SymbolEntry } from '../types/project-index.types';
import { makeConfidence } from '../types/common.types';

/*
 * Executed verification tests for the Spike-S resolution fixes F1–F7 and the
 * goal-aware retrieval layer (docs/validation/spike-s/retrieval-design.md §5).
 */

const FILES: Record<string, string> = {
  'src/math.ts': 'export function add(a: number, b: number) {\n  return a + b;\n}\n\nexport function sub(a: number, b: number) {\n  return a - b;\n}\n',
  'src/use.ts': "import { add } from './math';\nexport const total = add(1, 2);\nexport const double = add(total, total);\n// add is great, use add everywhere\n",
  'src/calc.ts': "import { add, sub } from './math';\nexport const r = add(sub(5, 1), 2);\n",
  'src/shadow.ts': "import { add } from './math';\nexport function f(add: number) {\n  return add + 1;\n}\n",
  'src/mid.ts': "export { add } from './math';\n",
  'src/via.ts': "import { add } from './mid';\nexport const v = add(9, 9);\n",
  'src/dup.ts': 'export function fmt(a: string): string {\n  return a;\n}\nexport function fmt(a: number): number {\n  return a;\n}\n',
  'src/usesfmt.ts': "import { fmt } from './dup';\nexport const o = fmt('x');\n",
  'src/store.ts': 'export default class Store {\n  items: string[] = [];\n}\n',
  'src/admin.ts': "import Store from './store';\nexport const s = new Store();\n",
  'src/probes.ts': "import { add } from './math';\nexport const tag = 'add';\nconst conf = { add: 1 };\nconst picked = conf.add;\n",
  'src/app.ts': "import { total } from './use';\nimport { v } from './via';\nimport * as fs from 'fs';\nexport const grand = total + v;\nconsole.log(grand);\n",
};

function symbol(id: string, fileId: string, kind: SymbolEntry['kind'], name: string, line: number, endLine: number): SymbolEntry {
  return { id, fileId, parentId: null, kind, name, fullyQualifiedName: name, line, endLine, exported: true, source: 'typescript-api', confidence: makeConfidence(100) };
}

function index(): ProjectIndex {
  const fileIds: Record<string, string> = {};
  const files = Object.keys(FILES).map((p) => {
    const id = `f-${path.basename(p, '.ts')}`;
    fileIds[p] = id;
    return { id, path: p, language: 'typescript', encoding: 'utf8', size: FILES[p].length, lines: FILES[p].split('\n').length - 1, hash: `h-${id}`, modified: '2026-01-01T00:00:00Z', binary: false, testFile: false, generated: false };
  });
  const symbols = [
    symbol('s-add', fileIds['src/math.ts'], 'function', 'add', 1, 3),
    symbol('s-sub', fileIds['src/math.ts'], 'function', 'sub', 5, 7),
    symbol('s-total', fileIds['src/use.ts'], 'variable', 'total', 2, 2),
    symbol('s-double', fileIds['src/use.ts'], 'variable', 'double', 3, 3),
    symbol('s-r', fileIds['src/calc.ts'], 'variable', 'r', 2, 2),
    symbol('s-f', fileIds['src/shadow.ts'], 'function', 'f', 2, 4),
    symbol('s-v', fileIds['src/via.ts'], 'variable', 'v', 2, 2),
    symbol('s-fmt1', fileIds['src/dup.ts'], 'function', 'fmt', 1, 3),
    symbol('s-fmt2', fileIds['src/dup.ts'], 'function', 'fmt', 4, 6),
    symbol('s-o', fileIds['src/usesfmt.ts'], 'variable', 'o', 2, 2),
    symbol('s-store', fileIds['src/store.ts'], 'class', 'Store', 1, 3),
    symbol('s-s', fileIds['src/admin.ts'], 'variable', 's', 2, 2),
    symbol('s-tag', fileIds['src/probes.ts'], 'variable', 'tag', 2, 2),
    symbol('s-grand', fileIds['src/app.ts'], 'variable', 'grand', 4, 4),
  ];
  return {
    schemaVersion: '2.0.0', root: 'fixture', rootPath: '/', generatedAt: '2026-01-01T00:00:00Z', languages: ['typescript'],
    files, symbols,
    graphs: { callGraph: [], typeGraph: [], dependencyGraph: [], reverseDependencyGraph: [] },
    diagnostics: [],
    metrics: { totalFiles: files.length, totalLoc: 40, totalSymbols: symbols.length, avgCyclomaticComplexity: 1, languageBreakdown: { typescript: files.length } },
  };
}

async function withRoot<T>(fn: (root: string, reader: ProjectIndexReader, pilot: Phase3SemanticGraphPilot) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'phase3-fix-'));
  try {
    for (const [rel, content] of Object.entries(FILES)) {
      await fs.mkdir(path.join(root, path.dirname(rel)), { recursive: true });
      await fs.writeFile(path.join(root, rel), content);
    }
    const reader = new ProjectIndexReader(index());
    return await fn(root, reader, new Phase3SemanticGraphPilot(reader, root));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe('F1 — occurrence classification and scope-aware binding', () => {
  it('binds a shadowing parameter locally: not a reference to the imported symbol', async () => {
    await withRoot(async (_root, _reader, pilot) => {
      const graph = await pilot.build();
      const shadowRefs = graph.references.filter(r => r.sourcePath === 'src/shadow.ts');
      expect(shadowRefs).toHaveLength(0);
      const hard = graph.hardBindings.filter(h => h.sourcePath === 'src/shadow.ts');
      expect(hard).toHaveLength(1);
      expect(hard[0]).toMatchObject({ name: 'add', kind: 'local-shadow', line: 3, sourceEnclosingSymbolId: 's-f' });
    });
  });

  it('classifies comment, string and property occurrences as non-references', async () => {
    await withRoot(async (_root, _reader, pilot) => {
      const graph = await pilot.build();
      // use.ts L4 comment mentions add twice; probes.ts has 'add' in a string and as a property.
      const useAudit = graph.occurrenceAudit.find(a => a.path === 'src/use.ts');
      const probesAudit = graph.occurrenceAudit.find(a => a.path === 'src/probes.ts');
      expect(useAudit?.byClass.comment).toBe(2);
      expect(probesAudit?.byClass.string).toBe(1);
      expect(probesAudit?.byClass['property-key']).toBe(1);
      expect(probesAudit?.byClass['property-access']).toBe(1);
      expect(graph.references.filter(r => r.sourcePath === 'src/probes.ts')).toHaveLength(0);
    });
  });
});

describe('F2 — multi-name import binding', () => {
  it('binds every named specifier of an import statement', async () => {
    await withRoot(async (_root, _reader, pilot) => {
      const graph = await pilot.build();
      const calcRefs = graph.references.filter(r => r.sourcePath === 'src/calc.ts');
      expect(calcRefs.map(r => r.targetSymbolId).sort()).toEqual(['s-add', 's-sub']);
    });
  });
});

describe('F3 — same-file references', () => {
  it('counts uses of a symbol inside its own file', async () => {
    await withRoot(async (_root, _reader, pilot) => {
      const graph = await pilot.build();
      const sameFileTotal = graph.references.filter(r => r.targetSymbolId === 's-total' && r.bindingKind === 'same-file');
      expect(sameFileTotal).toHaveLength(2); // add(total, total) on L3 of use.ts
      expect(sameFileTotal.every(r => r.sourceEnclosingSymbolId === 's-double')).toBe(true);
    });
  });
});

describe('F4 — bidirectional reference graph', () => {
  it('exposes outgoing references of a symbol', async () => {
    await withRoot(async (_root, reader, pilot) => {
      const { references } = await pilot.outgoingFor('s-grand');
      expect([...new Set(references.map(r => r.targetSymbolId))].sort()).toEqual(['s-total', 's-v']);
    });
  });
});

describe('F5 — default and re-export routing', () => {
  it('binds a default import to the default-exported symbol', async () => {
    await withRoot(async (_root, _reader, pilot) => {
      const graph = await pilot.build();
      const storeRef = graph.references.find(r => r.sourcePath === 'src/admin.ts');
      expect(storeRef).toMatchObject({ targetSymbolId: 's-store', bindingKind: 'default-routed', sourceEnclosingSymbolId: 's-s' });
      expect(storeRef?.provenance.confidence).toBe('exact');
    });
  });

  it('routes a re-exported import to its origin across the export-from hop', async () => {
    await withRoot(async (_root, _reader, pilot) => {
      const graph = await pilot.build();
      const viaRef = graph.references.find(r => r.sourcePath === 'src/via.ts');
      expect(viaRef).toMatchObject({ targetSymbolId: 's-add', bindingKind: 're-export-routed', sourceEnclosingSymbolId: 's-v' });
      expect(graph.fileDeps.some(d => d.specifier === './math' && d.resolved && graph.references.length >= 0)).toBe(true);
    });
  });

  it('records the export-from file dependency edge', async () => {
    await withRoot(async (_root, reader, pilot) => {
      const graph = await pilot.build();
      const mid = graph.fileDeps.find(d => d.fromFileId === 'f-mid');
      expect(mid).toBeDefined();
      expect(reader.getFileById(mid?.toFileId ?? '')?.path).toBe('src/math.ts');
      expect(mid?.resolved).toBe(true);
    });
  });

  it('records unresolved imports instead of dropping them', async () => {
    await withRoot(async (_root, _reader, pilot) => {
      const graph = await pilot.build();
      expect(graph.unresolved.map(u => u.name)).toEqual(['fs']);
      expect(graph.unresolved[0].reason).toContain('unresolved namespace import');
    });
  });
});

describe('F6 — collision-free symbol keys', () => {
  it('gives same-name overloads distinct keys, both retrievable', async () => {
    await withRoot(async (_root, reader, pilot) => {
      const fmt1 = reader.getSymbolById('s-fmt1');
      const fmt2 = reader.getSymbolById('s-fmt2');
      const key1 = pilot.symbolKey(fmt1 as SymbolEntry);
      const key2 = pilot.symbolKey(fmt2 as SymbolEntry);
      expect(key1).not.toBe(key2);
      const first = await pilot.referencesFor(fmt1 as SymbolEntry);
      const second = await pilot.referencesFor(fmt2 as SymbolEntry);
      expect(first.references).toHaveLength(1);
      expect(second.references).toHaveLength(1);
      expect(first.references[0].provenance.confidence).toBe('ambiguous');
    });
  });
});

describe('F7 — binding-kind tagging with zero silent drops', () => {
  it('classifies every candidate occurrence and tags every reference', async () => {
    await withRoot(async (_root, _reader, pilot) => {
      const graph = await pilot.build();
      expect(graph.occurrenceAudit.every(a => a.byClass.unclassified === 0)).toBe(true);
      expect(graph.occurrenceAudit.every(a => a.total === Object.values(a.byClass).reduce((x, y) => x + y, 0))).toBe(true);
      expect(graph.references.every(r => r.bindingKind !== undefined)).toBe(true);
      expect(graph.hardBindings.every(h => h.kind === 'local-shadow' || h.kind === 'unresolved-use')).toBe(true);
    });
  });
});

describe('Goal-aware retrieval', () => {
  it('fires cues per the frozen lexicon: voice and position rules', async () => {
    await withRoot(async (_root, reader, pilot) => {
      const retriever = new GoalRetriever(reader);
      const add = reader.getSymbolById('s-add') as SymbolEntry;
      const o = reader.getSymbolById('s-o') as SymbolEntry;
      expect(retriever.fireCues('Show all usages of add', add).direction).toBe('REFERRERS');
      expect(retriever.fireCues('Trace grand back to its sources through the import chain', add).direction).toBe('CHAIN');
      expect(retriever.fireCues('Which fmt overload does o call?', o).direction).toBe('DEPENDEES');
      expect(retriever.fireCues('Show references the resolver cannot bind', add).direction).toBe('HARD_SURFACE');
      expect(retriever.fireCues('Show the add function itself', add).direction).toBe('SINGLETON');
      expect(retriever.fireCues('add', add).direction).toBe('REFERRERS');
      expect(retriever.fireCues('everything that uses addition', add).direction).toBe('REFERRERS');
      const blind = retriever.fireCues('Show all usages of add', add, { cuesEnabled: false });
      expect(blind.direction).toBe('REFERRERS');
      expect(blind.winning).toBeNull();
    });
  });

  it('retrieves referrers, chains, hard surfaces and ambiguous groups', async () => {
    await withRoot(async (_root, reader, pilot) => {
      const graph = await pilot.build();
      const retriever = new GoalRetriever(reader);
      const add = reader.getSymbolById('s-add') as SymbolEntry;
      const v = reader.getSymbolById('s-v') as SymbolEntry;
      const double = reader.getSymbolById('s-double') as SymbolEntry;
      const fmt1 = reader.getSymbolById('s-fmt1') as SymbolEntry;

      expect(retriever.retrieve(graph, add, 'Show all usages of add').symbols.slice().sort()).toEqual(['s-add', 's-double', 's-r', 's-total', 's-v']);
      expect(retriever.retrieve(graph, v, 'Show the chain behind v').symbols.slice().sort()).toEqual(['s-add', 's-grand', 's-v']);
      const hard = retriever.retrieve(graph, double, 'Show references the resolver cannot bind');
      expect(hard.symbols.slice().sort()).toEqual(['s-double', 's-f', 's-s', 's-v']);
      const ambiguous = retriever.retrieve(graph, fmt1, 'Find the helper that formats output');
      expect(ambiguous.symbols.slice().sort()).toEqual(['s-fmt1', 's-fmt2', 's-o']);
    });
  });

  it('never lets the goal cue raise confidence: meta only, deterministic budget', async () => {
    await withRoot(async (_root, reader, pilot) => {
      const graph = await pilot.build();
      const retriever = new GoalRetriever(reader);
      const add = reader.getSymbolById('s-add') as SymbolEntry;
      const aware = retriever.retrieve(graph, add, 'Show all usages of add');
      const blind = retriever.retrieve(graph, add, '', { cuesEnabled: false });
      expect(aware.meta.cue?.patternId).toBe('R4'); // 'usages of' — earliest span, then longer match wins
      expect(blind.meta.cue).toBeNull();
      expect(blind.meta.reason).toBe('default-blind');
      const truncated = retriever.retrieve(graph, add, 'Show all usages of add', { maxSymbols: 2 });
      expect(truncated.symbols[0]).toBe('s-add');
      expect(truncated.meta.truncated).toBe(true);
      expect(truncated.meta.droppedCount).toBe(3);
      expect(aware.symbols).toEqual(retriever.retrieve(graph, add, 'Show all usages of add').symbols);
    });
  });

  it('ablations remove exactly their class', async () => {
    await withRoot(async (_root, reader, pilot) => {
      const graph = await pilot.build();
      const retriever = new GoalRetriever(reader);
      const o = reader.getSymbolById('s-o') as SymbolEntry;
      expect(retriever.fireCues('Which fmt overload does o call?', o).direction).toBe('DEPENDEES');
      expect(retriever.fireCues('Which fmt overload does o call?', o, { disabledClasses: ['DEPENDEES'] }).direction).toBe('REFERRERS');
      const noExpansion = retriever.retrieve(graph, o, 'Which fmt overload does o call?', { disableAmbiguityExpansion: true });
      expect(noExpansion.symbols).toEqual(['s-o']);
    });
  });
});

describe('Cue lexicon anti-gaming invariants', () => {
  it('is the frozen v1.0.0 with 18 patterns and the documented priority', () => {
    expect(CUE_LEXICON.version).toBe('1.0.0');
    expect(CUE_LEXICON.patterns).toHaveLength(18);
    expect(CUE_LEXICON.priority).toEqual(['HARD_SURFACE', 'CHAIN', 'SINGLETON', 'DEPENDEES', 'REFERRERS']);
    expect(CUE_LEXICON.defaults.direction).toBe('REFERRERS');
    expect(CUE_LEXICON.budgetBehavior.maxSymbols).toBe(64);
  });

  it('matches no fixture identifier except the allowlisted generic verb "use"', () => {
    const identifiers = ['add', 'sub', 'PI', 'total', 'double', 'r', 'r2', 'v', 'f', 'fmt', 'o', 'lonely', 'grand', 'Store', 's', 'math', 'calc', 'shadow', 'mid', 'via', 'dup', 'usesfmt', 'admin', 'app', 'unused', 'store', 'use', 'fs', 'ghost', 'tokenize', 'score', 'layout', 'LIMIT', 'pairs', 'triple', 'census', 'summary', 'stage', 'fold', 'rate', 'verdict', 'prize', 'wrap', 'panel', 'page', 'note', 'bag', 'picked', 'solo', 'phantom', 'nodefs', 'tk', 'inner', 'mapper', 'both'];
    const allowlist = new Set(['use']);
    for (const pattern of CUE_LEXICON.patterns) {
      const re = new RegExp(pattern.regex, pattern.flags);
      for (const id of identifiers) {
        const m = id.match(re);
        if (m && m[0] === id) expect(allowlist.has(id)).toBe(true);
      }
    }
  });
});

describe('F5 — export-* star conflicts', () => {
  const STAR_FILES: Record<string, string> = {
    'src/one.ts': 'export function rate(n: number): number {\n  return n + 1;\n}\n',
    'src/two.ts': 'export function rate(n: number): number {\n  return n + 2;\n}\n',
    'src/star.ts': "export * from './one';\nexport * from './two';\n",
    'src/consumer.ts': "import { rate } from './star';\nexport const prize = rate(3);\n",
  };
  it('surfaces a star conflict as ambiguous instead of silently picking one', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'phase3-star-'));
    try {
      for (const [rel, content] of Object.entries(STAR_FILES)) {
        await fs.mkdir(path.join(root, path.dirname(rel)), { recursive: true });
        await fs.writeFile(path.join(root, rel), content);
      }
      const files = Object.keys(STAR_FILES).map((p, i) => ({ id: `g-${i}`, path: p, language: 'typescript', encoding: 'utf8', size: STAR_FILES[p].length, lines: STAR_FILES[p].split('\n').length - 1, hash: `h-${i}`, modified: '2026-01-01T00:00:00Z', binary: false, testFile: false, generated: false }));
      const symbols = [
        symbol('s-rate-one', 'g-0', 'function', 'rate', 1, 3),
        symbol('s-rate-two', 'g-1', 'function', 'rate', 1, 3),
        symbol('s-prize', 'g-3', 'variable', 'prize', 2, 2),
      ];
      const idx: ProjectIndex = {
        schemaVersion: '2.0.0', root: 'fixture', rootPath: '/', generatedAt: '2026-01-01T00:00:00Z', languages: ['typescript'],
        files, symbols, graphs: { callGraph: [], typeGraph: [], dependencyGraph: [], reverseDependencyGraph: [] }, diagnostics: [],
        metrics: { totalFiles: files.length, totalLoc: 10, totalSymbols: symbols.length, avgCyclomaticComplexity: 1, languageBreakdown: { typescript: files.length } },
      };
      const reader = new ProjectIndexReader(idx);
      const graph = await new Phase3SemanticGraphPilot(reader, root).build();
      const ref = graph.references.find(r => r.sourcePath === 'src/consumer.ts');
      expect(ref?.provenance.confidence).toBe('ambiguous');
      expect(ref?.provenance.candidates.map(c => c.symbolId).sort()).toEqual(['s-rate-one', 's-rate-two']);
      expect(ref?.bindingKind).toBe('re-export-routed');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
