/**
 * GAP-06 / SE-VEC-03 — رتبه‌بند context.
 *
 * سه ادعایی که این آزمون‌ها تثبیت می‌کنند و پیش از فاز ۴۲ هیچ‌کدام
 * برقرار نبودند:
 *
 *   ۱. هیچ سیگنالی نمی‌تواند بیش از سهم وزنی‌اش در امتیاز اثر بگذارد.
 *      امتیاز کلیدواژه در `SemanticSearchTool` کران بالا نداشت، پس
 *      عملاً همیشه غالب بود (اندازه‌گیری: بیشینهٔ کلیدواژه ۳٫۵ در
 *      برابر بیشینهٔ جمعِ بقیه ۰٫۴۰).
 *
 *   ۲. «نبودِ سیگنال» با «سیگنالِ صفر» یکی نیست. `referenceCount`
 *      روی ایندکس واقعی برای ۹۵٪ نمادها `null` است؛ اگر صفر حساب
 *      شود، رتبه‌بند نمادهایی را جریمه می‌کند که فقط اندازه‌گیری
 *      نشده‌اند.
 *
 *   ۳. فاصلهٔ گرافی یک سیگنال است، نه فیلتر.
 */

import {
  ContextRanker,
  DEFAULT_SIGNAL_WEIGHTS,
  RankCandidate,
  SignalName,
} from './ContextRanker';

function candidate(id: string, signals: RankCandidate['signals']): RankCandidate {
  return { id, signals };
}

