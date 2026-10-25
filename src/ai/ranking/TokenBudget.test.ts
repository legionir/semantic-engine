/**
 * GAP-07 — بودجهٔ توکنِ آگاه از ساختار.
 *
 * روش قبلی `AssembleContextTool.trimToTokens` بود:
 *
 *   const approxChars = maxTokens * 4;
 *   if (text.length <= approxChars) return text;
 *   return text.substring(0, approxChars) + '\n\n[Context truncated]';
 *
 * سه ایراد که این آزمون‌ها روی هر سه قفل می‌گذارند:
 *
 *   ۱. از **انتها** می‌بُرد. اندازه‌گیری روی ایندکس واقعی: با بودجهٔ
 *      ۴۰۰ توکن، بخش «تست‌های مرتبط» کامل ناپدید می‌شد — صرف‌نظر از
 *      اینکه چقدر مرتبط بود.
 *   ۲. وسط یک آیتم می‌بُرد و یک سطر ناقص تحویل می‌داد.
 *   ۳. از بودجه **رد می‌شد**: چهارصد توکن درخواستی، ۴۰۶ توکن خروجی،
 *      چون طولِ خودِ نشانگرِ بریدگی حساب نشده بود (SE-AI-16).
 */

import {
  TokenBudget,
  BudgetSection,
  estimateTokens,
} from './TokenBudget';

function item(id: string, text: string, score: number) {
  return { id, text, score };
}

/** یک ساختار سه‌بخشی که بخش آخرش، مثل «تست‌ها»، ارزشمند اما آخر صف است. */
function sections(): BudgetSection[] {
  return [
    {
      name: 'targets',
      header: '=== Target Files ===',
      guarantee: 0.2,
      items: [item('t1', '- src/a.ts (typescript, 100 lines)', 0.9)],
    },
    {
      name: 'related',
      header: '=== Related Files ===',
      items: Array.from({ length: 40 }, (_, i) =>
        item(`r${i}`, `- src/related-${i}.ts (typescript, 50 lines): a related module`, 0.5 - i * 0.001)
      ),
    },
    {
      name: 'tests',
      header: '=== Related Tests ===',
      guarantee: 0.2,
      items: [
        item('x1', '- src/a.test.ts (typescript, 200 lines): covers the target', 0.85),
        item('x2', '- src/b.test.ts (typescript, 90 lines): partially covers', 0.4),
      ],
    },
  ];
}

describe('TokenBudget — سقف بودجه', () => {
  it('هرگز از بودجه رد نمی‌شود', () => {
    for (const budget of [0, 5, 20, 50, 100, 400, 4000]) {
      const result = new TokenBudget().assemble(sections(), { maxTokens: budget });
      expect(estimateTokens(result.text)).toBeLessThanOrEqual(budget);
      expect(result.usedTokens).toBeLessThanOrEqual(budget);
    }
  });

  it('نشانگر بریدگی را داخل بودجه حساب می‌کند، نه بعد از آن — SE-AI-16', () => {
    const result = new TokenBudget().assemble(sections(), { maxTokens: 60 });

    expect(result.truncated).toBe(true);
    expect(result.text).toContain('[context truncated]');
    expect(estimateTokens(result.text)).toBeLessThanOrEqual(60);
  });

  it('وقتی نشانگر جا نمی‌شود، حذف می‌شود — نه اینکه از بودجه بزند بیرون', () => {
    /*
    | این حالت را با جست‌وجو پیدا کردیم، نه با حدس: نخستین نسخهٔ
    | آزمونِ بالا با «افزودن بی‌قید نشانگر» هم سبز می‌ماند، چون در آن
    | ابعاد، نشانگر همیشه جا می‌شد. آزمونی که با برگرداندنِ رفع، قرمز
    | نشود، چیزی اثبات نمی‌کند.
    |
    | ابعادِ لازم: بودجهٔ ۷ توکن، دو آیتمِ ۱۰ کاراکتری. یکی جا می‌شود،
    | دیگری می‌افتد، و نشانگرِ ۵ توکنی جا ندارد.
    */
    const tight: BudgetSection[] = [
      {
        name: 's',
        header: '=== S ===',
        items: [
          item('a', '-00000000', 1),
          item('b', '-11111111', 0.5),
        ],
      },
    ];
    const result = new TokenBudget().assemble(tight, { maxTokens: 7 });

    expect(result.truncated).toBe(true);
    expect(result.sections[0].dropped).toBe(1);
    expect(result.text).not.toContain('[context truncated]');
    expect(estimateTokens(result.text)).toBeLessThanOrEqual(7);
  });

  it('usedTokens با اندازهٔ واقعی متن می‌خواند', () => {
    const result = new TokenBudget().assemble(sections(), { maxTokens: 4000 });
    expect(result.usedTokens).toBe(estimateTokens(result.text));
  });

  it('بودجهٔ صفر، متن خالی می‌دهد و همه چیز را افتاده گزارش می‌کند', () => {
    const result = new TokenBudget().assemble(sections(), { maxTokens: 0 });

    expect(result.text).toBe('');
    expect(result.usedTokens).toBe(0);
    const kept = result.sections.reduce((s, x) => s + x.kept, 0);
    expect(kept).toBe(0);
  });
});

