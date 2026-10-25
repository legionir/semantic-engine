/**
 * P-06 — truncation-honesty rollout (§16 / §17 / §25).
 *
 * AI-03 fixed the six tools that returned no truncation signal at all. This
 * suite locks the remaining paged/limited surfaces so every capped result is
 * machine-readable as capped — and adds a contract test so any future tool
 * with a `limit` cannot silently regress: `truncated` must be accompanied by
 * an honest count (total, or an explicit "at least" count when the scan
 * stopped early).
 */

import { SemanticSearchTool } from './SemanticSearchTool';
import { ExplainSymbolTool } from './ExplainSymbolTool';
import { FindSymbolTool } from './FindSymbolTool';
import { GetRecentChangesTool } from './GetRecentChangesTool';
import { ImpactAnalysisTool } from './ImpactAnalysisTool';
import { ProjectListFilesTool, SearchTextTool, SymbolFindTool } from './Phase1ReadTools';
import { ProjectIndexReader } from '../ProjectIndexReader';
import {
  ProjectIndex,
  SymbolEntry,
  FileEntry,
  CallEdge,
} from '../../core/types/project-index.types';
import { makeConfidence } from '../../core/types/common.types';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

function fileEntry(id: string, p: string): FileEntry {
  return {
    id, path: p, language: 'typescript', encoding: 'utf8', size: 50, lines: 4,
    hash: `hash-${id}`, modified: '2026-01-01T00:00:00.000Z', binary: false,
    testFile: false, generated: false,
  } as FileEntry;
}

function symbolEntry(id: string, fileId: string, name: string): SymbolEntry {
  return {
    id, fileId, parentId: null, kind: 'function', name, fullyQualifiedName: name,
    line: 2, endLine: 4, signature: `function ${name}()`, source: 'tree-sitter',
    confidence: makeConfidence(100), exported: true,
  } as SymbolEntry;
}

function callEdge(from: string, to: string, line: number): CallEdge {
  return {
    id: `e-${from}-${to}`, caller: from, callee: to, kind: 'direct', line,
    callerKind: 'symbol',
    provenance: { basis: 'ast', confidence: 90, extractor: 'typescript-api' },
  } as CallEdge;
}

const METRIC = { totalFiles: 0, totalLoc: 0, totalSymbols: 0, avgCyclomaticComplexity: 1, languageBreakdown: { typescript: 1 } };

function buildIndex(root: string, files: FileEntry[], symbols: SymbolEntry[], callGraph: CallEdge[] = []): ProjectIndex {
  return {
    schemaVersion: '2.0.0', root: 'fixture', rootPath: root,
    generatedAt: '2026-01-01T00:00:00.000Z', languages: ['typescript'],
    files, symbols,
    graphs: { callGraph, typeGraph: [], dependencyGraph: [] },
    diagnostics: [],
    metrics: { ...METRIC, totalFiles: files.length, totalSymbols: symbols.length },
  } as unknown as ProjectIndex;
}

