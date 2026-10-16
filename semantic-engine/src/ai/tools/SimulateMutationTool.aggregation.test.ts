/**
 * SE-AI-11 — `simulate_mutation` باید به‌ازای **فایل** گزارش دهد، نه به‌ازای هر یال.
 *
 * سناریوی واقعی که این تست قفلش می‌کند: rename متد `rank` با ۲۵ فراخوانی در
 * یک فایل، ۲۵ آیتم تقریباً یکسان و ۱۲٫۵ کیلوبایت خروجی می‌داد و در excerpt
 * شناسهٔ هشِ سمبل نوشته می‌شد — یعنی agent «۲۵ ارجاع در ۲۵ جای مبهم»
 * می‌خواند، درحالی‌که جواب درست «۲۵ سطر فراخوان در یک فایل» است.
 */

import { ProjectIndexReader } from '../ProjectIndexReader';
import { SimulateMutationTool } from './SimulateMutationTool';
import { ProjectIndex } from '../../core/types/project-index.types';

const index = {
  version: '1.0.0',
  generatedAt: new Date().toISOString(),
  files: [
    { id: 'fSrc', path: 'src/ranker.ts', hash: 'h1', size: 300, language: 'typescript' },
    { id: 'fTest', path: 'src/ranker.test.ts', hash: 'h2', size: 400, language: 'typescript' },
  ],
  symbols: [
    { id: 'cls', fileId: 'fSrc', parentId: null, kind: 'class', name: 'ContextRanker', line: 10, endLine: 90 },
    { id: 'sym-rank', fileId: 'fSrc', parentId: 'cls', kind: 'method', name: 'rank', line: 197, endLine: 230 },
    { id: 'c1', fileId: 'fTest', parentId: null, kind: 'method', name: 'ranked', line: 33, endLine: 40 },
    { id: 'c2', fileId: 'fTest', parentId: null, kind: 'method', name: 'weak', line: 47, endLine: 50 },
    { id: 'c3', fileId: 'fTest', parentId: null, kind: 'method', name: 'strong', line: 61, endLine: 64 },
    { id: 'c4', fileId: 'fSrc', parentId: 'cls', kind: 'method', name: 'search', line: 320, endLine: 340 },
  ],
  graphs: {
    dependencyGraph: [],
    typeGraph: [],
    callGraph: [
      { id: 'e1', caller: 'c1', callerKind: 'symbol', callee: 'sym-rank', kind: 'direct', line: 33, provenance: { confidence: 85, basis: 'ast', extractor: 'typescript-api' } },
      { id: 'e2', caller: 'c2', callerKind: 'symbol', callee: 'sym-rank', kind: 'direct', line: 47, provenance: { confidence: 85, basis: 'ast', extractor: 'typescript-api' } },
      { id: 'e3', caller: 'c3', callerKind: 'symbol', callee: 'sym-rank', kind: 'direct', line: 61, provenance: { confidence: 85, basis: 'ast', extractor: 'typescript-api' } },
      { id: 'e4', caller: 'c4', callerKind: 'symbol', callee: 'sym-rank', kind: 'direct', line: 320, provenance: { confidence: 85, basis: 'ast', extractor: 'typescript-api' } },
    ],
  },
} as unknown as ProjectIndex;

async function simulate() {
  const tool = new SimulateMutationTool(new ProjectIndexReader(index));
  return tool.execute({ actionType: 'rename_symbol', targetSymbolId: 'sym-rank', newName: 'rankCandidates' });
}

describe('SE-AI-11 — aggregation of broken references per file', () => {
  it('یک آیتم به‌ازای فایل می‌دهد، نه به‌ازای هر یال', async () => {
    const result = await simulate();
    expect(result.success).toBe(true);
    expect(result.items.map((item) => item.path)).toEqual(['src/ranker.test.ts', 'src/ranker.ts']);
    expect(result.metadata).toMatchObject({ affectedFiles: 2 });
  });

  it('شمارش و سطرهای فراخوان در metadata می‌آید', async () => {
    const result = await simulate();
    const testFile = result.items.find((item) => item.path === 'src/ranker.test.ts');
    expect(testFile?.metadata).toMatchObject({
      brokenReferenceCount: 3,
      lines: [33, 47, 61],
      relations: ['calls'],
    });
    expect(testFile?.metadata?.callerSymbols).toEqual(expect.arrayContaining(['ranked', 'weak', 'strong']));
  });

  it('excerpt نامِ خوانای سمبل هدف را می‌دهد، نه شناسهٔ هش آن', async () => {
    const result = await simulate();
    const testFile = result.items.find((item) => item.path === 'src/ranker.test.ts');
    expect(testFile?.excerpt).toContain('src/ranker.test.ts:33');
    expect(testFile?.excerpt).toContain('3 call site(s)');
    expect(testFile?.excerpt).toContain('`rank`');
    expect(testFile?.excerpt).not.toContain('sym-rank');
    /*
    | لیست سطرهای فراخوان فقط یک‌بار حمل می‌شود: در `metadata.lines`؛ excerpt
    | آن را تکرار نمی‌کند (توکن اضافه برای هیچ خواننده‌ای).
    */
    expect(testFile?.excerpt).not.toContain('47, 61');
    // آیتمِ تک‌سطری هم لیست تکراری ندارد
    const srcFile = result.items.find((item) => item.path === 'src/ranker.ts');
    expect(srcFile?.excerpt).toContain('src/ranker.ts:320 — 1 call site(s)');
    expect(srcFile?.excerpt).not.toContain('(lines');
  });

  it('context تعداد واقعی سطرهای شکسته و فایل‌ها را جدا می‌گوید', async () => {
    const result = await simulate();
    expect(result.context).toContain('4 broken call site(s) across 2 file(s)');
  });

  it('دادهٔ خامِ diff برای مصرف‌کنندهٔ ماشین دست‌نخورده می‌ماند', async () => {
    const result = await simulate();
    const diff = (result.metadata as { diff: { brokenReferences: { callerId: string }[]; isSafe: boolean } }).diff;
    expect(diff.brokenReferences).toHaveLength(4);
    expect(diff.brokenReferences.map((b) => b.callerId)).toContain('c1');
    expect(diff.isSafe).toBe(false);
  });
});
