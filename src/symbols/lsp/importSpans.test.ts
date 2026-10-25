/**
 * SE-LSP-02 — کدام symbolهای زبان‌سرور در واقع import‌اند.
 *
 * `documentSymbol` روی TypeScript، هر نام import شده را یک `Variable`
 * سطح‌بالا گزارش می‌کند (فاز ۳۲ این را روی `tsgo` ثبت کرد). آن‌ها
 * تعریف نیستند؛ ارجاع‌اند، و اضافه شدنشان به ایندکس یعنی هر فایل به
 * تعداد importهایش symbol جعلی می‌گیرد.
 *
 * برای تشخیص، به محدودهٔ خطیِ خودِ دستور import نگاه می‌کنیم — نه به
 * شکل symbol. دو ایدهٔ ساده‌تر با probe رد شدند:
 *
 *   `range === selectionRange`؟  → `import * as Gamma` و
 *                                  `import { E as Zeta }` این را
 *                                  نقض می‌کنند، و اعضای enum هم
 *                                  به‌غلط گرفته می‌شوند.
 *   `foldingRange` با `kind:"imports"`؟ → فقط وقتی چند خط باشد؛
 *                                  فایل تک-import هیچ‌چیز نمی‌دهد.
 */

import { findImportLineSpans, isInsideSpans } from './importSpans';

describe('SE-LSP-02 — محدودهٔ خطی دستورهای import', () => {
  const spansOf = (content: string, language = 'typescript') =>
    findImportLineSpans(content, language).map(span => [span.startLine, span.endLine]);

  it('import تک‌خطی', () => {
    expect(spansOf(`import { A } from './a';\nexport const x = 1;\n`)).toEqual([[0, 0]]);
  });

  it('import چندخطی تا خط `from` ادامه دارد', () => {
    const content = ['import {', '  A,', '  B as C,', "} from './a';", 'export const x = 1;'].join(
      '\n'
    );
    expect(spansOf(content)).toEqual([[0, 3]]);
  });

  it('همهٔ شکل‌های import شناخته می‌شوند', () => {
    const content = [
      "import Default from './a';",
      "import * as Ns from './a';",
      "import './side-effect';",
      "import type { T } from './a';",
      "export { Re } from './a';",
      "export * from './a';",
      'export const stop = 1;',
    ].join('\n');
    expect(spansOf(content)).toEqual([[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5]]);
  });

  it('`import(` پویا یک دستور import نیست', () => {
    /*
    | `const mod = await import('./a')` یک عبارت است، نه دستور. اگر
    | به‌عنوان دستور شمرده شود، `mod` — که یک symbol واقعی است — از
    | ایندکس حذف می‌شود.
    */
    const content = ["const mod = await import('./a');", 'export const x = 1;'].join('\n');
    expect(spansOf(content)).toEqual([]);
  });

  it('کلمهٔ import داخل رشته یا کامنت شمرده نمی‌شود', () => {
    const content = [
      "// import { Fake } from './nope';",
      "const text = \"import { AlsoFake } from './nope';\";",
      "/* import { Third } from './nope'; */",
      "import { Real } from './real';",
    ].join('\n');
    expect(spansOf(content)).toEqual([[3, 3]]);
  });

  it('require در CommonJS هم یک اتصال import است', () => {
    const content = ["const fs = require('fs');", 'export const x = 1;'].join('\n');
    expect(spansOf(content, 'javascript')).toEqual([[0, 0]]);
  });

  it('import پایتونی', () => {
    const content = ['import os', 'from pathlib import Path', 'def go():', '    pass'].join('\n');
    expect(spansOf(content, 'python')).toEqual([[0, 0], [1, 1]]);
  });

  it('یک import ناتمام کل فایل را نمی‌بلعد', () => {
    /*
    | فایل نیمه‌تایپ‌شده در حالت watch عادی است. اگر جست‌وجوی خط
    | `from` تا انتهای فایل ادامه پیدا کند، همهٔ symbolها import
    | حساب می‌شوند و فایل خالی به نظر می‌رسد.
    */
    const content = ['import {', '  A,', '', 'export class Survivor {}'].join('\n');
    const spans = findImportLineSpans(content, 'typescript');
    expect(spans.every(span => span.endLine < 3)).toBe(true);
  });

  it('isInsideSpans مرزها را شامل می‌شود', () => {
    const spans = [{ startLine: 2, endLine: 4 }];
    expect([1, 2, 3, 4, 5].map(line => isInsideSpans(line, spans))).toEqual([
      false,
      true,
      true,
      true,
      false,
    ]);
  });
});
