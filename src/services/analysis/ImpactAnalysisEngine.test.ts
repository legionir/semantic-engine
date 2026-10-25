import { ImpactAnalysisEngine } from './ImpactAnalysisEngine';
import { AnalysisGraph } from './AnalysisGraph';

describe('ImpactAnalysisEngine (V2 Blast Radius & Risk Estimation)', () => {
  it('computes 3-tier impact and risk score for a modified symbol', () => {
    const graph = new AnalysisGraph();

    // Setup dependency chain: Controller -> Service -> Repo
    graph.addNode({ id: 'AuthController', type: 'class', label: 'AuthController', metadata: { path: 'src/auth.controller.ts' } });
    graph.addNode({ id: 'AuthService', type: 'class', label: 'AuthService', metadata: { path: 'src/auth.service.ts' } });
    graph.addNode({ id: 'UserRepo', type: 'class', label: 'UserRepo', metadata: { path: 'src/user.repo.ts' } });
    graph.addNode({ id: 'AuthTest', type: 'test', label: 'AuthTest', metadata: { path: 'src/auth.test.ts' } });

    graph.addEdge({ id: 'e1', source: 'AuthController', target: 'AuthService', relation: 'calls', metadata: { confidence: 100 } });
    graph.addEdge({ id: 'e2', source: 'AuthService', target: 'UserRepo', relation: 'calls', metadata: { confidence: 100 } });
    graph.addEdge({ id: 'e3', source: 'AuthTest', target: 'AuthService', relation: 'references', metadata: { confidence: 100 } });

    const engine = new ImpactAnalysisEngine();
    const result = engine.analyzeImpact(graph, 'UserRepo', 3);

    expect(result.rootSymbolId).toBe('UserRepo');
    expect(result.blastRadius.directDependentsCount).toBe(1); // AuthService
    expect(result.blastRadius.transitiveDependentsCount).toBe(2); // AuthController, AuthTest
    expect(result.blastRadius.affectedApisCount).toBe(1); // AuthController
    expect(result.blastRadius.affectedTestsCount).toBe(1); // AuthTest
    expect(result.riskScore).toBeGreaterThan(0);
  });

  /*
  | F-0016 — severity must be monotonic (non-increasing) as depth grows, for
  | a fixed node type. Regression: the old if/else-if chain downgraded an api
  | node at depth 2 to `medium` while an api node at depth 3 stayed `high`, so
  | a nearer impact scored *lower* than a farther one.
  */
  it('severity is monotonic by depth for api nodes (no d2 < d3)', () => {
    const graph = new AnalysisGraph();
    const order = ['low', 'medium', 'high', 'critical'];

    // root <- api@1 <- api@2 <- api@3 (a single backward chain)
    graph.addNode({ id: 'root', type: 'symbol', label: 'root', metadata: { path: 'src/root.ts' } });
    graph.addNode({ id: 'api1', type: 'api', label: 'api1', metadata: { path: 'src/a1.ts' } });
    graph.addNode({ id: 'api2', type: 'api', label: 'api2', metadata: { path: 'src/a2.ts' } });
    graph.addNode({ id: 'api3', type: 'api', label: 'api3', metadata: { path: 'src/a3.ts' } });
    graph.addEdge({ id: 'c1', source: 'api1', target: 'root', relation: 'calls', metadata: { confidence: 100 } });
    graph.addEdge({ id: 'c2', source: 'api2', target: 'api1', relation: 'calls', metadata: { confidence: 100 } });
    graph.addEdge({ id: 'c3', source: 'api3', target: 'api2', relation: 'calls', metadata: { confidence: 100 } });

    const result = new ImpactAnalysisEngine().analyzeImpact(graph, 'root', 3);
    const rank = (id: string): number => {
      const e = result.affectedEntities.find(x => x.id === id);
      expect(e).toBeDefined();
      return order.indexOf(e!.severity);
    };

    // Nearer impact must never be scored lower than a farther one.
    expect(rank('api1')).toBeGreaterThanOrEqual(rank('api2'));
    expect(rank('api2')).toBeGreaterThanOrEqual(rank('api3'));
  });

  it('api at depth 1 is critical and api at depth 2 is at least high (was medium)', () => {
    const graph = new AnalysisGraph();
    graph.addNode({ id: 'root', type: 'symbol', label: 'root', metadata: { path: 'src/root.ts' } });
    graph.addNode({ id: 'api1', type: 'api', label: 'api1', metadata: { path: 'src/a1.ts' } });
    graph.addNode({ id: 'api2', type: 'api', label: 'api2', metadata: { path: 'src/a2.ts' } });
    graph.addEdge({ id: 'c1', source: 'api1', target: 'root', relation: 'calls', metadata: { confidence: 100 } });
    graph.addEdge({ id: 'c2', source: 'api2', target: 'api1', relation: 'calls', metadata: { confidence: 100 } });

    const result = new ImpactAnalysisEngine().analyzeImpact(graph, 'root', 3);
    expect(result.affectedEntities.find(e => e.id === 'api1')?.severity).toBe('critical');
    expect(result.affectedEntities.find(e => e.id === 'api2')?.severity).toBe('high');
  });
});
