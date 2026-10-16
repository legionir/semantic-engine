/**
 * GAP-02 — کاوشگر زیرگراف: وقتی بودجه تمام می‌شود، چه چیزی می‌ماند؟
 *
 * معیار پذیرش فاز صریح است: «زیرگراف با سقف ۵۰ گره، **همیشه**
 * گره‌های نزدیک‌تر و مطمئن‌تر را ترجیح دهد». پس بیشتر این آزمون‌ها
 * دربارهٔ لحظه‌ای‌اند که سقف می‌خورد — نه دربارهٔ گراف کوچکی که
 * همه‌چیزش جا می‌شود.
 */

import { ProjectIndex } from '../core/types/project-index.types';
import { GraphQueryEngine } from './GraphQueryEngine';
import { SubgraphExplorer } from './SubgraphExplorer';
import { provenanceFor } from './EdgeProvenance';

function dep(from: string, to: string, confidence = 90) {
  return {
    from,
    to,
    kind: 'import' as const,
    provenance: {
      ...provenanceFor(confidence >= 70 ? 'import-resolved' : 'name-match', 'typescript-api', {
        file: from,
        line: 1,
      }),
      confidence,
    },
  };
}

function indexOf(edges: ReturnType<typeof dep>[]): ProjectIndex {
  return {
    schemaVersion: '2.0.0',
    generatedAt: new Date().toISOString(),
    root: 'test',
    rootPath: '/test',
    files: [],
    symbols: [],
    languages: {},
    graphs: {
      dependencyGraph: edges,
      callGraph: [],
      typeGraph: [],
      reverseDependencyGraph: [],
    },
    diagnostics: [],
    metrics: {} as never,
  } as unknown as ProjectIndex;
}

function explorerFor(edges: ReturnType<typeof dep>[]): SubgraphExplorer {
  return new SubgraphExplorer(new GraphQueryEngine(indexOf(edges)));
}

describe('GAP-02 — چندریشه و دوجهته', () => {
  /*
  |   a ──▶ b ──▶ c        و        x ──▶ y
  */
  const edges = [dep('a', 'b'), dep('b', 'c'), dep('x', 'y')];

  it('از همهٔ دانه‌ها هم‌زمان گسترش می‌یابد', () => {
    const result = explorerFor(edges).explore(['a', 'x'], { maxDepth: 2 });
    expect(result.nodes.map(node => node.id).sort()).toEqual(['b', 'c', 'y']);
  });

  it('هر گره می‌گوید از کدام دانه آمده', () => {
    const result = explorerFor(edges).explore(['a', 'x'], { maxDepth: 2 });
    expect(result.nodes.find(node => node.id === 'y')!.seed).toBe('x');
    expect(result.nodes.find(node => node.id === 'c')!.seed).toBe('a');
  });

  it('دوجهته است — هم بالا می‌رود هم پایین', () => {
    const result = explorerFor(edges).explore(['b'], { maxDepth: 1 });
    expect(result.nodes.map(node => node.id).sort()).toEqual(['a', 'c']);
  });

  it('یک‌جهته هم می‌شود', () => {
    const out = explorerFor(edges).explore(['b'], { maxDepth: 1, direction: 'out' });
    expect(out.nodes.map(node => node.id)).toEqual(['c']);

    const into = explorerFor(edges).explore(['b'], { maxDepth: 1, direction: 'in' });
    expect(into.nodes.map(node => node.id)).toEqual(['a']);
  });

  it('دانه‌ها خودشان در نتیجه نیستند — فراخوان آن‌ها را دارد', () => {
    const result = explorerFor(edges).explore(['a'], { maxDepth: 2 });
    expect(result.nodes.map(node => node.id)).not.toContain('a');
    expect(result.seeds).toEqual(['a']);
  });

  it('دانهٔ ناموجود، سکوت نمی‌شود', () => {
    const result = explorerFor(edges).explore(['a', 'ghost'], { maxDepth: 1 });
    expect(result.seeds).toEqual(['a']);
    expect(result.missingSeeds).toEqual(['ghost']);
  });

  it('دانهٔ تکراری، دوبار حساب نمی‌شود', () => {
    const result = explorerFor(edges).explore(['a', 'a'], { maxDepth: 1 });
    expect(result.seeds).toEqual(['a']);
  });
});

