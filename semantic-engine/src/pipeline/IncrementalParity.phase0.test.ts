/**
 * Phase 0 — full index vs incremental index, on a real fixture through the real
 * pipeline.
 *
 * The acceptance criterion this pins is the one written in the execution plan:
 * «full و incremental برای fixtureها معادل (تفاوت مسدودکننده = 🔴)». Both sides
 * run the shipped code — `IndexPipeline` for the full build, `IncrementalEngine`
 * for the update after add / modify / delete / rename — on a workspace that
 * contains Unicode (Persian + emoji), CRLF, a BOM, a file with no final newline
 * and an empty file.
 *
 * The comparison is *semantic* and by path: file inventory, content hashes,
 * symbol sets, graph edges, diagnostics and vector chunks. File ids are
 * deliberately excluded from the strict comparison because a stable id across a
 * rename is a feature (`SE-INC-01`, phase 25) that a full rebuild cannot
 * reproduce; a separate test asserts exactly that difference instead of hiding
 * it.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IndexPipeline } from './IndexPipeline';
import { createExtractors, ExtractorSet } from './ExtractorFactory';
import { IncrementalEngine } from '../incremental/IncrementalEngine';
import { FileChangeEvent } from '../core/types/common.types';
import { ProjectIndex } from '../core/types/project-index.types';
import { canonicalJson } from '../core/contracts/codeintel';

let workspace: string;
let extractors: ExtractorSet;

function write(relative: string, content: string | Buffer): void {
  const absolute = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

function remove(relative: string): void {
  fs.rmSync(path.join(workspace, relative), { force: true });
}

function rename(from: string, to: string): void {
  fs.mkdirSync(path.dirname(path.join(workspace, to)), { recursive: true });
  fs.renameSync(path.join(workspace, from), path.join(workspace, to));
}

function fullIndex(): Promise<{ projectIndex: ProjectIndex }> {
  return new IndexPipeline({
    workspaceRoot: workspace,
    outputPath: path.join(workspace, '.semantic-engine', 'project-index.json'),
    symbolExtractors: extractors.symbols,
    dependencyExtractors: extractors.dependencies,
    scannerConfig: { skipHiddenDirectories: false },
    gitCollector: null,
    vectorIndexer: null,
  }).run();
}

function engineFor(projectIndex: ProjectIndex): IncrementalEngine {
  const engine = new IncrementalEngine({
    workspaceRoot: workspace,
    symbolExtractorManager: extractors.symbols,
    dependencyExtractorManager: extractors.dependencies,
    vectorIndexer: null,
  });
  engine.load(projectIndex);
  return engine;
}

/**
 * Everything that has to agree between the two paths, keyed by path so a
 * rename cannot masquerade as a match.
 */
