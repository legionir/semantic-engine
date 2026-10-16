import { AnalysisGraph } from './AnalysisGraph';
import { MutationSimulator } from './MutationSimulator';
import { SimulateMutationTool } from '../../ai/tools/SimulateMutationTool';
import type { ProjectIndexReader } from '../../ai/ProjectIndexReader';

describe('MutationSimulator — phase 4 move_symbol', () => {
  function graphWithMovedSymbol(): AnalysisGraph {
    const graph = new AnalysisGraph();
    graph.addNode({ id: 'old-file', type: 'file', label: 'src/old.ts', metadata: { path: 'src/old.ts' } });
    graph.addNode({ id: 'consumer-file', type: 'file', label: 'src/consumer.ts', metadata: { path: 'src/consumer.ts' } });
    graph.addNode({ id: 'consumer', type: 'function', label: 'consume', metadata: { path: 'src/consumer.ts' } });
    graph.addNode({ id: 'target', type: 'function', label: 'target', metadata: { path: 'src/old.ts' } });
    graph.addEdge({
      id: 'import-1',
      source: 'consumer-file',
      target: 'old-file',
      relation: 'depends_on',
      metadata: { line: 1 },
    });
    graph.addEdge({
      id: 'reference-1',
      source: 'consumer',
      target: 'target',
      relation: 'references',
      metadata: { line: 8 },
    });
    return graph;
  }

  it('applies a changed newPath virtually and reports import/reference breakage', () => {
    const graph = graphWithMovedSymbol();
    const diff = new MutationSimulator().simulate(graph, {
      type: 'move_symbol',
      targetSymbolId: 'target',
      newPath: 'src/new.ts',
    });

    expect(diff.action.newPath).toBe('src/new.ts');
    expect(diff.affectedSymbolsCount).toBe(2);
    expect(diff.brokenReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ callerId: 'consumer-file', relation: 'depends_on' }),
      expect.objectContaining({ callerId: 'consumer', relation: 'references', callerLine: 8 }),
    ]));
    expect(diff.isSafe).toBe(false);
    // Simulation is virtual: the input graph remains at its original path.
    expect(graph.getNode('target')?.metadata?.path).toBe('src/old.ts');
  });

  it('treats a move to the existing path as safe', () => {
    const diff = new MutationSimulator().simulate(graphWithMovedSymbol(), {
      type: 'move_symbol',
      targetSymbolId: 'target',
      newPath: 'src/old.ts',
    });

    expect(diff.brokenReferences).toHaveLength(0);
    expect(diff.isSafe).toBe(true);
  });

  it('rejects move_symbol without a non-empty newPath', () => {
    expect(() => new MutationSimulator().simulate(graphWithMovedSymbol(), {
      type: 'move_symbol',
      targetSymbolId: 'target',
    })).toThrow('newPath is required for move_symbol');
    expect(() => new MutationSimulator().simulate(graphWithMovedSymbol(), {
      type: 'move_symbol',
      targetSymbolId: 'target',
      newPath: '  ',
    })).toThrow('newPath is required for move_symbol');
  });

  it('validates newPath before resolving a tool target', async () => {
    const output = await new SimulateMutationTool({} as ProjectIndexReader).execute({
      actionType: 'move_symbol',
      targetSymbolId: 'target',
    });

    expect(output.success).toBe(false);
    expect(output.error).toMatch(/newPath/);
  });
});
