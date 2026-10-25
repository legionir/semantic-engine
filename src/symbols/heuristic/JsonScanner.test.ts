/**
 * پیمایشگر JSON با موقعیت — SE-SYM-21 و SE-SYM-22.
 */

import { scanJsonKeys, JsonScanError } from './JsonScanner';

const paths = (text: string, comments = false) =>
  scanJsonKeys(text, comments).map(entry => entry.path);

describe('scanJsonKeys', () => {

  it('finds top-level keys in order', () => {
    expect(paths('{"a":1,"b":2}')).toEqual(['a', 'b']);
  });

  it('finds nested keys with their full path', () => {
    expect(paths('{"a":{"b":{"c":1}}}')).toEqual(['a.b.c', 'a.b', 'a']);
  });

  /*
  | SE-SYM-22 — دو کلید هم‌نام در دو مسیر. روش قبلی هر دو را به اولین
  | رخداد نسبت می‌داد، پس هر دو یک شماره خط می‌گرفتند.
  */
  it('distinguishes two keys with the same name at different paths', () => {
    const text = `{
  "build": { "target": "es5" },
  "test":  { "target": "es2022" }
}`;
    const found = scanJsonKeys(text);
    const targets = found.filter(entry => entry.key === 'target');

    expect(targets.map(entry => entry.path)).toEqual(['build.target', 'test.target']);
    expect(targets[0].keyOffset).not.toBe(targets[1].keyOffset);
  });

  it('indexes keys inside arrays by position', () => {
    expect(paths('{"items":[{"id":1},{"id":2}]}'))
      .toEqual(['items[0].id', 'items[1].id', 'items']);
  });

  /*
  | SE-SYM-21، بازتولید مستقیم. `stripComments` قدیمی روی این ورودی
  | رشته را از `https:` می‌بُرید و parse شکست می‌خورد — یعنی هر
  | package.json دارای homepage صفر symbol می‌داد.
  */
  it('does not choke on a URL inside a string', () => {
    const text = '{"homepage":"https://example.com/docs","name":"x"}';

    expect(paths(text)).toEqual(['homepage', 'name']);
  });

  it('does not choke on a block comment marker inside a string', () => {
    expect(paths('{"glob":"src/**/*.ts","name":"x"}')).toEqual(['glob', 'name']);
  });

  it('handles an escaped quote inside a value', () => {
    expect(paths('{"quote":"he said \\"hi\\"","name":"x"}')).toEqual(['quote', 'name']);
  });

  it('handles an escaped backslash at the end of a value', () => {
    expect(paths('{"path":"C:\\\\","name":"x"}')).toEqual(['path', 'name']);
  });

  it('ignores comments only when told to', () => {
    const text = '{\n  // a comment\n  "a": 1\n}';

    expect(paths(text, true)).toEqual(['a']);
    expect(() => scanJsonKeys(text, false)).toThrow(JsonScanError);
  });

  it('accepts a trailing comma when comments are allowed', () => {
    expect(paths('{"a":1,}', true)).toEqual(['a']);
  });

  it('reports where malformed input went wrong', () => {
    try {
      scanJsonKeys('{"a" 1}');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(JsonScanError);
      expect((error as Error).message).toMatch(/expected ':'/);
    }
  });

  it('handles an empty object and an empty array', () => {
    expect(paths('{}')).toEqual([]);
    expect(paths('{"a":[]}')).toEqual(['a']);
  });

  it('handles an empty document', () => {
    expect(paths('')).toEqual([]);
  });

  it('gives a range that covers a whole object value', () => {
    const text = `{
  "a": {
    "b": 1
  },
  "c": 2
}`;
    const a = scanJsonKeys(text).find(entry => entry.path === 'a');

    expect(text[a!.keyOffset]).toBe('"');
    expect(text[a!.valueEnd]).toBe('}');
    expect(text.slice(a!.keyOffset, a!.valueEnd + 1)).toContain('"b": 1');
  });

  it('gives a range that stops at the end of a scalar', () => {
    const text = '{"a": 42, "b": 1}';
    const a = scanJsonKeys(text).find(entry => entry.path === 'a');

    expect(text.slice(a!.keyOffset, a!.valueEnd + 1)).toBe('"a": 42');
  });

  it('walks a realistic package.json without losing a key', () => {
    const text = JSON.stringify({
      name: 'pkg',
      homepage: 'https://example.com/docs',
      repository: { type: 'git', url: 'git+https://github.com/a/b.git' },
      scripts: { build: 'tsc -p ./', test: 'jest' },
    }, null, 2);

    expect(paths(text)).toEqual([
      'name',
      'homepage',
      'repository.type',
      'repository.url',
      'repository',
      'scripts.build',
      'scripts.test',
      'scripts',
    ]);
  });
});
