/**
 * P-008 regression (§15/§16) — the HTTP impact path must honour the requested
 * depth and must not hide the tool's truncation signal.
 *
 * Two real defects on this path:
 *  1. The service passed `{ id, maxDepth }` to ImpactAnalysisTool, which reads
 *     `depth` — so a caller asking for depth 3 silently got depth 2 (default).
 *     A smaller impact radius than requested, presented as the answer.
 *  2. The response dropped the tool metadata, so `impactedCount` was the page
 *     size: a capped page of 30 out of 500 candidates read exactly like a
 *     complete answer of 30.
 */

import { ProjectIndexReader } from '../ai/ProjectIndexReader';
import { CodeIntelligenceService } from './CodeIntelligenceService';
import type { ManagedProject } from './ProjectService';
import type { ProjectIndex, FileEntry, CallEdge } from '../core/types/project-index.types';

function file(id: string, path: string): FileEntry {
  return {
    id, path, language: 'typescript', encoding: 'utf8', size: 10, lines: 3,
    hash: `h-${id}`, modified: '2026-01-01T00:00:00.000Z', binary: false,
    testFile: false, generated: false, imports: [],
  } as FileEntry;
}

function call(caller: string, callee: string): CallEdge {
  return {
    id: `ce-${caller}-${callee}`, caller, callee, kind: 'direct', line: 2,
    callerKind: 'symbol',
    provenance: { basis: 'ast', confidence: 95, extractor: 'typescript-api' },
  } as CallEdge;
}

function project(): ManagedProject {
  /*
  | Chain: s0 ← s1 ← s2 ← s3 … (backward = dependents by depth).
  | depth 1 sees s1; depth 3 must see s1..s3 — the maxDepth-vs-depth bug
  | made depth-3 requests stop at depth 2.
  */
  const files = [file('f0', 'src/a.ts'), file('f1', 'src/b.ts'), file('f2', 'src/c.ts'), file('f3', 'src/d.ts')];
  const symbols = files.map((f, i) => ({
    id: `s${i}`, fileId: f.id, parentId: null, kind: 'function', name: `n${i}`,
    fullyQualifiedName: `n${i}`, line: 2, endLine: 3, signature: `function n${i}()`,
    source: 'tree-sitter', confidence: { score: 100, basis: 'ast' as any, extractor: 'ts' },
    exported: true,
  }));
  const callGraph = [call('s1', 's0'), call('s2', 's1'), call('s3', 's2')];
  const index = {
    schemaVersion: '2.0.0', root: 'fixture', rootPath: '/tmp/p008',
    generatedAt: '2026-01-01T00:00:00.000Z', languages: ['typescript'],
    files, symbols,
    graphs: { callGraph, typeGraph: [], dependencyGraph: [] },
    diagnostics: [],
    metrics: { totalFiles: 4, totalLoc: 12, totalSymbols: 4, avgCyclomaticComplexity: 1, languageBreakdown: { typescript: 4 } },
  } as unknown as ProjectIndex;

  return {
    id: 'p', name: 'p', rootPath: '/tmp/p008', aliases: [], indexPath: '/tmp/p008.json',
    status: 'ready', reader: new ProjectIndexReader(index),
    stats: { filesCount: 4, symbolsCount: 4, dependenciesCount: 0 },
  } as ManagedProject;
}

describe('CodeIntelligenceService.analyzeImpact (P-008 regression)', () => {
  const service = new CodeIntelligenceService();

  it('honours the requested depth (maxDepth → tool depth mapping)', async () => {
    const shallow = await service.analyzeImpact(project(), 's0', 1);
    const deep = await service.analyzeImpact(project(), 's0', 3);
    expect(shallow.impactedCount).toBe(1); // only s1
    expect(deep.impactedCount).toBe(3);    // s1, s2, s3 — the pre-fix bug returned 2 here
  });

  it('defaults to depth 3 when the caller omits maxDepth', async () => {
    const result = await service.analyzeImpact(project(), 's0');
    expect(result.impactedCount).toBe(3);
  });

  it('carries the truncation signal instead of dropping tool metadata', async () => {
    const capped = await service.analyzeImpact(project(), 's0', 3);
    // Small fixture: nothing was cut, and the response says so explicitly.
    expect(capped.truncated).toBe(false);
    expect(capped.candidateCount).toBe(capped.impactedCount);
  });
});
