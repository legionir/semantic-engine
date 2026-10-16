/**
 * دیوارِ خروجی کتابخانه — SE-EXT-02.
 *
 * `console.log` در یک کتابخانه دو مشکل دارد. اول اینکه قابل خاموش یا
 * هدایت کردن نیست — در افزونه به پنل Output نمی‌رسید و در CLI قابل
 * فیلتر نبود. دوم، و بدتر: در حالت سرور stdio هر بایت روی stdout قاب
 * JSON-RPC را می‌شکند.
 *
 * نقاط ورود مستثنا هستند: آنجا چاپ کردن *همان* کاری است که باید
 * انجام شود.
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..');

/** فایل‌هایی که خودشان یک برنامه‌اند، نه بخشی از کتابخانه. */
const ENTRY_POINTS: readonly string[] = [
  'ai/mcp/cli.ts',
  'vector/VectorStore.benchmark.ts',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__mocks__') continue;
      walk(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** فقط فراخوانی واقعی، نه ذکر نام در یک توضیح. */
const CALL = /(^|[^.\w'"`])console\s*\.\s*(log|info|warn|error|debug|trace|dir|table)\s*\(/m;

const offenders = walk(SRC)
  .filter(file => CALL.test(fs.readFileSync(file, 'utf8')))
  .map(file => path.relative(SRC, file).split(path.sep).join('/'))
  .sort();

describe('library output', () => {

  it('goes through the logger everywhere except the entry points', () => {
    expect(offenders).toEqual([...ENTRY_POINTS].sort());
  });

  it('has left the scanner, the pipeline and the incremental engine', () => {
    const shouldBeClean = offenders
      .filter(file => !ENTRY_POINTS.includes(file))
      .filter(file =>
        /^(scanner|pipeline|incremental|export|symbols|dependencies|graphs|core|host|ai)\//.test(file)
      );

    expect(shouldBeClean).toEqual([]);
  });

  /*
  | خودنگهبان: اگر الگو یا پیمایش بشکند، فهرست خالی می‌شود و تست بالا
  | بی‌معنی سبز می‌ماند.
  */
  it('actually detects a console call', () => {
    expect(CALL.test('  console.warn("x");')).toBe(true);
    expect(CALL.test('this.logger.warn("x");')).toBe(false);
    expect(CALL.test('// جای console.warn را می‌گیرد')).toBe(false);
    expect(offenders.length).toBe(ENTRY_POINTS.length);
  });
});
