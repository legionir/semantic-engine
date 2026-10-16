/**
 * F-0013 — `CodeIntelligenceService.getDependencies(direction:'both')` must be
 * the union of forward + backward, not silently forward-only.
 *
 * Fixture: fA --imports--> fTarget --imports--> fB. So for fTarget:
 *   forward  = { fB }   (what it depends on)
 *   backward = { fA }   (what depends on it)
 *   both     = { fA, fB }
 * Before the fix, `both` mapped to forward and returned only { fB }.
 */

import { ProjectIndexReader } from '../ai/ProjectIndexReader';
import { CodeIntelligenceService } from './CodeIntelligenceService';
import type { ManagedProject } from './ProjectService';
import type { ProjectIndex } from '../core/types/project-index.types';

function file(id: string, path: string) {
  return {
    id, path, language: 'typescript', size: 10, lines: 4, hash: 'h', binary: false,
    testFile: false, generated: false, symbolIds: [], imports: [], exports: [],
    diagnostics: [], outline: [],
  };
}

function index(): ProjectIndex {
  return {
    schemaVersion: '2.0.0',
    generatedAt: new Date().toISOString(),
    root: 'probe',
    rootPath: '/probe',
    languages: {},
    files: [
      file('fA', 'src/a.ts'),
      file('fTarget', 'src/target.ts'),
      file('fB', 'src/b.ts'),
    ],
    symbols: [],
    graphs: {
      // forward: target depends on b. reverseDependencyGraph is keyed by the
      // depended-on file, so "a depends on target" is stored as from:target→a.
      dependencyGraph: [
        { from: 'fTarget', to: 'fB', kind: 'import', provenance: { confidence: 90, basis: 'import-resolved', extractor: 'typescript' } },
      ],
      typeGraph: [],
      callGraph: [],
      reverseDependencyGraph: [
        { from: 'fTarget', to: 'fA', kind: 'import', provenance: { confidence: 90, basis: 'import-resolved', extractor: 'typescript' } },
      ],
    },
    diagnostics: [],
    metrics: {} as never,
  } as unknown as ProjectIndex;
}

const project = { id: 'probe', reader: new ProjectIndexReader(index()) } as unknown as ManagedProject;

describe('F-0013 — getDependencies direction:both is the union', () => {
  it('both returns forward ∪ backward (fA + fB), not forward-only', async () => {
    const service = new CodeIntelligenceService();
    const both = await service.getDependencies(project, 'src/target.ts', 1, 'both');
    const paths = (both.edges as Array<{ path?: string }>).map(e => e.path).sort();

    expect(both.total).toBe(2);
    expect(paths).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('out still returns only forward', async () => {
    const service = new CodeIntelligenceService();
    const out = await service.getDependencies(project, 'src/target.ts', 1, 'out');
    expect((out.edges as Array<{ path?: string }>).map(e => e.path)).toEqual(['src/b.ts']);
  });

  it('in still returns only backward', async () => {
    const service = new CodeIntelligenceService();
    const inRes = await service.getDependencies(project, 'src/target.ts', 1, 'in');
    expect((inRes.edges as Array<{ path?: string }>).map(e => e.path)).toEqual(['src/a.ts']);
  });

  it('both de-duplicates an item reachable in both directions', async () => {
    const service = new CodeIntelligenceService();
    // fTarget: both-direction traversal must not double-count the seed.
    const both = await service.getDependencies(project, 'src/target.ts', 1, 'both');
    const ids = (both.edges as Array<{ id?: string }>).map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