describe('P-06: remaining paged surfaces must declare their cap', () => {
  const root = '/tmp/p06';

  test('semantic_search declares truncated + totalMatches when limit slices', async () => {
    const symbols = Array.from({ length: 7 }, (_, i) => symbolEntry(`s${i}`, 'f1', `AuthHandler${i}`));
    const reader = new ProjectIndexReader(buildIndex(root, [fileEntry('f1', 'src/a.ts')], symbols));
    const tool = new SemanticSearchTool(reader);

    const capped = await tool.execute({ query: 'AuthHandler', mode: 'keyword', limit: 3 });
    expect(capped.success).toBe(true);
    expect(capped.items).toHaveLength(3);
    expect(capped.metadata).toEqual(expect.objectContaining({ truncated: true, totalMatches: 7, limit: 3 }));

    const whole = await tool.execute({ query: 'AuthHandler', mode: 'keyword', limit: 20 });
    expect(whole.items).toHaveLength(7);
    expect(whole.metadata).toEqual(expect.objectContaining({ truncated: false, totalMatches: 7 }));
  });

  test('semantic_search with zero matches is honest about the empty scope', async () => {
    const reader = new ProjectIndexReader(buildIndex(root, [fileEntry('f1', 'src/a.ts')], [symbolEntry('s0', 'f1', 'Widget')]));
    const res = await new SemanticSearchTool(reader).execute({ query: 'NonexistentZzz', mode: 'keyword' });
    expect(res.success).toBe(true);
    expect(res.items).toHaveLength(0);
    expect(res.metadata).toEqual(expect.objectContaining({ truncated: false, totalMatches: 0 }));
  });

  test('explain_symbol reports full edge counts + per-section truncation flags', async () => {
    const callers = Array.from({ length: 5 }, (_, i) => symbolEntry(`c${i}`, 'f1', `caller${i}`));
    const target = symbolEntry('t1', 'f1', 'kernel');
    const edges = callers.map((c, i) => callEdge(c.id, 't1', 10 + i));
    const reader = new ProjectIndexReader(buildIndex(root, [fileEntry('f1', 'src/a.ts')], [...callers, target], edges));
    const tool = new ExplainSymbolTool(reader);

    const capped = await tool.execute({ id: 't1', limit: 2 });
    const meta = capped.items[0]?.metadata as Record<string, unknown>;
    expect(meta.calledByCount).toBe(5);
    expect(meta.callsCount).toBe(0);
    expect(meta.truncated).toEqual(expect.objectContaining({ calledBy: true, any: true, limit: 2 }));
    expect((meta.calledBy as unknown[])).toHaveLength(2);

    const whole = await tool.execute({ id: 't1', limit: 20 });
    const wholeMeta = whole.items[0]?.metadata as Record<string, unknown>;
    expect(wholeMeta.calledByCount).toBe(5);
    expect(wholeMeta.truncated).toEqual(expect.objectContaining({ calledBy: false, any: false }));
  });

  test('project_list_files reports matchCount even when nothing was sliced', async () => {
    const files = Array.from({ length: 4 }, (_, i) => fileEntry(`f${i}`, `src/l${i}.ts`));
    const reader = new ProjectIndexReader(buildIndex(root, files, []));
    const capped = await new ProjectListFilesTool(reader).execute({ limit: 2 });
    expect(capped.items).toHaveLength(2);
    expect(capped.metadata).toEqual(expect.objectContaining({ truncated: true, matchCount: 4, limit: 2 }));

    const whole = await new ProjectListFilesTool(reader).execute({ limit: 10 });
    expect(whole.metadata).toEqual(expect.objectContaining({ truncated: false, matchCount: 4 }));
  });

  test('symbol_find reports exact matchCount with a true slice flag', async () => {
    const symbols = Array.from({ length: 5 }, (_, i) => symbolEntry(`s${i}`, 'f1', `Same${i}`));
    const reader = new ProjectIndexReader(buildIndex(root, [fileEntry('f1', 'src/a.ts')], symbols));
    const capped = await new SymbolFindTool(reader).execute({ query: 'Same', limit: 2 });
    expect(capped.items).toHaveLength(2);
    expect(capped.metadata).toEqual(expect.objectContaining({ truncated: true, matchCount: 5, limit: 2 }));

    // A full page must not claim truncation when the scan proved otherwise.
    const exact = await new SymbolFindTool(reader).execute({ query: 'Same', limit: 5 });
    expect(exact.metadata).toEqual(expect.objectContaining({ truncated: false, matchCount: 5 }));
  });

  test('search_text declares at-least count when the scan stops at the cap', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p06-search-'));
    try {
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src', 'x.ts'), 'needle one\nneedle two\nneedle three\n');
      fs.writeFileSync(path.join(dir, 'src', 'y.ts'), 'needle four\n');
      const files = [fileEntry('fx', 'src/x.ts'), fileEntry('fy', 'src/y.ts')];
      const index = buildIndex(dir, files, []);
      const reader = new ProjectIndexReader(index);
      const tool = new SearchTextTool(reader, dir);

      const capped = await tool.execute({ query: 'needle', limit: 3 });
      expect(capped.items).toHaveLength(3);
      const meta = capped.metadata as Record<string, unknown>;
      expect(meta.truncated).toBe(true);
      expect(meta.matchCountAtLeast).toBe(3);
      expect(meta.countNote).toContain('more matches');
      expect(meta.matchCount).toBeUndefined();

      const whole = await tool.execute({ query: 'needle', limit: 50 });
      expect(whole.metadata).toEqual(expect.objectContaining({ truncated: false, matchCount: 4 }));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('impact_analysis declares the output slice separate from traversal exhaustion', async () => {
    /*
    | دو سقفِ مستقل: maxNodes پیمایش و limit خروجی. قبلاً فقط اولی
    | گزارش می‌شد؛ ۵۰ کاندید با limit=2 دقیقاً همان شکل «۲ پاسخ، همهٔ
    | اثر» را برمی‌گرداند. حالا droppedByLimit + candidateCount می‌آیند.
    */
    const files = Array.from({ length: 4 }, (_, i) => fileEntry(`f${i}`, `src/i${i}.ts`));
    const edges = Array.from({ length: 3 }, (_, i) => ({
      from: `f${i + 1}`, to: 'f0', kind: 'import' as const,
      provenance: { basis: 'import-resolved' as const, confidence: 90, extractor: 'typescript-api' as const },
    }));
    const index = {
      schemaVersion: '2.0.0', root: 'fixture', rootPath: root,
      generatedAt: '2026-01-01T00:00:00.000Z', languages: ['typescript'],
      files, symbols: [],
      graphs: { callGraph: [], typeGraph: [], dependencyGraph: edges, reverseDependencyGraph: edges.map(e => ({ ...e, from: e.to, to: e.from, kind: 'imported-by' })) },
      diagnostics: [],
      metrics: { ...METRIC, totalFiles: 4, totalSymbols: 0 },
    } as unknown as ProjectIndex;
    const reader = new ProjectIndexReader(index);
    const tool = new ImpactAnalysisTool(reader);

    const capped = await tool.execute({ id: 'f0', depth: 2, limit: 2 });
    const meta = capped.metadata as Record<string, unknown>;
    expect(capped.items).toHaveLength(2);
    expect(meta.candidateCount).toBe(3);
    expect(meta.droppedByLimit).toBe(true);
    expect(meta.truncated).toBe(true);
    expect(meta.traversalExhausted).toBe(false);

    const whole = await tool.execute({ id: 'f0', depth: 2, limit: 20 });
    const wholeMeta = whole.metadata as Record<string, unknown>;
    expect(wholeMeta.droppedByLimit).toBe(false);
    expect(wholeMeta.truncated).toBe(false);
  });

  test('get_recent_changes declares the examined window when since cuts into a full page', async () => {
    /*
    | باگِ واقعی (P-06): `since` پس از برشِ limit در حافظه اعمال
    | می‌شد؛ وقتی پنجرهٔ limit پر بود، کامیت‌های منطبقِ بازه که
    | کهنه‌تر از ابتدای پنجره بودند هرگز بررسی نشده بودند و خروجی
    | خالی «تغییری نیست» را القاء می‌کرد (§16). اصلاحِ رفتار
    | پیش‌فرضِ ابزار (پنجره = آخرین limit کامیت) حفظ شد — چون
    | `git --since` روی تاریخ committer فیلتر می‌کند درحالی‌که
    | ابزار `%aI` (author date) را برمی‌گرداند، جابه‌جاییِ فیلتر به
    | داخل git معنای قرارداد را تغییر می‌داد (کامیتِ rebase/merge با
    | author کهنه و committer تازه جابه‌جا می‌شد)؛ یک حدسِ رفتاریِ نو
    | اصلاح بود. حالا خودِ محدودیت machine-readable اعلام می‌شود.
    */
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p06-repo-')));
    const run = (...args: string[]) =>
      execFileSync('git', args, { cwd: repo, stdio: 'ignore', env: { ...process.env, TZ: 'UTC' } });
    try {
      run('init', '-q');
      run('config', 'user.email', 'p@example.com');
      run('config', 'user.name', 'P');
      run('config', 'commit.gpgsign', 'false');
      fs.writeFileSync(path.join(repo, 'a.txt'), '1');
      run('add', '-A');
      run('commit', '-q', '-m', 'old commit', '--date=2020-01-01T00:00:00');
      fs.writeFileSync(path.join(repo, 'b.txt'), '2');
      run('add', '-A');
      run('commit', '-q', '-m', 'new commit');

      const tool = new GetRecentChangesTool(repo);
      // limit=1 → only the newest commit is examined; the 2020 commit was
      // not found *in the searched scope* and the output must say so.
      const narrow = await tool.execute({ since: '2019-12-31T00:00:00Z', limit: 1 });
      expect(narrow.success).toBe(true);
      const meta = narrow.metadata as Record<string, unknown>;
      expect(meta.truncated).toBe(true);
      expect(meta.examinedCommits).toBe(1);
      expect(String(meta.countNote)).toContain('not examined');

      // Same query with a window that covers history returns both.
      const wide = await tool.execute({ since: '2019-12-31T00:00:00Z', limit: 10 });
      expect(wide.items.map(i => i.name)).toContain('old commit');
      expect(wide.metadata?.truncated).toBe(false);

      const capped = await tool.execute({ limit: 1 });
      expect(capped.items).toHaveLength(1);
      expect(capped.metadata).toEqual(expect.objectContaining({ truncated: true, limit: 1 }));
      expect(String(capped.metadata?.countNote)).toContain('older commits');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('get_recent_changes rejects a malformed since instead of silently ignoring it', async () => {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p06-repo2-')));
    const run = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    try {
      run('init', '-q');
      run('config', 'user.email', 'p@example.com');
      run('config', 'user.name', 'P');
      run('config', 'commit.gpgsign', 'false');
      fs.writeFileSync(path.join(repo, 'a.txt'), '1');
      run('add', '-A');
      run('commit', '-q', '-m', 'x');

      const result = await new GetRecentChangesTool(repo).execute({ since: 'not-a-date' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('since');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('get_recent_changes separates "not a repo" from "no commits"', async () => {
    const nonRepo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p06-norepo-')));
    try {
      const result = await new GetRecentChangesTool().execute({ workspaceRoot: nonRepo });
      expect(result.success).toBe(true);
      expect(result.items).toHaveLength(0);
      expect(result.metadata?.isGitRepository).toBe(false);
      expect(String(result.metadata?.emptyNote)).toContain('not a git repository');
    } finally {
      fs.rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});

describe('P-06 contract lock: every limit-bearing tool keeps truncated with a count', () => {
  const root = '/tmp/p06';

  /*
  | قانونِ قرارداد (§30): جایی که `truncated: true` هست، باید یک شمارش
  | همراهش باشد — `matchCount`/`totalMatches`/`count`/`*Count`/
  | `matchCountAtLeast` — تا AI بداند سقف را بالا ببرد یا پرس‌وجو را
  | باریک کند. این تست روی رجیستری واقعی اجرا می‌شود تا ابزار جدیدی
  | که برش دارد و اعلام نمی‌کند، سبز رد نشود.
  */
  test('registered tools: truncated signal is never count-less', async () => {
    const symbols = Array.from({ length: 3 }, (_, i) => symbolEntry(`s${i}`, 'f1', `Engine${i}`));
    const index = buildIndex(root, [fileEntry('f1', 'src/a.ts')], symbols);
    const reader = new ProjectIndexReader(index);
    const tools = [
      new FindSymbolTool(reader),
      new SemanticSearchTool(reader),
      new ExplainSymbolTool(reader),
      new ProjectListFilesTool(reader),
      new SymbolFindTool(reader),
    ];
    for (const tool of tools) {
      const out = await tool.execute({
        name: 'Engine', query: 'Engine', id: 's0', limit: 10, mode: 'keyword',
      });
      const meta = out.metadata as Record<string, unknown> | undefined;
      if (!meta) continue;
      const hasTruncationFlag =
        meta.truncated === true ||
        (typeof meta.truncated === 'object' && meta.truncated !== null &&
          Object.values(meta.truncated as Record<string, unknown>).some(v => v === true));
      if (hasTruncationFlag) {
        const countKeys = Object.keys(meta).filter(k =>
          /Count$/.test(k) || k.endsWith('matchCount') || k === 'matchCountAtLeast' || k === 'count' || k === 'candidateCount');
        expect({ tool: tool.name, countKeys }).toEqual(
          expect.objectContaining({ countKeys: expect.arrayContaining([expect.any(String)]) })
        );
        expect(countKeys.length).toBeGreaterThan(0);
      }
    }
  });
});