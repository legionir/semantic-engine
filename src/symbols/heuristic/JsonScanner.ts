/**
 * پیمایشگر JSON با موقعیت — SE-SYM-21 و SE-SYM-22.
 *
 * روش قبلی دو مرحله بود: `JSON.parse` روی متنِ کامنت‌زدایی‌شده، و بعد
 * جست‌وجوی regex برای پیدا کردن شماره خط هر کلید. هر دو مرحله شکسته
 * بودند:
 *
 *   SE-SYM-21 — `stripComments` روی *همهٔ* فایل‌های JSON اجرا می‌شد و
 *   `//` را داخل رشته‌ها هم می‌بُرید. یعنی هر `package.json` دارای
 *   `homepage` یا `repository` — که URL دارند — اصلاً parse نمی‌شد و
 *   صفر symbol می‌داد. (بازتولید شد: «Bad control character in string
 *   literal».)
 *
 *   SE-SYM-22 — `findKeyLine` اولین `"key":` را در کل فایل می‌گشت،
 *   بدون توجه به مسیر. هر کلید هم‌نام در هر عمقی، شماره خط یکی
 *   می‌گرفت. هزینه‌اش هم O(n) به ازای هر کلید بود.
 *
 * یک پیمایش با موقعیت، هر دو را از بین می‌برد: رشته‌ها ذاتاً فهمیده
 * می‌شوند و هر کلید مسیر و بازهٔ خودش را دارد.
 */

export interface JsonKeyRange {
  /** مسیر نقطه‌ای، مثل `compilerOptions.paths` یا `items[0].name`. */
  readonly path: string;
  readonly key: string;
  /** ایندکس نقل‌قول آغازین کلید در متن خام. */
  readonly keyOffset: number;
  /** ایندکس آخرین کاراکتر مقدار در متن خام. */
  readonly valueEnd: number;
}

export class JsonScanError extends Error {
  constructor(message: string, readonly offset: number) {
    super(message);
    this.name = 'JsonScanError';
  }
}

/**
 * تفاوت‌های گویش‌های JSON که این پیمایشگر به آن‌ها اهمیت می‌دهد.
 *
 * SE-SCAN-12: تا فاز ۲۲ فقط یک پرچم `allowComments` وجود داشت و
 * `json5` با `jsonc` یکی گرفته می‌شد. ولی مشخصهٔ اصلی JSON5 کلید
 * بدون نقل‌قول است، نه کامنت — و آن پشتیبانی نمی‌شد. یعنی ادعای
 * پشتیبانی از json5 روی یک فایل واقعی JSON5 صفر symbol می‌داد.
 */
export interface JsonDialect {
  /** کامنت‌های `//` و `/* *\/` مجازند — jsonc و json5. */
  readonly comments: boolean;
  /** کلید بدون نقل‌قول مجاز است — فقط json5. */
  readonly unquotedKeys: boolean;
}

const JSON_DIALECTS: Readonly<Record<string, JsonDialect>> = {
  json: { comments: false, unquotedKeys: false },
  jsonc: { comments: true, unquotedKeys: false },
  json5: { comments: true, unquotedKeys: true },
};

/** گویش متناظر با یک languageId؛ ناشناخته → JSON سخت‌گیرانه. */
export function dialectFor(languageId: string): JsonDialect {
  return JSON_DIALECTS[languageId] ?? JSON_DIALECTS['json']!;
}

/**
 * همهٔ کلیدها با مسیر و بازه، به ترتیب ظاهر شدن در سند.
 *
 * @param dialect گویش، یا فقط یک boolean برای «کامنت مجاز است».
 * کامنت‌ها *حین پیمایش* رد می‌شوند، نه با یک پاس حذف روی کل متن. همین
 * تفاوت است که یک URL داخل رشته را سالم نگه می‌دارد.
 */
