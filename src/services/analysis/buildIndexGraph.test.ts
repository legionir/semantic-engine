import { ProjectIndexReader } from '../../ai/ProjectIndexReader';
import { SimulateMutationTool } from '../../ai/tools/SimulateMutationTool';
import { buildIndexGraph } from './buildIndexGraph';
import { MutationSimulator } from './MutationSimulator';
import type { ProjectIndex } from '../../core/types/project-index.types';

/*
| Regression lock for the agent-facing honesty bug: renaming an exported
| class that is imported *by name* was reported as "safe, 0 broken refs"
| because the mutation graph only had file->file depends_on and call edges,
| never a symbol-level import edge. Nine real importers proved it wrong.
*/

const provenance = { extractor: 'tree-sitter', confidence: 95, basis: 'resolved' } as const;

const index = {
  schemaVersion: '2.0.0',
  root: 'demo',
  generatedAt: new Date().toISOString(),
  languages: ['typescript'],
  files: [
    {
      id: 'fa', path: 'src/lib.ts', language: 'typescript', binary: false,
      testFile: false, generated: false, size: 100, lines: 5, hash: 'h1', encoding: 'utf8', modified: 'x',
      exports: [{ name: 'Thing', kind: 'named', symbolId: 'sa' }],
    },
    {
      id: 'fb', path: 'src/app.ts', language: 'typescript', binary: false,
      testFile: false, generated: false, size: 80, lines: 4, hash: 'h2', encoding: 'utf8', modified: 'x',
      imports: [
        { from: './lib', type: 'local', resolvedFileId: 'fa', specifiers: [{ imported: 'Thing' }] },
      ],
    },
    {
      // imports a *different* name from the same module — must NOT break.
      id: 'fc', path: 'src/other.ts', language: 'typescript', binary: false,
      testFile: false, generated: false, size: 80, lines: 4, hash: 'h3', encoding: 'utf8', modified: 'x',
      imports: [
        { from: './lib', type: 'local', resolvedFileId: 'fa', specifiers: [{ imported: 'Unrelated' }] },
      ],
    },
  ],
  symbols: [
    { id: 'sa', fileId: 'fa', parentId: null, kind: 'class', name: 'Thing', line: 1, endLine: 3, exported: true, source: 'tree-sitter', confidence: 'high' },
  ],
  graphs: {
    dependencyGraph: [
      { from: 'fb', to: 'fa', kind: 'import', provenance },
      { from: 'fc', to: 'fa', kind: 'import', provenance },
    ],
    callGraph: [],
    typeGraph: [],
  },
  metrics: { totalFiles: 3, totalLoc: 0, totalSymbols: 1, avgCyclomaticComplexity: 0, languageBreakdown: {} },
} as unknown as ProjectIndex;

describe('buildIndexGraph reference edges → simulate_mutation honesty', () => {
  it('rename of a name-imported class reports the importing file as broken', async () => {
    const reader = new ProjectIndexReader(index);
    const tool = new SimulateMutationTool(reader);
    const result = await tool.execute({ actionType: 'rename_symbol', targetSymbolId: 'sa', newName: 'Renamed' });

    expect(result.success).toBe(true);
    const brokenPaths = (result.items || []).map(i => i.path);
    expect(brokenPaths).toContain('src/app.ts');
    // a file that imports an unrelated name from the same module is NOT broken
    expect(brokenPaths).not.toContain('src/other.ts');
    expect(result.context).not.toMatch(/safe with 0 broken/);
  });

  it('without referenceEdges the same rename still looks "safe" (documents the gap the fix closes)', () => {
    const reader = new ProjectIndexReader(index);
    const graph = buildIndexGraph(reader, { callEdges: true });
    const diff = new MutationSimulator().simulate(graph, { type: 'rename_symbol', targetSymbolId: 'sa', newName: 'X' });
    expect(diff.brokenReferences.length).toBe(0);

    const withRefs = buildIndexGraph(reader, { callEdges: true, referenceEdges: true });
    const fixed = new MutationSimulator().simulate(withRefs, { type: 'rename_symbol', targetSymbolId: 'sa', newName: 'X' });
    expect(fixed.brokenReferences.length).toBe(1);
    expect(fixed.isSafe).toBe(false);
  });
});
