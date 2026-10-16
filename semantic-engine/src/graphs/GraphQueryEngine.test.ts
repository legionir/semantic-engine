/**
 * GAP-01 / SE-AI-03 — پیمایش گراف، با همان دو باگی که نباید تکرار شوند.
 *
 * گراف آزمون عمداً کوچک و دستی است: هر ادعا باید با شمردن روی کاغذ
 * قابل بررسی باشد. سه چیز که آزمون‌ها روی آن تمرکز دارند:
 *
 * ۱. **نزدیک‌ترین، نه اولین.** باگ SE-AI-03 با DFS و `visited`
 *    سراسری ساخته می‌شد؛ اینجا گرهی که هم از عمق ۱ و هم از عمق ۳
 *    می‌شود به آن رسید، باید عمق ۱ گزارش شود.
 * ۲. **حلقه.** گراف وابستگی حلقه دارد و پیمایش نباید گیر کند.
 * ۳. **اعتماد.** یال `name-match` نباید بی‌سروصدا وارد مسیر شود.
 */

import { ProjectIndex } from '../core/types/project-index.types';
import { GraphQueryEngine } from './GraphQueryEngine';
import { provenanceFor } from './EdgeProvenance';

/*
| گراف آزمون:
|
|   a ──imports──▶ b ──imports──▶ c
|   │                              ▲
|   └──────────imports─────────────┘        (a → c مستقیم هم هست)
|
|   c ──imports──▶ a                        (حلقه)
|   d ──imports(name-match, 40)──▶ c        (یال ضعیف)
|
|   f1 ──calls──▶ f2 ──calls──▶ f3
|   K  ──extends──▶ Base
*/
function buildIndex(): ProjectIndex {
  const dep = (from: string, to: string, confidence = 85) => ({
    from,
    to,
    kind: 'import' as const,
    provenance: {
      ...provenanceFor(confidence >= 70 ? 'import-resolved' : 'name-match', 'typescript-api', {
        file: `${from}.ts`,
        line: 1,
      }),
      confidence,
    },
  });

  const call = (caller: string, callee: string, confidence = 95) => ({
    id: `${caller}->${callee}`,
    caller,
    callee,
    callerKind: 'symbol' as const,
    kind: 'direct' as const,
    line: 1,
    provenance: {
      ...provenanceFor(confidence >= 70 ? 'ast' : 'name-match', 'typescript-api', {
        file: 'x.ts',
        line: 1,
      }),
      confidence,
    },
  });

  return {
    schemaVersion: '2.0.0',
    generatedAt: new Date().toISOString(),
    root: 'test',
    rootPath: '/test',
    files: [],
    symbols: [],
    languages: {},
    graphs: {
      dependencyGraph: [
        dep('a', 'b'),
        dep('b', 'c'),
        dep('a', 'c'),
        dep('c', 'a'),
        dep('d', 'c', 40),
        dep('a', 'pkg:react'),
      ],
      callGraph: [call('f1', 'f2'), call('f2', 'f3'), call('f3', 'external-name', 25)],
      typeGraph: [
        {
          parent: 'Base',
          child: 'K',
          kind: 'extends' as const,
          provenance: provenanceFor('declared', 'tree-sitter', { file: 'k.ts', line: 1 }),
        },
      ],
      reverseDependencyGraph: [],
    },
    diagnostics: [],
    metrics: {} as never,
  } as unknown as ProjectIndex;
}

const engine = new GraphQueryEngine(buildIndex());

describe('GAP-01 — ساخت گراف', () => {
  it('یال‌های هر سه گراف خوانده می‌شوند', () => {
    // ۵ وابستگی (بستهٔ بیرونی حساب نمی‌شود) + ۳ فراخوانی + ۱ نوع
    expect(engine.edgeCount).toBe(9);
  });

  it('یال به بستهٔ بیرونی وارد گراف نمی‌شود', () => {
    /*
    | `pkg:react` گرهی در این پروژه نیست. نگه داشتنش یعنی پیمایش
    | به جایی می‌رسد که هیچ فایلی ندارد و هر ابزاری باید جداگانه
    | فیلترش کند.
    */
    const out = engine.descendants('a', { depth: 1 }).nodes.map(node => node.id);
    expect(out).not.toContain('pkg:react');
  });
});