describe('TokenBudget — سهم تضمین‌شدهٔ هر بخش', () => {
  it('معیار پذیرش فاز ۴۲: با بودجهٔ کم، بخش تست‌ها حذف نمی‌شود', () => {
    const result = new TokenBudget().assemble(sections(), { maxTokens: 120 });

    expect(result.text).toContain('=== Related Tests ===');
    expect(result.text).toContain('src/a.test.ts');
  });

  it('برشِ ساده از انتها همان بودجه را می‌گیرد و تست‌ها را می‌اندازد', () => {
    // ثبت رفتار قدیمی، تا «بهتر شد» یک عدد داشته باشد.
    const all = sections()
      .flatMap(s => [s.header!, ...s.items.map(i => i.text)])
      .join('\n');
    const naive = all.slice(0, 120 * 4);

    expect(naive).not.toContain('=== Related Tests ===');

    const result = new TokenBudget().assemble(sections(), { maxTokens: 120 });
    expect(result.text).toContain('=== Related Tests ===');
  });

  it('بخشِ تضمین‌دار دست‌کم پرامتیازترین آیتمش را می‌گیرد', () => {
    const result = new TokenBudget().assemble(sections(), { maxTokens: 80 });
    const tests = result.sections.find(s => s.name === 'tests')!;

    expect(tests.kept).toBeGreaterThanOrEqual(1);
    expect(result.text).toContain('src/a.test.ts'); // امتیاز ۰٫۸۵
    expect(result.text).not.toContain('src/b.test.ts'); // امتیاز ۰٫۴
  });

  it('تضمین یک سقف نیست: باقی‌ماندهٔ بودجه به همان بخش هم می‌رسد', () => {
    const result = new TokenBudget().assemble(sections(), { maxTokens: 4000 });
    const tests = result.sections.find(s => s.name === 'tests')!;

    expect(tests.kept).toBe(2);
  });

  it('بخش بدون تضمین، وقتی بودجه تنگ است، جای بخشِ تضمین‌دار را نمی‌گیرد', () => {
    const result = new TokenBudget().assemble(sections(), { maxTokens: 120 });
    const related = result.sections.find(s => s.name === 'related')!;
    const tests = result.sections.find(s => s.name === 'tests')!;

    expect(related.dropped).toBeGreaterThan(0);
    expect(tests.kept).toBeGreaterThanOrEqual(1);
  });

  it('اگر مجموع تضمین‌ها از یک بگذرد، به نسبت کوچک می‌شوند', () => {
    const greedy: BudgetSection[] = [
      { name: 'a', header: '=== A ===', guarantee: 0.8, items: [item('a1', 'x'.repeat(400), 1)] },
      { name: 'b', header: '=== B ===', guarantee: 0.8, items: [item('b1', 'y'.repeat(400), 1)] },
    ];
    const result = new TokenBudget().assemble(greedy, { maxTokens: 250 });

    expect(estimateTokens(result.text)).toBeLessThanOrEqual(250);
    expect(result.sections.find(s => s.name === 'a')!.kept).toBe(1);
    expect(result.sections.find(s => s.name === 'b')!.kept).toBe(1);
  });
});

