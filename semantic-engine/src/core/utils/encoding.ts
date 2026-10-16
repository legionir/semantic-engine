/**
 * تشخیص فایل باینری و encoding.
 *
 * استراتژی: خواندن ۸۱۹۲ بایت اول و بررسی وجود null byte.
 * این روش ساده اما مؤثر است و توسط Git هم استفاده می‌شود.
 */

const BINARY_CHECK_BYTES = 8192;

/**
 * بررسی باینری بودن بر اساس buffer اولیه‌ی فایل.
 * وجود null byte (0x00) در ۸۱۹۲ بایت اول → باینری.
 */
export function isBinaryBuffer(buffer: Buffer): boolean {
  /*
  | یک فایل UTF-16 پر از بایت `0x00` است — یعنی هیوریستیک «NUL دیدم
  | پس باینری است» آن را باینری می‌خواند و کل محتوایش از ایندکس
  | بیرون می‌ماند. BOM قطعی‌تر از هیوریستیک است، پس اول بررسی
  | می‌شود. (بخشی از SE-SCAN-04، ولی سازوکار جداگانه‌ای است.)
  */
  const encoding = detectEncoding(buffer);
  if (encoding === 'utf16le' || encoding === 'utf16be' || encoding === 'utf8-bom') {
    return false;
  }

  const checkLength = Math.min(buffer.length, BINARY_CHECK_BYTES);
  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0x00) {
      return true;
    }
  }
  return false;
}

/**
 * تشخیص encoding — فعلاً ساده: BOM detection + default utf8.
 * در آینده می‌توان chardet اضافه کرد.
 */
export function detectEncoding(buffer: Buffer): string {
  // UTF-8 BOM
  if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
    return 'utf8-bom';
  }
  // UTF-16 LE BOM
  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
    return 'utf16le';
  }
  // UTF-16 BE BOM
  if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
    return 'utf16be';
  }
  return 'utf8';
}

/**
 * شمارش خطوط — بر اساس newline characters.
 * فایل خالی = 0 خط. فایل بدون newline اما با محتوا = 1 خط.
 */
export function countLines(content: string): number {
  if (content.length === 0) return 0;
  const parts = content.split('\n');
  // مطابق wc -l: تعداد newline ها؛ اگر فایل با newline تمام نشده باشد، یک خط اضافه
  return content.endsWith('\n') ? parts.length - 1 : parts.length;
}

/**
 * نرمال‌سازی خط‌جداکننده به LF — SE-PORT-01.
 *
 * چرا: `hash`, `size` و `lines` نباید به سیستم‌عاملی که فایل روی آن
 * checkout شده وابسته باشند. یک مخزنِ یکسان روی ویندوز با CRLF و روی
 * لینوکس با LF ذخیره می‌شود؛ اگر hash روی بایت خام گرفته شود، همان
 * فایلِ بی‌تغییر دو hash متفاوت می‌گیرد و تشخیص staleness مجبور به
 * re-index کامل هنگام جابه‌جایی OS می‌شود. با نرمال‌سازی CRLF/CR → LF
 * پیش از این محاسبات، ایندکس بین ویندوز و لینوکس یکسان و قابل‌حمل
 * می‌ماند. (محتوایی که به تحلیل tree-sitter می‌رود دست‌نخورده می‌ماند؛
 * شمارهٔ خط‌ها تغییر نمی‌کند چون CRLF و LF هر دو یک `\n` دارند.)
 */
export function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n?/g, '\n');
}

/**
 * دیکد یک buffer با احترام به انکودینگ تشخیص‌داده‌شده — SE-SCAN-04.
 *
 * `buffer.toString('utf8')` بی‌قید روی یک فایل UTF-16 محتوای درهم
 * می‌دهد، و BOM در UTF-8 حذف نمی‌شود و به خط اول نشت می‌کند — یعنی
 * به تشخیص shebang و به اولین symbol هر فایلی که با BOM ذخیره شده.
 */
export function decodeBuffer(buffer: Buffer, encoding?: string): string {
  const detected = encoding ?? detectEncoding(buffer);

  if (detected === 'utf16le') {
    return buffer.subarray(2).toString('utf16le');
  }

  if (detected === 'utf16be') {
    /*
    | Node انکودینگ UTF-16BE ندارد. جابه‌جا کردن جفت بایت‌ها آن را به
    | LE تبدیل می‌کند — روی یک کپی، چون buffer ورودی ممکن است جای
    | دیگری هم استفاده شود.
    */
    const swapped = Buffer.from(buffer.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }

  if (detected === 'utf8-bom') {
    return buffer.subarray(3).toString('utf8');
  }

  return buffer.toString('utf8');
}