describe('SE-AI-03 — نزدیک‌ترین، نه اولین', () => {
  it('گره‌ای که از دو مسیر می‌آید، کوتاه‌ترین عمق را می‌گیرد', () => {
    /*
    | `c` هم از `a → b → c` (عمق ۲) و هم از `a → c` (عمق ۱) دیده
    | می‌شود. با DFS و `visited` سراسری، هرکدام که اول اتفاق
    | بیفتد برنده است. با BFS همیشه عمق ۱.
    */
    const result = engine.descendants('a', { depth: 3 });
    const c = result.nodes.find(node => node.id === 'c')!;
    expect(c.depth).toBe(1);
  });

  it('همهٔ گره‌های سطح ۱ پیش از سطح ۲ می‌آیند', () => {
    const result = engine.descendants('a', { depth: 3 });
    const depths = result.nodes.map(node => node.id === 'b' || node.id === 'c' ? 1 : node.depth);
    expect(depths).toEqual([...depths].sort((x, y) => x - y));
  });

  it('گرهٔ شروع در نتیجه نیست', () => {
    expect(engine.descendants('a', { depth: 3 }).nodes.map(n => n.id)).not.toContain('a');
  });
});

describe('GAP-01 — حلقه', () => {
  it('حلقه، پیمایش را متوقف نمی‌کند و گزارش می‌شود', () => {
    const result = engine.descendants('a', { depth: 5 });
    expect(result.cyclic).toBe(true);
    expect(result.nodes.map(node => node.id).sort()).toEqual(['b', 'c']);
  });

  it('هر گره فقط یک بار در نتیجه است', () => {
    const ids = engine.descendants('a', { depth: 5 }).nodes.map(node => node.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('GAP-01 — سقف گره', () => {
  it('سقف، نتیجه را می‌برد و اعلام می‌کند', () => {
    const result = engine.descendants('a', { depth: 5, maxNodes: 1 });
    expect(result.nodes).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it('بدون رسیدن به سقف، truncated دروغ نمی‌گوید', () => {
    expect(engine.descendants('a', { depth: 5, maxNodes: 100 }).truncated).toBe(false);
  });
});

describe('GAP-01 — جهت', () => {
  it('descendants رو به بیرون می‌رود', () => {
    expect(engine.descendants('b', { depth: 1 }).nodes.map(n => n.id)).toEqual(['c']);
  });

  it('ancestors رو به داخل می‌آید', () => {
    expect(engine.ancestors('c', { depth: 1 }).nodes.map(n => n.id).sort()).toEqual(['a', 'b']);
  });

  it('یال ضعیف در ancestors هم فیلتر می‌شود', () => {
    // `d → c` اعتمادش ۴۰ است.
    expect(engine.ancestors('c', { depth: 1 }).nodes.map(n => n.id)).not.toContain('d');
    expect(
      engine.ancestors('c', { depth: 1, minConfidence: 0 }).nodes.map(n => n.id)
    ).toContain('d');
  });

  it('both هر دو جهت را می‌گیرد', () => {
    const both = engine.neighbors('b', { direction: 'both', depth: 1 }).nodes.map(n => n.id);
    expect(both.sort()).toEqual(['a', 'c']);
  });
});

describe('GAP-01 — فیلتر رابطه', () => {
  it('فقط فراخوانی‌ها', () => {
    const result = engine.descendants('f1', { depth: 3, relations: ['calls'] });
    expect(result.nodes.map(n => n.id)).toEqual(['f2', 'f3']);
  });

  it('رابطهٔ نامرتبط، نتیجهٔ خالی', () => {
    expect(engine.descendants('f1', { depth: 3, relations: ['imports'] }).nodes).toEqual([]);
  });

  it('callers و callees مستقیم‌اند', () => {
    expect(engine.callees('f2').map(edge => edge.to)).toEqual(['f3']);
    expect(engine.callers('f2').map(edge => edge.from)).toEqual(['f1']);
  });

  it('فراخوانی به نام بیرونی، زیر آستانه است و نمی‌آید', () => {
    expect(engine.callees('f3')).toEqual([]);
    expect(engine.callees('f3', { minConfidence: 0 }).map(edge => edge.to)).toEqual([
      'external-name',
    ]);
  });

  it('یال نوع، از فرزند به والد است', () => {
    expect(engine.descendants('K', { depth: 1, relations: ['types'] }).nodes.map(n => n.id)).toEqual(
      ['Base']
    );
    expect(engine.ancestors('Base', { depth: 1, relations: ['types'] }).nodes.map(n => n.id)).toEqual(
      ['K']
    );
  });
});

describe('GAP-01 — پذیرش: کوتاه‌ترین مسیر و مسیر ضعیف', () => {
  it('کوتاه‌ترین مسیر را می‌دهد، نه اولین مسیر', () => {
    /*
    | از `a` به `c` دو راه هست: مستقیم، و از راه `b`. BFS همیشه
    | مستقیم را می‌دهد.
    */
    const result = engine.path('a', 'c');
    expect(result.path?.map(step => step.node)).toEqual(['a', 'c']);
    expect(result.confident).toBe(true);
  });

  it('مسیر چندگامی درست ساخته می‌شود', () => {
    const result = engine.path('f1', 'f3', { relations: ['calls'] });
    expect(result.path?.map(step => step.node)).toEqual(['f1', 'f2', 'f3']);
    expect(result.path?.[0].via).toBeNull();
    expect(result.path?.[1].via?.relation).toBe('calls');
  });

  it('مسیری که فقط از یال ضعیف می‌گذرد، جدا گزارش می‌شود', () => {
    /*
    | معیار پذیرش فاز. `d → c` تنها راه است و اعتمادش ۴۰. مسیر
    | برگردانده می‌شود — ولی با `confident: false` و خودِ آن یال
    | در `weakEdges`، نه یک پرچم مبهم.
    */
    const result = engine.path('d', 'c');
    expect(result.path?.map(step => step.node)).toEqual(['d', 'c']);
    expect(result.confident).toBe(false);
    expect(result.weakestLink).toBe(40);
    expect(result.weakEdges).toHaveLength(1);
    expect(result.weakEdges[0].basis).toBe('name-match');
  });

  it('مسیر ناموجود، null است — نه استثنا', () => {
    const result = engine.path('f1', 'a', { relations: ['calls'] });
    expect(result.path).toBeNull();
    expect(result.confident).toBe(false);
  });

  it('مسیر به خود، یک گام است', () => {
    const result = engine.path('a', 'a');
    expect(result.path).toEqual([{ node: 'a', via: null }]);
    expect(result.confident).toBe(true);
  });

  it('گرهٔ ناشناخته، null می‌دهد', () => {
    expect(engine.path('ghost', 'a').path).toBeNull();
  });

  it('حلقه، مسیریابی را معلق نمی‌کند', () => {
    const result = engine.path('b', 'a');
    expect(result.path?.map(step => step.node)).toEqual(['b', 'c', 'a']);
  });
});

describe('GAP-01 — زیرگراف', () => {
  it('از چند دانه هم‌زمان گسترش می‌یابد', () => {
    const result = engine.subgraph(['a', 'f1'], { depth: 1 });
    const ids = result.nodes.map(node => node.id).sort();
    expect(ids).toEqual(['b', 'c', 'f2']);
  });

  it('یال‌های داخل زیرگراف برمی‌گردند، نه همهٔ یال‌ها', () => {
    const result = engine.subgraph(['f1'], { depth: 1, relations: ['calls'] });
    expect(result.edges.map(edge => `${edge.from}->${edge.to}`)).toEqual(['f1->f2']);
  });

  it('دانه‌هایی که اصلاً در گراف نیستند گزارش می‌شوند', () => {
    const result = engine.subgraph(['a', 'ghost'], { depth: 1 });
    expect(result.seeds).toEqual(['a']);
  });

  it('سقف گره در زیرگراف هم رعایت می‌شود', () => {
    const result = engine.subgraph(['a'], { depth: 3, maxNodes: 1 });
    expect(result.truncated).toBe(true);
    expect(result.nodes.length).toBeLessThanOrEqual(1);
  });
});

describe('GAP-01 — اعتماد مسیر', () => {
  it('اعتماد هر گره، ضعیف‌ترین یالِ راهِ رسیدن به آن است', () => {
    const result = engine.descendants('d', { depth: 2, minConfidence: 0 });
    const c = result.nodes.find(node => node.id === 'c')!;
    expect(c.pathConfidence).toBe(40);

    const a = result.nodes.find(node => node.id === 'a')!;
    expect(a.pathConfidence).toBe(40); // از راه c، پس همان ضعیف‌ترین
  });

  it('آستانهٔ پیش‌فرض همان ۷۰ فاز ۱۹ است', () => {
    expect(engine.descendants('d', { depth: 1 }).nodes).toEqual([]);
    expect(engine.descendants('d', { depth: 1, minConfidence: 40 }).nodes.map(n => n.id)).toEqual([
      'c',
    ]);
  });
});

describe('SE-GRAPH-14 — «دوباره‌دیدن» با «حلقه» یکی نیست', () => {
  /*
  | a ──▶ b ──▶ d
  | └──▶ c ──┘            لوزی: d دو بار دیده می‌شود، حلقه نیست
  */
  const edge = (from: string, to: string) => ({
    from,
    to,
    kind: 'import' as const,
    provenance: { ...provenanceFor('import-resolved', 'typescript-api', { file: `${from}.ts`, line: 1 }), confidence: 90 },
  });

  const indexFor = (deps: ReturnType<typeof edge>[]): ProjectIndex =>
    ({
      schemaVersion: '2.0.0',
      root: 't',
      generatedAt: new Date().toISOString(),
      languages: ['typescript'],
      files: [],
      symbols: [],
      graphs: { dependencyGraph: deps, callGraph: [], typeGraph: [], reverseDependencyGraph: [] },
      diagnostics: [],
      metrics: { totalFiles: 0, totalLoc: 0, totalSymbols: 0, avgCyclomaticComplexity: 0, languageBreakdown: {} },
    }) as unknown as ProjectIndex;

  it('لوزی، cyclic دروغ نمی‌گوید', () => {
    const engineDiamond = new GraphQueryEngine(
      indexFor([edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')])
    );

    const result = engineDiamond.descendants('a', { depth: 5 });
    expect(result.nodes.map(n => n.id).sort()).toEqual(['b', 'c', 'd']);
    expect(result.cyclic).toBe(false);
  });

  it('حلقهٔ واقعی همان‌جا که هست گزارش می‌شود', () => {
    const engineCycle = new GraphQueryEngine(
      indexFor([edge('a', 'b'), edge('b', 'c'), edge('c', 'a')])
    );

    expect(engineCycle.descendants('a', { depth: 5 }).cyclic).toBe(true);
  });

  it('خودحلقه هم حلقه است', () => {
    const engineSelf = new GraphQueryEngine(indexFor([edge('a', 'a')]));
    expect(engineSelf.descendants('a', { depth: 3 }).cyclic).toBe(true);
  });
});