describe('TokenBudget — انتخاب بر اساس امتیاز', () => {
  it('در هر بخش، آیتم پرامتیازتر زودتر انتخاب می‌شود', () => {
    const one: BudgetSection[] = [
      {
        name: 'x',
        header: '=== X ===',
        items: [item('lo', 'L'.repeat(80), 0.1), item('hi', 'H'.repeat(80), 0.9)],
      },
    ];
    const result = new TokenBudget().assemble(one, { maxTokens: 30 });

    expect(result.text).toContain('H'.repeat(80));
    expect(result.text).not.toContain('L'.repeat(80));
  });

  it('باقی‌ماندهٔ بودجه به‌صورت سراسری و بر اساس امتیاز پخش می‌شود', () => {
    const two: BudgetSection[] = [
      { name: 'a', header: '=== A ===', items: [item('a1', 'A'.repeat(200), 0.2)] },
      { name: 'b', header: '=== B ===', items: [item('b1', 'B'.repeat(200), 0.9)] },
    ];
    const result = new TokenBudget().assemble(two, { maxTokens: 70 });

    expect(result.text).toContain('B'.repeat(200));
    expect(result.text).not.toContain('A'.repeat(200));
  });

  it('آیتم بزرگِ جانشدنی جلوی آیتم‌های کوچک‌ترِ بعدی را نمی‌گیرد', () => {
    const one: BudgetSection[] = [
      {
        name: 'x',
        header: '=== X ===',
        items: [item('big', 'B'.repeat(4000), 0.99), item('small', 'small-item', 0.98)],
      },
    ];
    const result = new TokenBudget().assemble(one, { maxTokens: 60 });

    expect(result.text).not.toContain('B'.repeat(4000));
    expect(result.text).toContain('small-item');
  });
});

describe('TokenBudget — تمامیت آیتم‌ها و ساختار', () => {
  it('هیچ آیتمی وسطش بریده نمی‌شود', () => {
    const result = new TokenBudget().assemble(sections(), { maxTokens: 150 });
    const bodyLines = result.text
      .split('\n')
      .filter(l => l.startsWith('- '));

    const allItems = sections().flatMap(s => s.items.map(i => i.text));
    for (const line of bodyLines) {
      expect(allItems).toContain(line);
    }
  });

  it('بخشی که هیچ آیتمی نگه نداشته، سرصفحه هم نمی‌گیرد', () => {
    const result = new TokenBudget().assemble(sections(), { maxTokens: 80 });
    const related = result.sections.find(s => s.name === 'related')!;

    if (related.kept === 0) {
      expect(result.text).not.toContain('=== Related Files ===');
    }
  });

  it('بخش خالی از ابتدا، هیچ سرصفحه‌ای تولید نمی‌کند', () => {
    const withEmpty: BudgetSection[] = [
      { name: 'empty', header: '=== Empty ===', items: [] },
      { name: 'full', header: '=== Full ===', items: [item('f', 'content', 1)] },
    ];
    const result = new TokenBudget().assemble(withEmpty, { maxTokens: 4000 });

    expect(result.text).not.toContain('=== Empty ===');
    expect(result.text).toContain('=== Full ===');
  });

  it('ترتیب بخش‌ها همان ترتیب اعلام‌شده می‌ماند', () => {
    const result = new TokenBudget().assemble(sections(), { maxTokens: 4000 });
    const headers = result.text.split('\n').filter(l => l.startsWith('==='));

    expect(headers).toEqual([
      '=== Target Files ===',
      '=== Related Files ===',
      '=== Related Tests ===',
    ]);
  });

  it('preamble پیش از بخش‌ها می‌آید و در بودجه حساب می‌شود', () => {
    const result = new TokenBudget().assemble(sections(), {
      maxTokens: 4000,
      preamble: 'Task: fix the client',
    });

    expect(result.text.startsWith('Task: fix the client')).toBe(true);
    expect(result.usedTokens).toBe(estimateTokens(result.text));
  });

  it('اگر preamble از کل بودجه بزرگ‌تر باشد، خروجی خالی است نه سرریز', () => {
    const result = new TokenBudget().assemble(sections(), {
      maxTokens: 3,
      preamble: 'x'.repeat(400),
    });

    expect(estimateTokens(result.text)).toBeLessThanOrEqual(3);
  });
});

