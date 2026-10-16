/**
 * SE-AI-07 — `ToolResultCache` در واقع LRU نبود.
 *
 * کامنتِ خودِ کد می‌گفت «LRU eviction» ولی کاری که می‌کرد این بود:
 *
 * ```ts
 * const oldest = this.cache.keys().next().value;   // قدیمی‌ترین *درج*
 * if (oldest) this.cache.delete(oldest);
 * ```
 *
 * و `get` ترتیب را به‌روز نمی‌کرد. یعنی FIFO، نه LRU. اجرای واقعی با
 * `maxSize: 2`:
 *
 * ```
 * set a · set b · get a  (پس a تازه استفاده شده)  · set c
 *   a present: false     ← LRU می‌گوید باید بماند
 *   b present: true      ← LRU می‌گوید باید برود
 * ```
 *
 * دقیقاً برعکسِ چیزی که ادعا می‌شد: پرکاربردترین ورودی اول بیرون
 * انداخته می‌شد.
 *
 * دو ایراد دیگر:
 * - کلید `JSON.stringify(input)` بود، که به **ترتیب فیلدها** حساس
 *   است: `{a,b}` و `{b,a}` دو ورودیِ متفاوت حساب می‌شدند.
 * - رجیستری هیچ‌وقت `ttl`/`maxSize` را پاس نمی‌داد.
 */

import { ToolResultCache } from './ToolResultCache';
import { AiToolOutput } from './types';

const out = (tag: string): AiToolOutput => ({ success: true, items: [], context: tag });

describe('ToolResultCache — واقعاً LRU (SE-AI-07)', () => {
  it('ورودیِ تازه‌استفاده‌شده زنده می‌ماند، نه قدیمی‌ترین درج', () => {
    const cache = new ToolResultCache({ maxSize: 2 });

    cache.set('t', { q: 'a' }, 'h', out('a'));
    cache.set('t', { q: 'b' }, 'h', out('b'));
    cache.get('t', { q: 'a' }, 'h'); // a تازه استفاده شد
    cache.set('t', { q: 'c' }, 'h', out('c'));

    expect(cache.get('t', { q: 'a' }, 'h')).toBeDefined();
    expect(cache.get('t', { q: 'b' }, 'h')).toBeUndefined();
  });

  it('بدون استفادهٔ مجدد، قدیمی‌ترین می‌رود', () => {
    const cache = new ToolResultCache({ maxSize: 2 });

    cache.set('t', { q: 'a' }, 'h', out('a'));
    cache.set('t', { q: 'b' }, 'h', out('b'));
    cache.set('t', { q: 'c' }, 'h', out('c'));

    expect(cache.get('t', { q: 'a' }, 'h')).toBeUndefined();
    expect(cache.get('t', { q: 'b' }, 'h')).toBeDefined();
    expect(cache.get('t', { q: 'c' }, 'h')).toBeDefined();
  });

  it('نوشتنِ دوباره روی یک کلید هم آن را تازه می‌کند', () => {
    const cache = new ToolResultCache({ maxSize: 2 });

    cache.set('t', { q: 'a' }, 'h', out('a'));
    cache.set('t', { q: 'b' }, 'h', out('b'));
    cache.set('t', { q: 'a' }, 'h', out('a2'));
    cache.set('t', { q: 'c' }, 'h', out('c'));

    expect(cache.get('t', { q: 'a' }, 'h')?.context).toBe('a2');
    expect(cache.get('t', { q: 'b' }, 'h')).toBeUndefined();
  });

  it('از maxSize رد نمی‌شود', () => {
    const cache = new ToolResultCache({ maxSize: 3 });
    for (let i = 0; i < 20; i++) cache.set('t', { q: i }, 'h', out(String(i)));

    expect(cache.size()).toBe(3);
  });
});

describe('ToolResultCache — کلید پایدار (SE-AI-07)', () => {
  it('ترتیب فیلدها کلید را عوض نمی‌کند', () => {
    const cache = new ToolResultCache();
    cache.set('t', { a: 1, b: 2 }, 'h', out('x'));

    expect(cache.get('t', { b: 2, a: 1 }, 'h')?.context).toBe('x');
    expect(cache.size()).toBe(1);
  });

  it('ترتیب فیلدهای تودرتو هم اهمیت ندارد', () => {
    const cache = new ToolResultCache();
    cache.set('t', { f: { x: 1, y: 2 }, z: 3 }, 'h', out('x'));

    expect(cache.get('t', { z: 3, f: { y: 2, x: 1 } }, 'h')).toBeDefined();
  });

  it('ترتیب عناصر آرایه اهمیت دارد — آرایه مجموعه نیست', () => {
    const cache = new ToolResultCache();
    cache.set('t', { ids: ['a', 'b'] }, 'h', out('x'));

    expect(cache.get('t', { ids: ['b', 'a'] }, 'h')).toBeUndefined();
  });

  it('ورودی متفاوت، کلید متفاوت', () => {
    const cache = new ToolResultCache();
    cache.set('t', { q: 'a' }, 'h', out('a'));

    expect(cache.get('t', { q: 'b' }, 'h')).toBeUndefined();
  });

  it('ابزار متفاوت با همان ورودی، کلید متفاوت', () => {
    const cache = new ToolResultCache();
    cache.set('t1', { q: 'a' }, 'h', out('one'));

    expect(cache.get('t2', { q: 'a' }, 'h')).toBeUndefined();
  });

  it('undefined و فیلدِ غایب یکی حساب می‌شوند', () => {
    const cache = new ToolResultCache();
    cache.set('t', { q: 'a', extra: undefined }, 'h', out('x'));

    expect(cache.get('t', { q: 'a' }, 'h')).toBeDefined();
  });
});

describe('ToolResultCache — ابطال', () => {
  it('عوض شدن projectHash نتیجه را برنمی‌گرداند', () => {
    const cache = new ToolResultCache();
    cache.set('t', { q: 'a' }, 'h1', out('x'));

    expect(cache.get('t', { q: 'a' }, 'h2')).toBeUndefined();
  });

  it('ttl رعایت می‌شود', () => {
    jest.useFakeTimers();
    try {
      const cache = new ToolResultCache({ ttlMs: 1000 });
      cache.set('t', { q: 'a' }, 'h', out('x'));

      jest.advanceTimersByTime(999);
      expect(cache.get('t', { q: 'a' }, 'h')).toBeDefined();

      jest.advanceTimersByTime(2);
      expect(cache.get('t', { q: 'a' }, 'h')).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('clear همه چیز را می‌برد', () => {
    const cache = new ToolResultCache();
    cache.set('t', { q: 'a' }, 'h', out('x'));
    cache.clear();

    expect(cache.size()).toBe(0);
  });
});
