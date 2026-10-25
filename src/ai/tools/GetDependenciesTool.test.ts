/**
 * F-0036 — `get_dependencies` و `impact_analysis` باید به یک سؤال یک جواب بدهند.
 *
 * یال‌های call سرِ **سمبلی** دارند؛ `level:'file'` (پیش‌فرض ابزار) آن گره‌ها
 * را دور می‌ریخت، پس برای متدی با فراخوان‌های زیاد فقط فایل‌هایی دیده
 * می‌شدند که فراخوانشان در سطح ماژول نوشته شده بود. اندازه‌گیری‌شده روی
 * ایندکس خودِ موتور: `get_dependencies` یک آیتم در برابر `impact_analysis`
 * چهار آیتم برای همان `ContextRanker.rank`.
 */

import { ProjectIndexReader } from '../ProjectIndexReader';
import { GetDependenciesTool } from './GetDependenciesTool';
import { ImpactAnalysisTool } from './ImpactAnalysisTool';
import { ProjectIndex } from '../../core/types/project-index.types';

function file(id: string, path: string) {
  return {
    id, path, language: 'typescript', size: 10, lines: 8, hash: 'h', binary: false,
    testFile: false, generated: false, symbolIds: [], imports: [], exports: [],
    diagnostics: [], outline: [],
  };
}

function symbol(id: string, fileId: string, name: string, line: number) {
  return {
    id, fileId, parentId: null, kind: 'function', name, fullyQualifiedName: name,
    signature: `${name}()`, visibility: 'public', line, endLine: line + 3, documentation: null,
    deprecated: false, exported: true, source: 'tree-sitter', async: false, generator: false,
    abstract: false, static: false, readonly: false, parameters: [], returnType: null,
    generics: [], extends: [], implements: [], complexity: null, referenceCount: null,
    calls: [], calledBy: [],
  };
}

/*
 * sTarget در src/target.ts چهار فراخوان دارد: دو تا از سمبل‌های a.ts، یکی
 * از سمبل b.ts، و یکی از خودِ فایل c.ts (فراخوان سطح ماژول).
 */
function index(): ProjectIndex {
  return {
    schemaVersion: '2.0.0',
    generatedAt: new Date().toISOString(),
    root: 'probe',
    rootPath: '/probe',
    languages: {},
    files: [
      file('fTarget', 'src/target.ts'),
      file('fA', 'src/a.ts'),
      file('fB', 'src/b.ts'),
      file('fC', 'src/c.ts'),
    ],
    symbols: [
      symbol('sTarget', 'fTarget', 'compute', 3),
      symbol('sA1', 'fA', 'alpha', 5),
      symbol('sA2', 'fA', 'alpha2', 7),
      symbol('sB1', 'fB', 'beta', 9),
    ],
    graphs: {
      dependencyGraph: [],
      typeGraph: [],
      /*
      | هر دو مسیرِ ایندکسِ واقعی اینجا تقلید می‌شود: `get_dependencies`
      | از `reverseDependencyGraph` می‌خواند و `GraphQueryEngine` (پشت
      | `impact_analysis`) از `callGraph`. همان یال‌ها در هر دو، پس هر
      | اختلافِ خروجی یعنی یکی از دو ابزار گره‌های سمبلی را دور ریخته.
      */
      callGraph: [
        { id: 'c1', caller: 'sA1', callerKind: 'symbol', callee: 'sTarget', kind: 'direct', line: 6, provenance: { confidence: 85, basis: 'ast', extractor: 'typescript-api' } },
        { id: 'c2', caller: 'sA2', callerKind: 'symbol', callee: 'sTarget', kind: 'direct', line: 8, provenance: { confidence: 85, basis: 'ast', extractor: 'typescript-api' } },
        { id: 'c3', caller: 'sB1', callerKind: 'symbol', callee: 'sTarget', kind: 'direct', line: 10, provenance: { confidence: 85, basis: 'ast', extractor: 'typescript-api' } },
        { id: 'c4', caller: 'fC', callerKind: 'file', callee: 'sTarget', kind: 'direct', line: 2, provenance: { confidence: 85, basis: 'ast', extractor: 'typescript-api' } },
      ],
      reverseDependencyGraph: [
        { from: 'sTarget', to: 'sA1', kind: 'called-by', provenance: { confidence: 85, basis: 'ast', extractor: 'typescript-api' } },
        { from: 'sTarget', to: 'sA2', kind: 'called-by', provenance: { confidence: 85, basis: 'ast', extractor: 'typescript-api' } },
        { from: 'sTarget', to: 'sB1', kind: 'called-by', provenance: { confidence: 85, basis: 'ast', extractor: 'typescript-api' } },
        { from: 'sTarget', to: 'fC', kind: 'called-by', provenance: { confidence: 85, basis: 'ast', extractor: 'typescript-api' } },
      ],
    },
    diagnostics: [],
    metrics: {} as never,
  } as unknown as ProjectIndex;
}

const tool = () => new GetDependenciesTool(new ProjectIndexReader(index()));
const truthCallerFiles = ['src/a.ts', 'src/b.ts', 'src/c.ts'];

describe('F-0036 — رول‌آپِ فراخوان‌های سمبلی در get_dependencies', () => {
  it('با level پیش‌فرض (file) هر فایلِ فراخوان‌دهنده یک بار می‌آید، نه فقط سطح‌ماژول‌ها', async () => {
    const result = await tool().execute({ id: 'sTarget', direction: 'backward' });

    expect(result.success).toBe(true);
    expect(result.items.map(i => i.path).sort()).toEqual(truthCallerFiles);
  });

  it('چند فراخوانِ یک فایل، یک سطر با شمارش و نامِ سمبل‌های رابط', async () => {
    const result = await tool().execute({ id: 'sTarget', direction: 'backward' });
    const a = result.items.find(i => i.path === 'src/a.ts');

    expect(a?.id).toBe('fA');
    expect(a?.metadata).toMatchObject({ dependents: 2, viaSymbols: ['alpha', 'alpha2'] });
  });

  it('level=symbol همان سمبل‌های رابط را می‌دهد (فایلِ سطح‌ماژول کنار می‌رود)', async () => {
    const result = await tool().execute({ id: 'sTarget', direction: 'backward', level: 'symbol' });

    expect(result.items.map(i => i.id).sort()).toEqual(['sA1', 'sA2', 'sB1']);
  });

  it('هیچ سطرِ تکراری برای یک فایل نیست، حتی اگر چند یال برسد', async () => {
    const result = await tool().execute({ id: 'sTarget', direction: 'backward' });
    const ids = result.items.map(i => i.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('دو ابزار، یک جواب: مجموعهٔ فایل‌ها با impact_analysis دقیقاً برابر است', async () => {
    const reader = new ProjectIndexReader(index());
    const deps = await new GetDependenciesTool(reader).execute({ id: 'sTarget', direction: 'backward' });
    const impact = await new ImpactAnalysisTool(reader).execute({ id: 'sTarget', depth: 1 });

    const fromDeps = new Set(deps.items.map(i => i.path));
    const fromImpact = new Set(impact.items.map(i => i.path));

    expect(fromDeps.size).toBe(3);
    expect(fromImpact.size).toBe(3);
    expect(fromDeps).toEqual(fromImpact);
  });
});