describe('GAP-02 — پذیرش: وقتی سقف می‌خورد، نزدیک‌تر و مطمئن‌تر می‌ماند', () => {
  /*
  | دانه `s` سه همسایهٔ عمق‌یک دارد که فقط در اعتماد فرق می‌کنند،
  | و یک زنجیرهٔ عمیق که به گره‌های دورتر می‌رسد:
  |
  |   s ─(95)─▶ strong
  |   s ─(75)─▶ medium
  |   s ─(40)─▶ weak            ← زیر آستانه، پیش‌فرض اصلاً نمی‌آید
  |   s ─(95)─▶ hop1 ─(95)─▶ hop2 ─(95)─▶ hop3
  */
  const edges = [
    dep('s', 'strong', 95),
    dep('s', 'medium', 75),
    dep('s', 'weak', 40),
    dep('s', 'hop1', 95),
    dep('hop1', 'hop2', 95),
    dep('hop2', 'hop3', 95),
  ];

  it('با سقف یک گره، مطمئن‌ترینِ نزدیک‌ترین می‌ماند', () => {
    const result = explorerFor(edges).explore(['s'], { maxNodes: 1, maxDepth: 3 });
    expect(result.nodes.map(node => node.id)).toEqual(['strong']);
    expect(result.truncated).toBe(true);
    expect(result.droppedCount).toBeGreaterThan(0);
  });

  it('نزدیک‌تر بر دورتر مقدم است، حتی وقتی هر دو قطعی‌اند', () => {
    const result = explorerFor(edges).explore(['s'], { maxNodes: 2, maxDepth: 3 });
    const ids = result.nodes.map(node => node.id);

    expect(ids).toContain('strong');
    expect(ids).toContain('hop1');
    expect(ids).not.toContain('hop2');
  });

  it('مطمئن‌تر بر کم‌اعتمادتر مقدم است، در همان عمق', () => {
    const result = explorerFor(edges).explore(['s'], {
      maxNodes: 2,
      maxDepth: 1,
      minConfidence: 0,
    });
    const ids = result.nodes.map(node => node.id);

    expect(ids).not.toContain('weak');
    expect(ids.length).toBe(2);
  });

  it('نتیجه به‌ترتیب امتیاز است', () => {
    const result = explorerFor(edges).explore(['s'], { maxDepth: 3, minConfidence: 0 });
    const scores = result.nodes.map(node => node.score);
    expect(scores).toEqual([...scores].sort((left, right) => right - left));
  });

  it('امتیاز با فاصله کم می‌شود و با اعتماد ضعیف، کمتر', () => {
    const result = explorerFor(edges).explore(['s'], { maxDepth: 3, minConfidence: 0 });
    const byId = new Map(result.nodes.map(node => [node.id, node]));

    expect(byId.get('strong')!.score).toBeGreaterThan(byId.get('medium')!.score);
    expect(byId.get('medium')!.score).toBeGreaterThan(byId.get('weak')!.score);
    expect(byId.get('hop1')!.score).toBeGreaterThan(byId.get('hop2')!.score);
  });

  it('یال ضعیف پیش‌فرض اصلاً پیموده نمی‌شود', () => {
    const result = explorerFor(edges).explore(['s'], { maxDepth: 3 });
    expect(result.nodes.map(node => node.id)).not.toContain('weak');
  });

  it('اعتماد مسیر، ضعیف‌ترین حلقهٔ آن است', () => {
    const chain = [dep('p', 'q', 95), dep('q', 'r', 72)];
    const result = explorerFor(chain).explore(['p'], { maxDepth: 2 });
    expect(result.nodes.find(node => node.id === 'r')!.pathConfidence).toBe(72);
  });
});

