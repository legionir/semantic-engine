import * as barrel from './index';

/*
| SE-F-016 / SE-F-019 — barrel عمومی utils باید هر تابعی را که از
| consumerهای داخل package قابل استفاده است export کند. پیش از این
| `decodeBuffer`, `normalizeLineEndings`, `getLineNumber`, `LineIndex` و
| `sortSymbolsDeterministically` فقط با import مستقیم فایل دسترسی بودند؛
| یک consumer که از `src/core/utils` import می‌کرد به compile-time
| missing-export می‌خورد بدون اینکه چیزی در barrel اشتباه به نظر برسد.
| این تست حضور هر نام را روی خودِ barrel قفل می‌کند؛ حذف یا تغییر نام
| بدون نیت، اینجا قرمز می‌شود.
*/
describe('core/utils barrel surface', () => {
  const EXPECTED = [
    'sha256',
    'generateFileId',
    'generateSymbolId',
    'normalizePath',
    'isBinaryBuffer',
    'detectEncoding',
    'countLines',
    'normalizeLineEndings',
    'decodeBuffer',
    'LineIndex',
    'getLineNumber',
    'sortSymbolsDeterministically',
  ];

  it.each(EXPECTED)('exports %s', name => {
    expect(barrel).toHaveProperty(name);
  });

  it('exports working functions (not type-only stubs)', () => {
    expect(typeof barrel.getLineNumber).toBe('function');
    expect(barrel.getLineNumber('a\nb\nc', 3)).toBe(2);
    expect(typeof barrel.sortSymbolsDeterministically).toBe('function');
    expect(barrel.normalizeLineEndings('a\r\nb')).toBe('a\nb');
  });
});
