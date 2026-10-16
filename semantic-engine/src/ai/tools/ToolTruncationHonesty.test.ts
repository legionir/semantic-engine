/**
 * SE-AI-HONESTY regression suite (§16 / §25).
 *
 * Every tool here slices its result set to `limit`. Before this fix none of
 * them declared that a slice happened, so an AI consumer could read a capped
 * list as the *complete* answer — exactly the "no result exists" vs "no result
 * was found" confusion the semantic layer must never allow. These tests pin
 * the contract: when more matches exist than `limit`, the output carries a
 * machine-readable `truncated: true` (and the honest total count); when the
 * slice dropped nothing, `truncated` is false.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ProjectIndexReader } from '../ProjectIndexReader';
import {
  ProjectIndex,
  SymbolEntry,
  FileEntry,
  DependencyEdge,
  ImportEntry,
  ConfigUsageEntry,
} from '../../core/types/project-index.types';
import { makeConfidence } from '../../core/types/common.types';
import { FindSymbolTool } from './FindSymbolTool';
import { FindTestsTool } from './FindTestsTool';
import { GetConfigUsageTool } from './GetConfigUsageTool';
import { GetFileSummaryTool } from './GetFileSummaryTool';
import { GetDependenciesTool } from './GetDependenciesTool';
import { GetGitHotspotsTool } from './GetGitHotspotsTool';

const PROV = { extractor: 'typescript-api', confidence: 100 } as const;

function fileEntry(id: string, p: string, extra: Partial<FileEntry> = {}): FileEntry {
  return {
    id, path: p, language: 'typescript', encoding: 'utf8', size: 50, lines: 4,
    hash: `hash-${id}`, modified: '2026-01-01T00:00:00.000Z', binary: false,
    testFile: false, generated: false, ...extra,
  };
}

function symbolEntry(id: string, fileId: string, name: string, exported = true): SymbolEntry {
  return {
    id, fileId, parentId: null, kind: 'function', name, fullyQualifiedName: name,
    line: 2, endLine: 4, signature: `function ${name}()`, source: 'tree-sitter',
    confidence: makeConfidence(100), exported,
  };
}

function depEdge(from: string, to: string): DependencyEdge {
  return { from, to, kind: 'import', provenance: { ...PROV, basis: 'import-resolved' } };
}

function importEntry(resolvedFileId: string): ImportEntry {
  return { from: './a', type: 'local', resolvedFileId, specifiers: [] };
}

function configUsage(key: string, kind: ConfigUsageEntry['kind'], line: number): ConfigUsageEntry {
  return { key, kind, line, context: 'cfg' };
}

const METRIC = { totalFiles: 0, totalLoc: 0, totalSymbols: 0, avgCyclomaticComplexity: 1, languageBreakdown: { typescript: 1 } };

function buildIndex(root: string, files: FileEntry[], symbols: SymbolEntry[], dependencyGraph: DependencyEdge[] = []): ProjectIndex {
  return {
    schemaVersion: '2.0.0', root: 'fixture', rootPath: root,
    generatedAt: '2026-01-01T00:00:00.000Z', languages: ['typescript'],
    files, symbols,
    graphs: { callGraph: [], typeGraph: [], dependencyGraph },
    diagnostics: [],
    metrics: { ...METRIC, totalFiles: files.length, totalSymbols: symbols.length },
  } as ProjectIndex;
}

describe('SE-AI-HONESTY: capped tool results must not look complete', () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'se-honesty-')); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  test('find_symbol reports truncated + matchCount when limit drops matches', async () => {
    const symbols = Array.from({ length: 5 }, (_, i) => symbolEntry(`s${i}`, 'f1', `Engine${i}`));
    const reader = new ProjectIndexReader(buildIndex(root, [fileEntry('f1', 'src/a.ts')], symbols));
    const tool = new FindSymbolTool(reader);

    const capped = await tool.execute({ name: 'Engine', limit: 2 });
    expect(capped.items).toHaveLength(2);
    expect(capped.metadata).toEqual(expect.objectContaining({ truncated: true, matchCount: 5, limit: 2 }));

    const whole = await tool.execute({ name: 'Engine', limit: 10 });
    expect(whole.items).toHaveLength(5);
    expect((whole.metadata as { truncated: boolean }).truncated).toBe(false);
  });

  test('find_symbol with zero matches is honest about the empty scope', async () => {
    const reader = new ProjectIndexReader(buildIndex(root, [fileEntry('f1', 'src/a.ts')], []));
    const res = await new FindSymbolTool(reader).execute({ name: 'Nope' });
    expect(res.success).toBe(true);
    expect(res.items).toHaveLength(0);
    expect((res.metadata as { truncated: boolean }).truncated).toBe(false);
    expect((res.metadata as { matchCount: number }).matchCount).toBe(0);
  });

  test('find_tests flags truncation when more than limit candidates match', async () => {
    const sourceFile = fileEntry('f-src', 'src/a.ts');
    const testFiles = Array.from({ length: 4 }, (_, i) =>
      fileEntry(`t${i}`, `src/a${i}.test.ts`, { testFile: true, imports: [importEntry('f-src')] }),
    );
    const reader = new ProjectIndexReader(buildIndex(root, [sourceFile, ...testFiles], []));
    const capped = await new FindTestsTool(reader).execute({ path: 'src/a.ts', limit: 2 });
    expect(capped.items).toHaveLength(2);
    expect(capped.metadata).toEqual(expect.objectContaining({ truncated: true, matchCount: 4, limit: 2 }));

    const whole = await new FindTestsTool(reader).execute({ path: 'src/a.ts', limit: 10 });
    expect((whole.metadata as { truncated: boolean }).truncated).toBe(false);
  });

  test('get_config_usage flags truncation when limit slices usages', async () => {
    const files = Array.from({ length: 3 }, (_, i) =>
      fileEntry(`f${i}`, `src/c${i}.ts`, {
        configUsages: [configUsage('featureFlag', 'env', 1), configUsage('featureFlag', 'dotenv', 2)],
      }),
    );
    const reader = new ProjectIndexReader(buildIndex(root, files, []));
    const capped = await new GetConfigUsageTool(reader).execute({ key: 'feature', limit: 3 });
    expect(capped.items).toHaveLength(3);
    expect(capped.metadata).toEqual(expect.objectContaining({ truncated: true, matchCount: 6, limit: 3 }));
  });

  test('get_file_summary flags truncation when public API exceeds 20 symbols', async () => {
    const symbols = Array.from({ length: 25 }, (_, i) => symbolEntry(`s${i}`, 'f1', `pub${i}`));
    const reader = new ProjectIndexReader(buildIndex(root, [fileEntry('f1', 'src/big.ts')], symbols));
    const res = await new GetFileSummaryTool(reader).execute({ path: 'src/big.ts' });
    expect(res.items).toHaveLength(20);
    expect(res.metadata).toEqual(expect.objectContaining({ truncated: true, publicSymbolCount: 25 }));
  });

  test('get_dependencies reports truncated when the walk fills a full page', async () => {
    const files = Array.from({ length: 6 }, (_, i) => fileEntry(`f${i}`, `src/d${i}.ts`));
    const edges = Array.from({ length: 5 }, (_, i) => depEdge('f0', `f${i + 1}`));
    const reader = new ProjectIndexReader(buildIndex(root, files, [], edges));
    const capped = await new GetDependenciesTool(reader).execute({ id: 'f0', direction: 'forward', depth: 2, limit: 3 });
    expect(capped.items).toHaveLength(3);
    expect((capped.metadata as { truncated: boolean }).truncated).toBe(true);

    const whole = await new GetDependenciesTool(reader).execute({ id: 'f0', direction: 'forward', depth: 2, limit: 20 });
    expect(whole.items).toHaveLength(5);
    expect((whole.metadata as { truncated: boolean }).truncated).toBe(false);
  });

  test('get_git_hotspots (in-memory) flags truncation when candidates exceed limit', async () => {
    const files = Array.from({ length: 8 }, (_, i) => fileEntry(`f${i}`, `src/g${i}.ts`));
    const reader = new ProjectIndexReader(buildIndex(root, files, []));
    const tool = new GetGitHotspotsTool(reader); // no workspaceRoot -> in-memory deterministic mode
    const capped = await tool.execute({ limit: 3 });
    expect(capped.items.length).toBeGreaterThan(0);
    expect(capped.metadata).toEqual(expect.objectContaining({ source: 'in-memory' }));
    expect((capped.metadata as { truncated: boolean }).truncated).toBe(true);
    const whole = await tool.execute({ limit: 50 });
    expect((whole.metadata as { truncated: boolean }).truncated).toBe(false);
  });
});
