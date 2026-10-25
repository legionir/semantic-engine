import { ArchitectureRuleEngine } from './ArchitectureRuleEngine';
import { AnalysisGraph } from './AnalysisGraph';

describe('ArchitectureRuleEngine (V2 Cycles & Layer Violations)', () => {
  it('detects circular dependencies using Tarjan SCC algorithm', () => {
    const graph = new AnalysisGraph();

    // Setup cycle: A -> B -> C -> A
    graph.addNode({ id: 'modA', type: 'module', label: 'modA' });
    graph.addNode({ id: 'modB', type: 'module', label: 'modB' });
    graph.addNode({ id: 'modC', type: 'module', label: 'modC' });

    graph.addEdge({ id: 'e1', source: 'modA', target: 'modB', relation: 'imports' });
    graph.addEdge({ id: 'e2', source: 'modB', target: 'modC', relation: 'imports' });
    graph.addEdge({ id: 'e3', source: 'modC', target: 'modA', relation: 'imports' });

    const engine = new ArchitectureRuleEngine();
    const cycles = engine.findCircularDependencies(graph);

    expect(cycles.length).toBe(1);
    expect(cycles[0]?.cycleLength).toBe(3);
  });

  it('finds two disjoint cycles (correctness across components)', () => {
    const graph = new AnalysisGraph();
    // Cycle 1: A -> B -> A ; Cycle 2: C -> D -> E -> C
    graph.addNode({ id: 'A', type: 'module', label: 'A' });
    graph.addNode({ id: 'B', type: 'module', label: 'B' });
    graph.addNode({ id: 'C', type: 'module', label: 'C' });
    graph.addNode({ id: 'D', type: 'module', label: 'D' });
    graph.addNode({ id: 'E', type: 'module', label: 'E' });
    graph.addEdge({ id: 'a1', source: 'A', target: 'B', relation: 'imports' });
    graph.addEdge({ id: 'a2', source: 'B', target: 'A', relation: 'imports' });
    graph.addEdge({ id: 'b1', source: 'C', target: 'D', relation: 'imports' });
    graph.addEdge({ id: 'b2', source: 'D', target: 'E', relation: 'imports' });
    graph.addEdge({ id: 'b3', source: 'E', target: 'C', relation: 'imports' });

    const cycles = new ArchitectureRuleEngine().findCircularDependencies(graph);
    const lengths = cycles.map(c => c.cycleLength).sort();
    expect(cycles.length).toBe(2);
    expect(lengths).toEqual([2, 3]);
  });

  /*
  | F-0018 — the recursive Tarjan overflowed Node's call stack on a long chain
  | (each edge = one JS stack frame). A 20k-node acyclic chain must scan with
  | no RangeError; the iterative version keeps depth on the heap.
  */
  it('does not stack-overflow on a deep 20k-node chain (iterative Tarjan)', () => {
    const graph = new AnalysisGraph();
    const N = 20_000;
    for (let i = 0; i < N; i++) {
      graph.addNode({ id: `n${i}`, type: 'module', label: `n${i}` });
    }
    // Pure forward chain n0 -> n1 -> ... -> n(N-1); acyclic, so zero SCCs but
    // the deepest possible DFS recursion.
    for (let i = 0; i + 1 < N; i++) {
      graph.addEdge({ id: `e${i}`, source: `n${i}`, target: `n${i + 1}`, relation: 'imports' });
    }

    expect(() => {
      const cycles = new ArchitectureRuleEngine().findCircularDependencies(graph);
      expect(cycles.length).toBe(0);
    }).not.toThrow();
  });

  it('detects a cycle at the far end of a deep chain without overflowing', () => {
    const graph = new AnalysisGraph();
    const N = 15_000;
    for (let i = 0; i < N; i++) {
      graph.addNode({ id: `m${i}`, type: 'module', label: `m${i}` });
    }
    for (let i = 0; i + 1 < N; i++) {
      graph.addEdge({ id: `f${i}`, source: `m${i}`, target: `m${i + 1}`, relation: 'imports' });
    }
    // Close the loop at the end: m(N-1) -> m(N-2) is already there as forward;
    // instead point the tail back to a late node to form a 2-node SCC.
    graph.addEdge({ id: 'back', source: `m${N - 2}`, target: `m${N - 1}`, relation: 'imports' });
    graph.addEdge({ id: 'back2', source: `m${N - 1}`, target: `m${N - 2}`, relation: 'imports' });

    const cycles = new ArchitectureRuleEngine().findCircularDependencies(graph);
    expect(cycles.length).toBe(1);
    expect(cycles[0]?.cycleLength).toBe(2);
  }, 30_000);

  it('detects architectural layer bypassing violations', () => {
    const graph = new AnalysisGraph();

    // Violation: Controller directly invokes Repository
    graph.addNode({ id: 'PaymentController', type: 'class', label: 'PaymentController' });
    graph.addNode({ id: 'PaymentRepository', type: 'class', label: 'PaymentRepository' });

    graph.addEdge({ id: 'e1', source: 'PaymentController', target: 'PaymentRepository', relation: 'calls' });

    const engine = new ArchitectureRuleEngine();
    const violations = engine.detectLayerViolations(graph);

    expect(violations.length).toBe(1);
    expect(violations[0]?.ruleId).toBe('ARCH-001');
    expect(violations[0]?.severity).toBe('error');
  });

  // F-0017 regression: in the real index node ids are opaque hex; the readable
  // path lives in metadata.path. Layer rules must match on the path, not the id.
  it('detects layer violations when node ids are opaque hex (real buildIndexGraph shape)', () => {
    const graph = new AnalysisGraph();

    graph.addNode({ id: 'a1b2c3d4e5f60718', type: 'file', label: 'src/web/payment.controller.ts', metadata: { path: 'src/web/payment.controller.ts' } });
    graph.addNode({ id: '1122334455667788', type: 'file', label: 'src/data/payment.repository.ts', metadata: { path: 'src/data/payment.repository.ts' } });

    graph.addEdge({ id: 'e1', source: 'a1b2c3d4e5f60718', target: '1122334455667788', relation: 'imports' });

    const engine = new ArchitectureRuleEngine();
    const violations = engine.detectLayerViolations(graph);

    expect(violations.length).toBe(1);
    expect(violations[0]?.ruleId).toBe('ARCH-001');
  });
});
