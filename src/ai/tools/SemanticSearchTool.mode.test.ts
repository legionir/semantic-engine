/**
 * SE-AI-13 — خروجی باید بگوید رتبه‌بندی با کدام موتور انجام شده.
 */

import { describeSearchMode } from './SemanticSearchTool';
import { ProjectIndexReader } from '../ProjectIndexReader';
import { SemanticSearchTool } from './SemanticSearchTool';
import { ProjectIndex } from '../../core/types/project-index.types';

describe('SE-AI-13 — describeSearchMode', () => {
  it('وقتی بردار واقعاً نامزد داد: hybrid (و vector-only اگر درخواست خالص بوده)', () => {
    expect(
      describeSearchMode({ requestedMode: 'hybrid', vectorAvailable: true, generatorReady: true, vectorUsed: true })
    ).toEqual({ searchMode: 'hybrid', vectorAvailable: true });
    expect(
      describeSearchMode({ requestedMode: 'vector', vectorAvailable: true, generatorReady: true, vectorUsed: true })
    ).toEqual({ searchMode: 'vector-only', vectorAvailable: true });
  });

  it('درخواستِ keyword هیچ بهانه‌ای نمی‌سازد', () => {
    expect(
      describeSearchMode({ requestedMode: 'keyword', vectorAvailable: false, generatorReady: false, vectorUsed: false })
    ).toEqual({ searchMode: 'keyword-only', vectorAvailable: false });
  });

  it('علتِ تنزل را دقیق می‌گوید: نبودِ بردار در ایندکس', () => {
    expect(
      describeSearchMode({ requestedMode: 'hybrid', vectorAvailable: false, generatorReady: false, vectorUsed: false })
    ).toEqual({ searchMode: 'keyword-only', vectorAvailable: false, degradedReason: 'no-vectors-in-index' });
  });

  it('علتِ تنزل: بردار هست ولی مدلِ هم‌سنجه در دسترس نیست', () => {
    expect(
      describeSearchMode({ requestedMode: 'hybrid', vectorAvailable: true, generatorReady: false, vectorUsed: false })
    ).toEqual({ searchMode: 'keyword-only', vectorAvailable: true, degradedReason: 'no-embedding-model' });
  });

  it('علتِ تنزل: همه‌چیز بود، فقط هیچ نامزدِ برداری تطبیق نکرد', () => {
    expect(
      describeSearchMode({ requestedMode: 'hybrid', vectorAvailable: true, generatorReady: true, vectorUsed: false })
    ).toEqual({ searchMode: 'keyword-only', vectorAvailable: true, degradedReason: 'no-vector-matches' });
  });
});

describe('SE-AI-13 — metadata واقعیِ ابزار', () => {
  const indexWithoutVectors = {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    files: [{ id: 'f1', path: 'src/a.ts', hash: 'h1', size: 10, language: 'typescript' }],
    symbols: [{ id: 's1', fileId: 'f1', parentId: null, kind: 'class', name: 'AlphaRanker', line: 1, endLine: 9 }],
    graphs: { dependencyGraph: [], typeGraph: [], callGraph: [] },
  } as unknown as ProjectIndex;

  it('بدونِ vectorChunks صریح می‌گوید keyword-only و چرا', async () => {
    const tool = new SemanticSearchTool(new ProjectIndexReader(indexWithoutVectors));
    const result = await tool.execute({ query: 'ranking' });

    expect(result.success).toBe(true);
    expect(result.metadata).toMatchObject({
      searchMode: 'keyword-only',
      vectorAvailable: false,
      degradedReason: 'no-vectors-in-index',
      usedEmbeddings: false,
    });
  });

  it('با درخواستِ صریحِ keyword، degradedReason ساخته نمی‌شود', async () => {
    const tool = new SemanticSearchTool(new ProjectIndexReader(indexWithoutVectors));
    const result = await tool.execute({ query: 'ranking', mode: 'keyword' });

    expect(result.metadata).toMatchObject({ searchMode: 'keyword-only', vectorAvailable: false });
    expect(result.metadata?.degradedReason).toBeUndefined();
  });
});
