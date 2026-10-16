/**
 * SE-CLI-01 — تبدیل نوع پرچم‌های CLI بر اساس schema ابزار.
 *
 * این مسیر را agent برای محدود کردن حجم خروجی (`--limit`) استفاده می‌کند؛
 * وقتی رشته می‌ماند، ابزار با «must be integer» می‌افتد.
 */

import { coerceToolParams } from './query-command';

const SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    limit: { type: 'integer' },
    minScore: { type: 'number' },
    strict: { type: 'boolean' },
    languages: { type: 'array' },
  },
} as Record<string, unknown>;

const coerce = (options: Record<string, string | boolean>) => coerceToolParams(SCHEMA, options);

describe('SE-CLI-01 — coerceToolParams', () => {
  it('عددِ صحیح را از رشته به number تبدیل می‌کند', () => {
    const out = coerce({ name: 'rank', limit: '5' });
    expect('params' in out && out.params.limit).toBe(5);
    expect('params' in out && out.params.name).toBe('rank');
  });

  it('برای مقدار نامعتبر، خطای نام‌دارِ همان فلگ می‌دهد', () => {
    const out = coerce({ limit: 'abc' });
    expect('error' in out && out.error).toContain('limit');
    expect('error' in out && out.error).toContain('integer');
  });

  it('کسری را برای `integer` نمی‌پذیرد ولی برای `number` می‌پذیرد', () => {
    expect('error' in coerce({ limit: '2.5' })).toBe(true);
    const out = coerce({ minScore: '0.5' });
    expect('params' in out && out.params.minScore).toBe(0.5);
  });

  it('boolean متنی و فلگ بدون مقدار را به boolean تبدیل می‌کند', () => {
    expect(coerce({ strict: 'true' })).toEqual({ params: { strict: true } });
    expect(coerce({ strict: 'false' })).toEqual({ params: { strict: false } });
    expect(coerce({ strict: true })).toEqual({ params: { strict: true } });
    expect('error' in coerce({ strict: 'yes' })).toBe(true);
  });

  it('فلگِ لیست را به آرایه تقسیم می‌کند و رشتهٔ خالی را حذف نمی‌کند', () => {
    const out = coerce({ languages: '.ts, .tsx ,' });
    expect('params' in out && out.params.languages).toEqual(['.ts', '.tsx']);
  });

  it('پارامترهای خارج از schema را دست‌نخورده رد می‌کند و رزروها را حذف', () => {
    const out = coerce({ symbolId: 'abc', json: true, root: '/x', task: '  spaced  ' });
    expect('params' in out && out.params.symbolId).toBe('abc');
    expect('params' in out && out.params.task).toBe('  spaced  ');
    expect('params' in out && ('json' in out.params || 'root' in out.params)).toBe(false);
  });

  it('schema بدون properties را نمی‌شکند', () => {
    const out = coerceToolParams({ type: 'object' }, { anything: '7' });
    expect(out).toEqual({ params: { anything: '7' } });
  });
});