describe('GAP-02 — ناوردا: نگه‌داشته‌ها همان برترین‌هایند', () => {
  /*
  | قوی‌ترین شکلِ معیار پذیرش، و چیزی که فقط با جست‌وجوی
  | بهترین-اول درست است: مجموعهٔ N گرهٔ نگه‌داشته‌شده باید **دقیقاً**
  | N گرهٔ برترِ یک کاوش بی‌سقف باشد. با BFS ساده این برقرار نیست —
  | آنجا هرچه زودتر دیده شد می‌ماند.
  |
  | روی گراف واقعی این مخزن هم سنجیده شد: از ۵۵۲ گرهٔ در دسترس،
  | ۵۰ گرهٔ نگه‌داشته‌شده با ۵۰ گرهٔ برترِ اجرای بی‌سقف یکی بود.
  */
  const edges = [
    dep('root', 'n1', 95),
    dep('root', 'n2', 90),
    dep('root', 'n3', 85),
    dep('n1', 'n4', 95),
    dep('n2', 'n5', 80),
    dep('n3', 'n6', 75),
    dep('n4', 'n7', 95),
    dep('n5', 'n8', 90),
  ];

  it.each([1, 2, 3, 5, 7])('با سقف %i، همان برترین‌ها می‌مانند', size => {
    const explorer = explorerFor(edges);
    const capped = explorer.explore(['root'], { maxNodes: size, maxDepth: 4 });
    const unlimited = explorer.explore(['root'], { maxNodes: 1000, maxDepth: 4 });

    const expected = unlimited.nodes.slice(0, size).map(node => node.id).sort();
    expect(capped.nodes.map(node => node.id).sort()).toEqual(expected);
  });

  it('کاوش بی‌سقف، truncated نمی‌شود', () => {
    const result = explorerFor(edges).explore(['root'], { maxNodes: 1000, maxDepth: 4 });
    expect(result.truncated).toBe(false);
    expect(result.nodes).toHaveLength(8);
  });
});

describe('GAP-02 — وزن دانه', () => {
  const edges = [dep('a', 'a1'), dep('b', 'b1')];

  it('دانهٔ مهم‌تر، همسایه‌هایش زودتر می‌آیند', () => {
    const result = explorerFor(edges).explore(['a', 'b'], {
      maxNodes: 1,
      maxDepth: 1,
      seedWeights: { b: 5 },
    });
    expect(result.nodes.map(node => node.id)).toEqual(['b1']);
  });

  it('بدون وزن، هر دو دانه برابرند', () => {
    const result = explorerFor(edges).explore(['a', 'b'], { maxDepth: 1 });
    expect(result.nodes.map(node => node.id).sort()).toEqual(['a1', 'b1']);
  });
});

describe('GAP-02 — بودجه و حلقه', () => {
  it('حلقه، کاوش را معلق نمی‌کند', () => {
    const cycle = [dep('m', 'n'), dep('n', 'o'), dep('o', 'm')];
    const result = explorerFor(cycle).explore(['m'], { maxDepth: 5 });
    expect(result.nodes.map(node => node.id).sort()).toEqual(['n', 'o']);
  });

  it('سقف عمق رعایت می‌شود', () => {
    const chain = [dep('c0', 'c1'), dep('c1', 'c2'), dep('c2', 'c3')];
    const result = explorerFor(chain).explore(['c0'], { maxDepth: 2 });
    expect(result.nodes.map(node => node.id).sort()).toEqual(['c1', 'c2']);
  });

  it('سقف بازدید، کاوش را روی گراف بزرگ می‌بندد', () => {
    const wide = Array.from({ length: 200 }, (_, index) => dep('hub', `leaf${index}`));
    const result = explorerFor(wide).explore(['hub'], { maxDepth: 1, maxVisited: 5, maxNodes: 500 });
    expect(result.truncated).toBe(true);
    expect(result.visitedCount).toBeLessThanOrEqual(6);
  });

  it('بدون رسیدن به سقف، truncated دروغ نمی‌گوید', () => {
    const result = explorerFor([dep('a', 'b')]).explore(['a'], { maxDepth: 2, maxNodes: 50 });
    expect(result.truncated).toBe(false);
    expect(result.droppedCount).toBe(0);
  });

  it('گرافی که هیچ همسایه‌ای ندارد، نتیجهٔ خالی — نه خطا', () => {
    const result = explorerFor([dep('a', 'b')]).explore(['b'], { maxDepth: 2, direction: 'out' });
    expect(result.nodes).toEqual([]);
    expect(result.truncated).toBe(false);
  });
});

describe('GAP-02 — یال‌های زیرگراف', () => {
  it('فقط یال‌هایی که هر دو سرشان داخل‌اند', () => {
    const edges = [dep('a', 'b'), dep('b', 'c'), dep('c', 'd')];
    const result = explorerFor(edges).explore(['a'], { maxDepth: 1, direction: 'out' });

    expect(result.nodes.map(node => node.id)).toEqual(['b']);
    expect(result.edges.map(edge => `${edge.from}->${edge.to}`)).toEqual(['a->b']);
  });

  it('یال تکراری یک بار می‌آید', () => {
    const edges = [dep('a', 'b'), dep('a', 'b')];
    const result = explorerFor(edges).explore(['a'], { maxDepth: 1 });
    expect(result.edges).toHaveLength(1);
  });
});
