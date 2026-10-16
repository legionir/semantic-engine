/**
 * SE-F-009 — the type barrel is the declared public surface; Blueprint and
 * its shapes must be reachable through it, not only via the deep path.
 */

import { makeConfidence } from './common.types';
import type {
  Blueprint,
  BlueprintMeta,
  ArchitectureOverview,
  ModuleEntry,
  DependencyEdge,
  Confidence,
  ProjectIndex,
} from './index';

describe('SE-F-009 — core/types barrel surface', () => {
  it('accepts a Blueprint-typed literal built from the barrel types', () => {
    const meta = {
      projectId: 'p',
      name: 'n',
      generatedAt: '2026-01-01T00:00:00Z',
      schemaVersion: '2.0.0',
    } as unknown as BlueprintMeta;

    const blueprint: Blueprint = {
      schemaVersion: '2.0.0',
      meta,
    } as unknown as Blueprint;

    // structural presence, not behavior: the point is that the barrel TYPES exist
    expect(blueprint.schemaVersion).toBe('2.0.0');
  });

  it('exposes the other barrel members together with blueprint types', () => {
    const kind: Confidence = makeConfidence(90);
    const idx: ProjectIndex = {} as ProjectIndex;
    expect(kind).toBe(90);
    const check: Array<ArchitectureOverview | ModuleEntry | DependencyEdge | null> = [null, null, null];
    expect(check).toHaveLength(3);
    expect(idx).toBeDefined();
  });
});