describe('ContextRanker — نرمال‌سازی', () => {
  it('امتیاز را در بازهٔ ۰ تا ۱ نگه می‌دارد، هرچقدر هم سیگنال خام بزرگ باشد', () => {
    const ranked = new ContextRanker().rank([
      candidate('huge', { keyword: 1_000_000, importance: 100, exported: true }),
      candidate('small', { keyword: 1, importance: 0, exported: false }),
    ]);

    for (const r of ranked) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it('هیچ سیگنالی بیش از سهم وزنی‌اش در امتیاز نهایی سهم ندارد', () => {
    // این دقیقاً همان چیزی است که SE-VEC-03 توصیفش می‌کند: کلیدواژهٔ
    // بی‌کران در برابر شباهت کسینوسی کران‌دار.
    const ranked = new ContextRanker().rank([
      candidate('kw', { keyword: 500, vector: 0 }),
      candidate('vec', { keyword: 1, vector: 1 }),
    ]);

    for (const r of ranked) {
      const totalWeight = r.contributions.reduce((sum, c) => sum + c.weight, 0);
      for (const c of r.contributions) {
        expect(c.contribution).toBeLessThanOrEqual(c.weight / totalWeight + 1e-9);
      }
    }
  });

  it('نامزدی با شباهت برداری کامل، به‌خاطر کلیدواژهٔ بزرگِ رقیب حذف نمی‌شود', () => {
    const ranked = new ContextRanker().rank([
      candidate('kw', { keyword: 500, vector: 0 }),
      candidate('vec', { keyword: 1, vector: 1 }),
    ]);

    const vec = ranked.find(r => r.id === 'vec')!;
    const kw = ranked.find(r => r.id === 'kw')!;

    // با فرمول قدیمی: kw = 500*0.5 = 250 و vec = 1*0.5 + 1*0.5 = 1.
    // یعنی نسبت ۲۵۰ به ۱. نرمال‌سازی این نسبت را به کران وزن‌ها می‌بندد.
    expect(kw.score / vec.score).toBeLessThan(3);
    expect(vec.score).toBeGreaterThan(0.3);
  });

  it('کلیدواژه را نسبت به بیشینهٔ همان دسته نرمال می‌کند، نه یک ثابت دلبخواه', () => {
    const weak = new ContextRanker().rank([
      candidate('a', { keyword: 2 }),
      candidate('b', { keyword: 1 }),
    ]);
    const strong = new ContextRanker().rank([
      candidate('a', { keyword: 200 }),
      candidate('b', { keyword: 100 }),
    ]);

    // شکل نسبی یکسان است چون فقط نسبت اهمیت دارد.
    expect(weak[0].score).toBeCloseTo(strong[0].score, 6);
    expect(weak[1].score).toBeCloseTo(strong[1].score, 6);
  });

  it('وقتی بیشینهٔ کلیدواژه صفر است، کلیدواژه را سیگنالِ غایب می‌شمارد', () => {
    const [only] = new ContextRanker().rank([candidate('a', { keyword: 0, importance: 80 })]);

    expect(only.missing).toContain('keyword');
    expect(only.contributions.map(c => c.signal)).not.toContain('keyword');
  });
});

describe('ContextRanker — نبودِ سیگنال با صفر یکی نیست', () => {
  it('نمادی با referenceCount نامعلوم، از نمادی با صفر ارجاع بالاتر می‌ایستد', () => {
    const ranked = new ContextRanker().rank([
      candidate('unknown', { keyword: 10, referenceCount: null }),
      candidate('zero', { keyword: 10, referenceCount: 0 }),
    ]);

    const unknown = ranked.find(r => r.id === 'unknown')!;
    const zero = ranked.find(r => r.id === 'zero')!;

    expect(unknown.score).toBeGreaterThan(zero.score);
    expect(unknown.missing).toContain('centrality');
    expect(zero.missing).not.toContain('centrality');
  });

  it('وزن سیگنال‌های غایب بازتوزیع می‌شود، پس نامزدِ تک‌سیگنالی جریمه نمی‌شود', () => {
    const [only] = new ContextRanker().rank([candidate('a', { keyword: 5 })]);

    // تنها سیگنالِ حاضر، بیشینهٔ خودش است ⇒ امتیاز کامل.
    expect(only.score).toBeCloseTo(1, 6);
    expect(only.contributions).toHaveLength(1);
  });

  it('نامزدِ بدون هیچ سیگنالی امتیاز صفر می‌گیرد، نه NaN', () => {
    const [empty] = new ContextRanker().rank([candidate('a', {})]);

    expect(empty.score).toBe(0);
    expect(Number.isNaN(empty.score)).toBe(false);
    expect(empty.contributions).toHaveLength(0);
  });
});

describe('ContextRanker — فاصلهٔ گرافی', () => {
  it('یک هاپ بر سه هاپ ترجیح دارد', () => {
    const ranked = new ContextRanker().rank([
      candidate('near', { graphHops: 1 }),
      candidate('far', { graphHops: 3 }),
    ]);

    expect(ranked[0].id).toBe('near');
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it('هاپ صفر (خودِ هدف) نرمال‌شدهٔ یک می‌گیرد', () => {
    const [self] = new ContextRanker().rank([candidate('self', { graphHops: 0 })]);

    expect(self.contributions[0].signal).toBe('graphDistance');
    expect(self.contributions[0].normalized).toBeCloseTo(1, 6);
  });

  it('گره دست‌نیافتنی (hops = null) سیگنال فاصله ندارد و صفر نمی‌گیرد', () => {
    const [unreachable] = new ContextRanker().rank([
      candidate('u', { graphHops: null, importance: 100 }),
    ]);

    expect(unreachable.missing).toContain('graphDistance');
    expect(unreachable.score).toBeCloseTo(1, 6);
  });
});

describe('ContextRanker — سیگنال‌هایی که موتور حساب می‌کرد و دور می‌ریخت', () => {
  const all: SignalName[] = [
    'keyword',
    'vector',
    'graphDistance',
    'centrality',
    'importance',
    'hotness',
    'readPriority',
    'hotspot',
    'churn',
    'complexity',
    'tested',
    'exported',
  ];

  it('برای هر دوازده سیگنال وزن پیش‌فرض مثبت دارد', () => {
    for (const signal of all) {
      expect(DEFAULT_SIGNAL_WEIGHTS[signal]).toBeGreaterThan(0);
    }
    expect(Object.keys(DEFAULT_SIGNAL_WEIGHTS).sort()).toEqual([...all].sort());
  });

  it('aiScore.importance روی رتبه اثر می‌گذارد', () => {
    const ranked = new ContextRanker().rank([
      candidate('high', { importance: 100 }),
      candidate('low', { importance: 10 }),
    ]);
    expect(ranked[0].id).toBe('high');
  });

  it('churnRank یک، بر churnRank ده مقدم است', () => {
    const ranked = new ContextRanker().rank([
      candidate('hot', { churnRank: 1 }),
      candidate('cold', { churnRank: 10 }),
    ]);
    expect(ranked[0].id).toBe('hot');
    expect(ranked[0].contributions[0].normalized).toBeGreaterThan(
      ranked[1].contributions[0].normalized
    );
  });

  it('churnRank را نسبت به churnRankOutOf نرمال می‌کند اگر داده شود', () => {
    const narrow = new ContextRanker().rank([candidate('a', { churnRank: 5 })], {
      churnRankOutOf: 10,
    });
    const wide = new ContextRanker().rank([candidate('a', { churnRank: 5 })], {
      churnRankOutOf: 1000,
    });

    expect(wide[0].score).toBeGreaterThan(narrow[0].score);
  });

  it('داشتن تست یک سیگنال مثبت است', () => {
    const ranked = new ContextRanker().rank([
      candidate('tested', { testCount: 4 }),
      candidate('untested', { testCount: 0 }),
    ]);
    expect(ranked[0].id).toBe('tested');
  });

  it('hotspotScore و readPriority و hotness هر سه در contributions ظاهر می‌شوند', () => {
    const [r] = new ContextRanker().rank([
      candidate('a', { hotspotScore: 50, readPriority: 50, hotness: 50 }),
    ]);
    const names = r.contributions.map(c => c.signal).sort();
    expect(names).toEqual(['hotness', 'hotspot', 'readPriority']);
  });
});

describe('ContextRanker — قابل توضیح و قابل تنظیم', () => {
  it('جمع سهم‌ها دقیقاً برابر امتیاز است', () => {
    const [r] = new ContextRanker().rank([
      candidate('a', {
        keyword: 3,
        vector: 0.7,
        graphHops: 2,
        referenceCount: 12,
        importance: 64,
        exported: true,
      }),
    ]);

    const sum = r.contributions.reduce((s, c) => s + c.contribution, 0);
    expect(sum).toBeCloseTo(r.score, 9);
  });

  it('وزن‌های داده‌شده جای پیش‌فرض را می‌گیرند', () => {
    const onlyVector = new ContextRanker({
      weights: { keyword: 0, vector: 1 },
    }).rank([
      candidate('kw', { keyword: 100, vector: 0 }),
      candidate('vec', { keyword: 0.0001, vector: 1 }),
    ]);

    expect(onlyVector[0].id).toBe('vec');
  });

  it('سیگنالی با وزن صفر اصلاً در سهم‌ها نمی‌آید', () => {
    const [r] = new ContextRanker({ weights: { exported: 0 } }).rank([
      candidate('a', { exported: true, importance: 50 }),
    ]);
    expect(r.contributions.map(c => c.signal)).not.toContain('exported');
  });

  it('ترتیب پایدار است: امتیاز برابر ⇒ ترتیب بر اساس id', () => {
    const ranked = new ContextRanker().rank([
      candidate('zeta', { importance: 50 }),
      candidate('alpha', { importance: 50 }),
      candidate('mid', { importance: 50 }),
    ]);
    expect(ranked.map(r => r.id)).toEqual(['alpha', 'mid', 'zeta']);
  });

  it('payload را دست‌نخورده برمی‌گرداند', () => {
    const payload = { path: 'a/b.ts' };
    const ranked = new ContextRanker().rank<{ path: string }>([
      { id: 'a', signals: { importance: 1 }, payload },
    ]);
    expect(ranked[0].payload).toBe(payload);
  });

  it('فهرست خالی، خروجی خالی می‌دهد', () => {
    expect(new ContextRanker().rank([])).toEqual([]);
  });

  it('ورودی را تغییر نمی‌دهد', () => {
    const input = [candidate('a', { keyword: 2 }), candidate('b', { keyword: 1 })];
    const snapshot = JSON.stringify(input);
    new ContextRanker().rank(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
