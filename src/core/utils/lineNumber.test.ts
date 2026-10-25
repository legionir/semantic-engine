/**
 * شمارهٔ خط از آفست — SE-DATA-07.
 *
 * نسخهٔ قبلی به‌ازای هر فراخوانی یک کپی از کل پیشوند می‌ساخت و
 * می‌شکست، و استخراج‌گرهای اعلانی این را داخل حلقه صدا می‌زنند.
 */

import { getLineNumber, LineIndex } from './lineNumber';

describe('getLineNumber', () => {

  const CONTENT = 'first\nsecond\nthird\n';

  it('returns 1 for the very start', () => {
    expect(getLineNumber(CONTENT, 0)).toBe(1);
  });

  it('stays on the first line until the newline', () => {
    expect(getLineNumber(CONTENT, 4)).toBe(1);
    expect(getLineNumber(CONTENT, 5)).toBe(1);   // خودِ \n هنوز خط ۱ است
  });

  it('moves to the next line after a newline', () => {
    expect(getLineNumber(CONTENT, 6)).toBe(2);
    expect(getLineNumber(CONTENT, 13)).toBe(3);
  });

  it('handles an offset past the end', () => {
    expect(getLineNumber(CONTENT, 10_000)).toBe(4);
  });

  it('handles a negative offset', () => {
    expect(getLineNumber(CONTENT, -5)).toBe(1);
  });

  it('handles empty content', () => {
    expect(getLineNumber('', 0)).toBe(1);
  });

  it('handles content with no newline at all', () => {
    expect(getLineNumber('one line only', 7)).toBe(1);
  });

  it('handles consecutive newlines', () => {
    expect(getLineNumber('a\n\n\nb', 4)).toBe(4);
  });

  /*
  | معیار درستی: باید دقیقاً همان جوابی را بدهد که پیاده‌سازی سادهٔ
  | قبلی می‌داد. سرعت بدون این تضمین بی‌ارزش است.
  */
  it('agrees with the naive implementation everywhere', () => {
    const naive = (content: string, index: number) =>
      content.substring(0, index).split('\n').length;
    const content = 'alpha\nbeta\n\ngamma\ndelta\n';

    for (let index = 0; index <= content.length + 3; index++) {
      expect(getLineNumber(content, index)).toBe(naive(content, index));
    }
  });

  it('agrees with the naive implementation on a realistic file', () => {
    const naive = (content: string, index: number) =>
      content.substring(0, index).split('\n').length;
    const content = Array.from({ length: 500 }, (_, i) => `line ${i} of text`).join('\n');

    for (let index = 0; index < content.length; index += 37) {
      expect(getLineNumber(content, index)).toBe(naive(content, index));
    }
  });

  it('switches correctly between two different strings', () => {
    const first = 'a\nb\nc';
    const second = 'x\ny';

    expect(getLineNumber(first, 4)).toBe(3);
    expect(getLineNumber(second, 2)).toBe(2);
    expect(getLineNumber(first, 4)).toBe(3);
  });

  /*
  | اثبات اینکه رفتار دیگر درجه‌دو نیست. پیاده‌سازی ساده روی این
  | ورودی چند ثانیه طول می‌کشد؛ نسخهٔ جدید باید بسیار سریع‌تر باشد.
  | آستانه سخاوتمند است تا روی ماشین کند هم پایدار بماند.
  */
  it('does not behave quadratically when called in a loop', () => {
    const content = 'x'.repeat(400_000).split('').map((c, i) => (i % 80 === 0 ? '\n' : c)).join('');

    const started = Date.now();
    for (let index = 0; index < content.length; index += 400) {
      getLineNumber(content, index);
    }

    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('LineIndex', () => {

  it('counts the lines it indexed', () => {
    expect(new LineIndex('a\nb\nc').lineCount).toBe(3);
    expect(new LineIndex('a\nb\nc\n').lineCount).toBe(4);
  });

  it('can be reused for many lookups', () => {
    const index = new LineIndex('one\ntwo\nthree\nfour');

    expect(index.lineAt(0)).toBe(1);
    expect(index.lineAt(4)).toBe(2);
    expect(index.lineAt(8)).toBe(3);
    expect(index.lineAt(14)).toBe(4);
  });
});