export function scanJsonKeys(
  text: string,
  dialect: JsonDialect | boolean = false
): JsonKeyRange[] {
  const { comments: allowComments, unquotedKeys: allowUnquotedKeys } =
    typeof dialect === 'boolean' ? { comments: dialect, unquotedKeys: false } : dialect;

  const found: JsonKeyRange[] = [];
  let index = 0;

  const fail = (message: string): never => {
    throw new JsonScanError(`${message} at position ${index}`, index);
  };

  const skipTrivia = (): void => {
    for (;;) {
      while (index < text.length && /\s/.test(text[index]!)) index++;
      if (!allowComments) return;

      if (text[index] === '/' && text[index + 1] === '/') {
        const end = text.indexOf('\n', index);
        index = end === -1 ? text.length : end;
        continue;
      }
      if (text[index] === '/' && text[index + 1] === '*') {
        const end = text.indexOf('*/', index + 2);
        index = end === -1 ? text.length : end + 2;
        continue;
      }
      return;
    }
  };

  /** از نقل‌قول آغازین تا نقل‌قول پایانی؛ ایندکس را بعد از آن می‌گذارد. */
  const readString = (): string => {
    const quote = text[index];
    if (quote !== '"' && quote !== "'") fail('expected a string');
    index++;

    let value = '';
    while (index < text.length) {
      const char = text[index];
      if (char === '\\') {
        value += text.slice(index, index + 2);
        index += 2;
        continue;
      }
      if (char === quote) {
        index++;
        return value;
      }
      value += char;
      index++;
    }
    return fail('unterminated string');
  };

  /**
   * کلید شیء. در JSON و JSONC حتماً رشته است؛ در JSON5 می‌تواند یک
   * شناسهٔ بدون نقل‌قول باشد (`{ port: 8080 }`).
   */
  const readKey = (): string => {
    const char = text[index];
    if (char === '"' || char === "'") return readString();
    if (!allowUnquotedKeys) return fail('expected a string');

    const start = index;
    while (index < text.length && /[A-Za-z0-9_$]/.test(text[index]!)) index++;
    if (index === start) fail('expected a key');
    return text.slice(start, index);
  };

  const readValue = (path: string): void => {
    skipTrivia();
    const char = text[index];

    if (char === '{') return readObject(path);
    if (char === '[') return readArray(path);
    if (char === '"' || char === "'") { readString(); return; }

    // عدد، true، false، null، یا یک شناسهٔ بدون نقل‌قول در json5
    const start = index;
    while (index < text.length && !/[,}\]\s]/.test(text[index]!)) index++;
    if (index === start) fail(`unexpected character ${JSON.stringify(char ?? 'EOF')}`);
  };

  const readObject = (path: string): void => {
    index++;                                  // از `{` رد شو
    skipTrivia();

    if (text[index] === '}') { index++; return; }

    for (;;) {
      skipTrivia();

      const keyOffset = index;
      const key = readKey();
      const childPath = path ? `${path}.${key}` : key;

      skipTrivia();
      if (text[index] !== ':') fail(`expected ':' after key ${JSON.stringify(key)}`);
      index++;

      readValue(childPath);
      found.push({ path: childPath, key, keyOffset, valueEnd: index - 1 });

      skipTrivia();
      if (text[index] === ',') { index++; skipTrivia(); if (text[index] === '}') { index++; return; } continue; }
      if (text[index] === '}') { index++; return; }
      fail('expected \',\' or \'}\'');
    }
  };

  const readArray = (path: string): void => {
    index++;                                  // از `[` رد شو
    skipTrivia();

    if (text[index] === ']') { index++; return; }

    for (let position = 0; ; position++) {
      readValue(`${path}[${position}]`);
      skipTrivia();
      if (text[index] === ',') { index++; skipTrivia(); if (text[index] === ']') { index++; return; } continue; }
      if (text[index] === ']') { index++; return; }
      fail('expected \',\' or \']\'');
    }
  };

  skipTrivia();
  if (index < text.length) readValue('');

  return found;
}