describe('TokenBudget — گزارش', () => {
  it('برای هر بخش، تعداد نگه‌داشته و افتاده را گزارش می‌کند', () => {
    const result = new TokenBudget().assemble(sections(), { maxTokens: 120 });

    for (const s of result.sections) {
      const declared = sections().find(x => x.name === s.name)!.items.length;
      expect(s.kept + s.dropped).toBe(declared);
    }
  });

  it('keptIds دقیقاً همان چیزی است که در متن آمده', () => {
    const result = new TokenBudget().assemble(sections(), { maxTokens: 120 });
    const declared = sections();

    for (const report of result.sections) {
      expect(report.keptIds).toHaveLength(report.kept);
      const items = declared.find(s => s.name === report.name)!.items;
      for (const id of report.keptIds) {
        const item = items.find(i => i.id === id)!;
        expect(result.text).toContain(item.text);
      }
      const droppedIds = items
        .map(i => i.id)
        .filter(id => !report.keptIds.includes(id));
      for (const id of droppedIds) {
        const item = items.find(i => i.id === id)!;
        expect(result.text).not.toContain(item.text);
      }
    }
  });

  it('truncated فقط وقتی true است که واقعاً چیزی افتاده باشد', () => {
    const full = new TokenBudget().assemble(sections(), { maxTokens: 4000 });
    expect(full.truncated).toBe(false);

    const tight = new TokenBudget().assemble(sections(), { maxTokens: 120 });
    expect(tight.truncated).toBe(true);
  });

  it('نتیجه دترمینیستیک است', () => {
    const a = new TokenBudget().assemble(sections(), { maxTokens: 137 });
    const b = new TokenBudget().assemble(sections(), { maxTokens: 137 });
    expect(a.text).toBe(b.text);
  });
});

/*
| SE-AI-18 — انتخابِ حریصانه یکنوا نیست.
|
| با «ردشدن از آیتم جانشدنی»، بزرگ‌تر شدن بودجه می‌تواند باعث *افتادن*
| یک آیتم شود: بودجهٔ بزرگ‌تر به یک آیتمِ پرامتیازِ حجیم اجازهٔ ورود
| می‌دهد و همان آیتم، جای چند آیتم کوچکِ کم‌امتیاز را می‌گیرد. این
| ذاتِ هر حل حریصانهٔ کوله‌پشتی است و «رفع» نمی‌شود مگر با حل بهینهٔ
| کوله‌پشتی، که برای این کاربرد نه لازم است نه ارزان.
|
| اندازه‌گیری روی ایندکس واقعی: با بودجهٔ ۲۰۰ توکن بخش «تغییرات اخیر»
| یک سطر داشت و با بودجهٔ ۴۰۰ توکن صفر سطر.
|
| کاری که *می‌شود* کرد و شده: بخش‌های تضمین‌دار یکنوا هستند، چون کفِ
| سهمشان با بودجه بزرگ می‌شود و پیش از استخر سراسری برداشته می‌شوند.
| پس هر بخشی که نباید ناپدید شود، تضمین می‌گیرد.
*/
describe('TokenBudget — یکنوایی (SE-AI-18)', () => {
  const guaranteed: BudgetSection[] = [
    {
      name: 'bulky',
      header: '=== Bulky ===',
      items: Array.from({ length: 20 }, (_, i) =>
        item(`b${i}`, `- bulky-${i} `.padEnd(120, 'x'), 0.9 - i * 0.01)
      ),
    },
    {
      name: 'tiny',
      header: '=== Tiny ===',
      guarantee: 0.1,
      items: [item('t1', '- tiny', 0.01)],
    },
  ];

  it('بخش تضمین‌دار با بزرگ‌شدن بودجه ناپدید نمی‌شود', () => {
    for (let budget = 40; budget <= 900; budget += 20) {
      const result = new TokenBudget().assemble(guaranteed, { maxTokens: budget });
      const tiny = result.sections.find(s => s.name === 'tiny')!;
      expect({ budget, kept: tiny.kept }).toEqual({ budget, kept: 1 });
    }
  });

  it('بخش بدون تضمین چنین ضمانتی ندارد و این عمدی است', () => {
    const unguaranteed = guaranteed.map(s =>
      s.name === 'tiny' ? { ...s, guarantee: undefined } : s
    );

    const kepts = new Set<number>();
    for (let budget = 40; budget <= 900; budget += 20) {
      const result = new TokenBudget().assemble(unguaranteed, { maxTokens: budget });
      kepts.add(result.sections.find(s => s.name === 'tiny')!.kept);
    }

    // اگر این روزی فقط {1} شود، یعنی الگوریتم عوض شده و توضیح بالای
    // این describe دیگر درست نیست.
    expect(kepts).toEqual(new Set([0, 1]));
  });
});

describe('estimateTokens', () => {
  it('چهار کاراکتر را یک توکن می‌شمارد و به بالا گرد می‌کند', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abc')).toBe(1);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});
