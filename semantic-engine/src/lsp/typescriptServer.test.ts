/**
 * LSP-01 — همان یک قاعده: هرگز فرض نکن کامپایلری که import می‌کنیم
 * زبان‌سرور هم هست.
 *
 * `typescript@5.9.3` وابستگی این پکیج است. اگر `bin/tsc`ش را با
 * `--lsp --stdio` بالا بیاوریم، این را روی **stdout** می‌نویسد:
 *
 * ```
 * error TS5023: Unknown compiler option '--lsp'.
 * ```
 *
 * و کلاینت LSP آن را به‌عنوان قاب خراب می‌بیند، نه به‌عنوان «نسخهٔ
 * اشتباه». پس دروازهٔ نسخه پیش از spawn است، و این فایل همان دروازه
 * را می‌سنجد — با یک probe تزریق‌شده، بی‌آنکه چیزی spawn شود.
 */

import * as path from 'path';
import {
  MINIMUM_TYPESCRIPT_LSP_MAJOR,
  TS_LSP_ENV_VAR,
  describeMissingTypeScriptLsp,
  majorOf,
  parseVersion,
  resolveTypeScriptLspCommand,
  supportsLsp,
} from './typescriptServer';

describe('LSP-01 — خواندن نسخه', () => {
  it.each([
    ['Version 5.9.3\n', '5.9.3'],
    ['Version 7.0.2\n', '7.0.2'],
    ['Version 7.0.0-dev.20260707.2\n', '7.0.0-dev.20260707.2'],
    ['tsgo version 7.1.0', '7.1.0'],
  ])('«%s» → %s', (output, expected) => {
    expect(parseVersion(output)).toBe(expected);
  });

  it.each([null, '', 'no numbers here'])('«%s» نسخه ندارد', output => {
    expect(parseVersion(output)).toBeNull();
  });

  it('major درست خوانده می‌شود', () => {
    expect(majorOf('7.0.0-dev.20260707.2')).toBe(7);
    expect(majorOf('5.9.3')).toBe(5);
    expect(majorOf(null)).toBeNull();
  });

  it('فقط از نسخهٔ ۷ به بعد `--lsp` دارد', () => {
    expect(MINIMUM_TYPESCRIPT_LSP_MAJOR).toBe(7);
    expect(supportsLsp('7.0.0-dev.20260707.2')).toBe(true);
    expect(supportsLsp('8.1.0')).toBe(true);
    expect(supportsLsp('5.9.3')).toBe(false);
    expect(supportsLsp('4.0.0')).toBe(false);
    expect(supportsLsp(null)).toBe(false);
  });
});

describe('LSP-01 — انتخاب باینری', () => {
  const bin = (...parts: string[]) => path.join(path.sep, ...parts);

  it('باینری نسخهٔ ۵ رد می‌شود، حتی وقتی تنها گزینه است', () => {
    const seen: string[] = [];
    const resolved = resolveTypeScriptLspCommand({
      env: { PATH: bin('usr', 'bin') },
      resolveFrom: bin('nowhere'),
      exists: () => true,
      probeVersion: command => {
        seen.push(command);
        return '5.9.3';
      },
    });

    expect(resolved).toBeNull();
    expect(seen.length).toBeGreaterThan(0);
  });

  it('اولین باینری نسخهٔ ۷ روی PATH انتخاب می‌شود', () => {
    const resolved = resolveTypeScriptLspCommand({
      env: { PATH: [bin('a'), bin('b')].join(path.delimiter) },
      resolveFrom: bin('nowhere'),
      exists: candidate => candidate.startsWith(bin('b')),
      probeVersion: () => '7.0.2',
    });

    expect(resolved).not.toBeNull();
    expect(resolved!.source).toBe('path');
    expect(resolved!.command).toBe(path.join(bin('b'), 'tsgo'));
    expect(resolved!.args).toEqual(['--lsp', '--stdio']);
    expect(resolved!.version).toBe('7.0.2');
  });

  it('متغیر محیطی بر همه‌چیز مقدم است', () => {
    const explicit = bin('opt', 'my-ts-lsp');
    const resolved = resolveTypeScriptLspCommand({
      env: { [TS_LSP_ENV_VAR]: explicit, PATH: bin('a') },
      resolveFrom: bin('nowhere'),
      exists: () => true,
      probeVersion: () => '7.0.2',
    });

    expect(resolved!.command).toBe(explicit);
    expect(resolved!.source).toBe('env');
  });

  it('متغیر محیطیِ اشاره‌کننده به مسیر ناموجود، سکوت نمی‌کند و سراغ حدس هم نمی‌رود', () => {
    /*
    | اگر کسی این متغیر را ست کرده، اشتباه بودن مسیرش باید دیده شود.
    | برگرداندن یک سرور *دیگر* یعنی کاربر ساعت‌ها فکر می‌کند
    | تنظیمش اثر کرده است.
    */
    const resolved = resolveTypeScriptLspCommand({
      env: { [TS_LSP_ENV_VAR]: bin('opt', 'gone'), PATH: bin('a') },
      resolveFrom: bin('nowhere'),
      exists: candidate => candidate !== bin('opt', 'gone'),
      probeVersion: () => '7.0.2',
    });

    expect(resolved).toBeNull();
  });

  it('نبود سرور یک خطا نیست — null است', () => {
    const resolved = resolveTypeScriptLspCommand({
      env: { PATH: bin('a') },
      resolveFrom: bin('nowhere'),
      exists: () => false,
      probeVersion: () => null,
    });
    expect(resolved).toBeNull();
  });

  /*
  | «در همین مخزن پیدا می‌شود» یک ادعا دربارهٔ *محیط* است، نه دربارهٔ
  | منطق. جایش `typescriptServer.integration.test.ts` است — فاز ۳۸،
  | SE-LSP-15.
  */
});

describe('LSP-01 — پیام راهنما', () => {
  it('می‌گوید چرا نشد و چه باید کرد', () => {
    const message = describeMissingTypeScriptLsp();
    expect(message).toContain('typescript@5');
    expect(message).toContain('@typescript/native-preview');
    expect(message).toContain(TS_LSP_ENV_VAR);
  });

  it('نصب خودکار پیشنهاد نمی‌شود — فقط دستور نشان داده می‌شود', () => {
    expect(describeMissingTypeScriptLsp()).toContain('npm install');
  });
});