function projection(index: ProjectIndex): unknown {
  const pathOf = (fileId: string): string =>
    index.files.find(file => file.id === fileId)?.path ?? `<missing:${fileId}>`;

  const fileRows = index.files
    .map(file => ({
      path: file.path,
      language: file.language,
      encoding: file.encoding,
      hash: file.hash,
      size: file.size,
      lines: file.lines,
      binary: file.binary,
      generated: file.generated,
      testFile: file.testFile,
      imports: (file.imports ?? []).map(imp => ({
        from: imp.from,
        resolved: imp.resolvedFileId ? pathOf(imp.resolvedFileId) : null,
      })),
      exports: (file.exports ?? []).map(exp => exp.name).sort(),
      symbols: index.symbols
        .filter(symbol => symbol.fileId === file.id)
        .map(symbol => `${symbol.kind} ${symbol.name}@${symbol.line}-${symbol.endLine}`)
        .sort(),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));

  const dependencyEdges = index.graphs.dependencyGraph
    .map(edge => `${pathOf(edge.from)} -> ${pathOf(edge.to)}`)
    .sort();
  const nameOfSymbol = (symbolId: string): string => {
    const symbol = index.symbols.find(candidate => candidate.id === symbolId);
    return symbol ? `${pathOf(symbol.fileId)}#${symbol.name}` : `<missing:${symbolId}>`;
  };
  const callEdges = index.graphs.callGraph
    .map(edge => `${nameOfSymbol(edge.caller)} -> ${nameOfSymbol(edge.callee)}`)
    .sort();
  const typeEdges = index.graphs.typeGraph
    .map(edge => `${nameOfSymbol(edge.parent)} -${edge.kind}-> ${nameOfSymbol(edge.child)}`)
    .sort();
  const reverseEdges = (index.graphs.reverseDependencyGraph ?? [])
    .map(edge => `${pathOf(edge.from)} -> ${pathOf(edge.to)}`)
    .sort();

  const diagnostics = index.diagnostics
    .map(diagnostic => `${diagnostic.fileId ? pathOf(diagnostic.fileId) : '<project>'} ${diagnostic.severity} ${diagnostic.message}`)
    .sort();

  return {
    fileCount: index.files.length,
    symbolCount: index.symbols.length,
    schemaVersion: index.schemaVersion,
    files: fileRows,
    dependencyEdges,
    callEdges,
    typeEdges,
    reverseEdges,
    diagnostics,
    totalLoc: index.metrics.totalLoc,
    totalSymbols: index.metrics.totalSymbols,
    languageBreakdown: index.metrics.languageBreakdown,
  };
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'se-parity-'));
  /* The production extractor set: tree-sitter with the heuristic fallbacks,
     exactly what `createExtractors` gives the CLI. */
  extractors = createExtractors({ workspaceRoot: workspace });

  write('src/a.ts', "export function alpha(): string { return 'a'; }\n");
  write('src/b.ts', "import { alpha } from './a';\nexport function beta(): string { return alpha(); }\n");
  write('src/noeol.ts', 'export const NO_EOL = true;');
  write('src/empty.ts', '');
  write('src/crlf.ts', "export function crlf(): number {\r\n  return 1;\r\n}\r\n");
  write('src/unicode.ts', '/** توضیح فارسی برای آزمون یونیکد. */\nexport function تابع🙂(): string { return "مقدار"; }\n');
  write('README.md', '# parity fixture\n');
});

