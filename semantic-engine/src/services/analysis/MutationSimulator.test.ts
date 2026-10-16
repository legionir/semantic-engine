import { MutationSimulator } from './MutationSimulator';
import { AnalysisGraph } from './AnalysisGraph';

describe('MutationSimulator (V2 Virtual Refactoring Simulation)', () => {
  it('simulates symbol deletion and reports broken references', () => {
    const graph = new AnalysisGraph();

    graph.addNode({ id: 'OrderService', type: 'class', label: 'OrderService', metadata: { path: 'src/order.ts' } });
    graph.addNode({ id: 'PaymentMethod', type: 'function', label: 'PaymentMethod', metadata: { path: 'src/pay.ts' } });

    graph.addEdge({ id: 'e1', source: 'OrderService', target: 'PaymentMethod', relation: 'calls' });

    const simulator = new MutationSimulator();
    const diff = simulator.simulate(graph, {
      type: 'delete_symbol',
      targetSymbolId: 'PaymentMethod',
    });

    expect(diff.isSafe).toBe(false);
    expect(diff.brokenReferences.length).toBe(1);
    expect(diff.brokenReferences[0]?.callerId).toBe('OrderService');
  });

  it('reports safe mutation when symbol has no callers', () => {
    const graph = new AnalysisGraph();
    graph.addNode({ id: 'IsolatedUtil', type: 'function', label: 'IsolatedUtil' });

    const simulator = new MutationSimulator();
    const diff = simulator.simulate(graph, {
      type: 'delete_symbol',
      targetSymbolId: 'IsolatedUtil',
    });

    expect(diff.isSafe).toBe(true);
    expect(diff.brokenReferences.length).toBe(0);
  });
});
