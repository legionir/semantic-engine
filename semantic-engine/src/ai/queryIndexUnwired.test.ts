/**
 * F-0022 — the `query_index` / `queryPolicy` module is intentionally NOT wired
 * into the AI tool registry (raw-SQL-over-the-index was removed from the tool
 * surface). This is a deliberate non-feature, so it must be *locked*, not left
 * to silently rot back in.
 *
 * Two guards:
 *   1. The registry never exposes a tool named `query_index`.
 *   2. The orphaned source files stay orphaned — nothing imports and registers
 *      them. If someone wires them back, the first assertion fails and forces a
 *      conscious decision.
 */

import * as fs from 'fs';
import * as path from 'path';
import { AiToolRegistry } from './AiToolRegistry';
import { ProjectIndexReader } from './ProjectIndexReader';
import type { ProjectIndex } from '../core/types/project-index.types';

function minimalIndex(): ProjectIndex {
  return {
    schemaVersion: '2.0.0',
    generatedAt: new Date().toISOString(),
    root: 'probe',
    rootPath: '/probe',
    languages: {},
    files: [],
    symbols: [],
    graphs: { dependencyGraph: [], typeGraph: [], callGraph: [], reverseDependencyGraph: [] },
    diagnostics: [],
    metrics: {} as never,
  } as unknown as ProjectIndex;
}

describe('F-0022 — query_index stays unwired', () => {
  it('the registry does not expose a query_index tool', () => {
    const registry = new AiToolRegistry({ reader: new ProjectIndexReader(minimalIndex()) });
    const names = registry.list().map(t => t.name);
    expect(names).not.toContain('query_index');
    expect(registry.get('query_index')).toBeUndefined();
  });

  it('AiToolRegistry source never imports or registers QueryIndexTool', () => {
    const src = fs.readFileSync(path.join(__dirname, 'AiToolRegistry.ts'), 'utf8');
    expect(src).not.toMatch(/import\s+\{[^}]*\bQueryIndexTool\b[^}]*\}\s+from/);
    expect(src).not.toMatch(/new\s+QueryIndexTool\(/);
    expect(src).not.toMatch(/register\(\s*new\s+QueryIndexTool/);
  });
});