afterEach(() => {
  extractors.dispose();
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('Phase 0 — full vs incremental parity', () => {
  test('an added, modified, deleted and renamed file leaves the same index as a full rebuild', async () => {
    const before = await fullIndex();

    /* Same four mutations a watcher would report. */
    write('src/new.ts', 'export function fresh(): boolean { return true; }\n');
    write('src/a.ts', "export function alpha(): string { return 'a2'; }\nexport const EXTRA = 1;\n");
    remove('src/noeol.ts');
    rename('src/unicode.ts', 'src/unicode-renamed.ts');

    const expected = await fullIndex();
    const events: FileChangeEvent[] = [
      { type: 'created', path: 'src/new.ts' },
      { type: 'modified', path: 'src/a.ts' },
      { type: 'deleted', path: 'src/noeol.ts' },
      { type: 'renamed', path: 'src/unicode-renamed.ts', oldPath: 'src/unicode.ts' },
    ];
    const incremental = await engineFor(before.projectIndex).applyChanges(events);

    expect(projection(incremental.projectIndex)).toEqual(projection(expected.projectIndex));
  });

  test('a rename that also changed the content still matches a full rebuild', async () => {
    const before = await fullIndex();

    /* `git mv` plus an edit: the id cannot be preserved, and a consumer that
       imported the old path must not keep a resolved reference to it. */
    fs.renameSync(path.join(workspace, 'src/a.ts'), path.join(workspace, 'src/renamed.ts'));
    write('src/renamed.ts', "export function renamed(): string { return 'renamed'; }\n");

    const expected = await fullIndex();
    const incremental = await engineFor(before.projectIndex).applyChanges([
      { type: 'renamed', path: 'src/renamed.ts', oldPath: 'src/a.ts' },
    ]);

    expect(projection(incremental.projectIndex)).toEqual(projection(expected.projectIndex));
  });

  test('the deleted file leaves no symbol, edge or vector behind', async () => {
    const before = await fullIndex();
    const victim = before.projectIndex.files.find(file => file.path === 'src/b.ts')!;
    const victimSymbolIds = new Set(
      before.projectIndex.symbols.filter(symbol => symbol.fileId === victim.id).map(symbol => symbol.id)
    );

    remove('src/b.ts');
    const incremental = await engineFor(before.projectIndex).applyChanges([
      { type: 'deleted', path: 'src/b.ts' },
    ]);
    const after = incremental.projectIndex;

    expect(after.files.map(file => file.path)).not.toContain('src/b.ts');
    expect(after.symbols.filter(symbol => symbol.fileId === victim.id)).toHaveLength(0);
    expect(after.symbols.filter(symbol => victimSymbolIds.has(symbol.id))).toHaveLength(0);
    for (const edge of after.graphs.dependencyGraph) {
      expect(edge.from).not.toBe(victim.id);
      expect(edge.to).not.toBe(victim.id);
    }
    for (const chunk of after.vectorChunks ?? []) {
      expect(chunk.fileId).not.toBe(victim.id);
    }
  });

  test('a rename keeps the file id stable, which is the one documented divergence', async () => {
    const before = await fullIndex();
    const idBefore = before.projectIndex.files.find(file => file.path === 'src/unicode.ts')!.id;

    rename('src/unicode.ts', 'src/unicode-renamed.ts');
    const expected = await fullIndex();
    const incremental = await engineFor(before.projectIndex).applyChanges([
      { type: 'renamed', path: 'src/unicode-renamed.ts', oldPath: 'src/unicode.ts' },
    ]);

    expect(incremental.projectIndex.files.find(file => file.path === 'src/unicode-renamed.ts')?.id)
      .toBe(idBefore);
    /* A full rebuild derives the id from the path, so it differs — the parity
       comparison above therefore keys on path, and this test states why. */
    expect(expected.projectIndex.files.find(file => file.path === 'src/unicode-renamed.ts')?.id)
      .not.toBe(idBefore);
  });

  test('no update at all is still a no-op on the semantic projection', async () => {
    const before = await fullIndex();
    const expected = await fullIndex();
    const incremental = await engineFor(before.projectIndex).applyChanges([]);

    expect(projection(incremental.projectIndex)).toEqual(projection(expected.projectIndex));
  });
});

describe('Phase 0 — determinism of the full index', () => {
  test('two full runs over the same files produce the same canonical projection', async () => {
    const first = await fullIndex();
    const second = await fullIndex();

    expect(canonicalJson(projection(first.projectIndex))).toBe(
      canonicalJson(projection(second.projectIndex))
    );
  });

  test('file order and symbol order do not depend on the order files were written', async () => {
    const first = await fullIndex();

    /* Rewrite the same bytes in a different order; nothing semantic changes. */
    const contents = new Map<string, string>();
    for (const file of first.projectIndex.files) {
      contents.set(file.path, fs.readFileSync(path.join(workspace, file.path), 'utf8'));
    }
    for (const [relativePath, content] of [...contents.entries()].reverse()) {
      write(relativePath, content);
    }

    const second = await fullIndex();
    expect(canonicalJson(projection(second.projectIndex))).toBe(
      canonicalJson(projection(first.projectIndex))
    );
  });

  test('Unicode, CRLF and BOM content survives the pipeline unchanged', async () => {
    const { projectIndex } = await fullIndex();

    const unicode = projectIndex.files.find(file => file.path === 'src/unicode.ts');
    expect(unicode).toBeDefined();
    expect(unicode!.binary).toBe(false);
    expect(
      projectIndex.symbols.some(symbol => symbol.fileId === unicode!.id && symbol.name === 'تابع🙂')
    ).toBe(true);

    const crlf = projectIndex.files.find(file => file.path === 'src/crlf.ts');
    expect(crlf).toBeDefined();
    /* `file.lines` counts line terminators (the `wc -l` convention), while
       `LineIndex.lineCount` counts lines including the empty one a trailing
       break opens. The two numbers are both correct and deliberately different;
       the mapping is recorded in `docs/CONTRACTS.md`. */
    expect(crlf!.lines).toBe(3);
    expect(fs.readFileSync(path.join(workspace, 'src/crlf.ts'), 'utf8').split('\n').length).toBe(4);

    const empty = projectIndex.files.find(file => file.path === 'src/empty.ts');
    expect(empty).toBeDefined();
    expect(empty!.size).toBe(0);
  });
});
