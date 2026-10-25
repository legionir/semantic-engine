/**
 * نگاشت پسوند فایل → زبان برنامه‌نویسی.
 *
 * این جدول به‌عمد ساده نگه داشته شده — فقط زبان‌هایی که Semantic Engine
 * واقعاً پشتیبانی عمیق (symbol extraction) از آن‌ها دارد + زبان‌های رایج
 * که حداقل باید شناسایی شوند.
 *
 * ---
 *
 * SE-SCAN-05 — چرا این فایل بازنویسی شد.
 *
 * نسخهٔ قبلی سه منبع حقیقتِ *موازی* داشت که هیچ‌چیز آن‌ها را هم‌گام نگه
 * نمی‌داشت:
 *
 *   ۱. آرایهٔ `DEEP_ANALYSIS_LANGUAGES` با `deepAnalysisSupported: true`
 *   ۲. آرایهٔ `BASIC_LANGUAGES` با `deepAnalysisSupported: false`
 *   ۳. `switch` در `getSymbolExtractionMethod`
 *
 * چهار زبان (`html`, `css`, `scss`, `less`) در هر دو آرایه بودند. چون
 * `EXTENSION_MAP` به‌ترتیب پر می‌شد، تعریف دوم اولی را بازنویسی می‌کرد،
 * ولی `isDeepAnalysisSupported` از `.some()` استفاده می‌کرد و اولین
 * تعریفِ `true` را می‌دید. نتیجه دو جواب متضاد برای یک زبان بود.
 *
 * پاک کردن چهار entry تکراری این نمونه را می‌بست ولی *دسته* را نه. پس
 * ساختار عوض شد:
 *
 *   • هر زبان فقط `extractionMethod` را اعلام می‌کند؛
 *     `deepAnalysisSupported` دیگر نوشته نمی‌شود بلکه از همان مشتق
 *     می‌شود. دو فیلد که می‌توانستند اختلاف پیدا کنند، شدند یکی.
 *   • `getSymbolExtractionMethod` از جدول می‌خواند، نه از یک `switch`
 *     موازی.
 *   • `buildLanguageTable` هر id / پسوند / نام‌فایل / shebang تکراری را
 *     در همان لحظهٔ بارگذاری ماژول با استثنا رد می‌کند. تعریف دوباره
 *     دیگر «آخری برنده» نیست، خطاست.
 */

export type SymbolExtractionMethod =
  | 'lsp'
  | 'tree-sitter'
  | 'heuristic'
  | 'imperative'
  | 'declarative'
  | null;

/**
 * نشانه‌های کامنت و رشتهٔ یک زبان.
 *
 * SE-SCAN-16: این جدول تا فاز ۲۳ **دو بار** وجود داشت — یکی در
 * `FileProcessor.commentStyleFor` برای شمردن خطوط کامنت و یکی در
 * `LiteralMask` برای پوشاندن پیش از regex — و آن دو با هم نمی‌خواندند.
 * `LiteralMask` می‌گفت `#` در `shell`/`bash` کامنت است ولی در
 * `makefile`/`dockerfile` نه؛ `FileProcessor` عکسش. هیچ‌کدام هم
 * نمی‌دانستند `//` در Python تقسیم صحیح است (SE-SYM-33).
 *
 * نشانهٔ کامنت یک *خصوصیت زبان* است، پس جایش همین جدول است.
 */
export interface CommentSyntax {
  /** نشانه‌های کامنت تک‌خطی، مثل `//` یا `#`. */
  readonly line: readonly string[];
  /** جفت باز/بستهٔ کامنت بلوکی، اگر زبان داشته باشد. */
  readonly block?: readonly [string, string];
  /** رشتهٔ سه‌نقل‌قولی دارد؟ (`"""…"""` در Python) */
  readonly tripleQuoted?: boolean;
}

/**
 * چیزی که یک زبان دربارهٔ خودش اعلام می‌کند — ورودی جدول.
 * `deepAnalysisSupported` عمداً این‌جا نیست؛ مشتق است، نه اعلام‌شده.
 */
export interface LanguageDefinition {
  /** نام زبان (lowercase, مثل vscode.TextDocument.languageId) */
  readonly id: string;

  /** نام نمایشی */
  readonly displayName: string;

  /**
   * روش استخراج symbol ترجیحی. `null` یعنی زبان فقط شناسایی می‌شود.
   * توجه: این روش *ترجیحی* است؛ fallback chain در SymbolExtractorManager
   * مدیریت می‌شود.
   */
  readonly extractionMethod: SymbolExtractionMethod;

  /** پسوندهای مرتبط (بدون نقطه) */
  readonly extensions: readonly string[];

  /** نام‌های فایل خاص (مثل Dockerfile) */
  readonly filenames?: readonly string[];

  /**
   * الگوهای نام فایل با `*` — برای خانواده‌هایی مثل `tsconfig.*.json`
   * که فهرست کردن تک‌تکشان ممکن نیست.
   */
  readonly filenamePatterns?: readonly string[];

  /** شناسه‌های shebang مرتبط */
  readonly shebangs?: readonly string[];

  /**
   * نشانه‌های کامنت. اگر اعلام نشود، خانوادهٔ C فرض می‌شود
   * (`//` و `/* … *\/`) — که برای اکثر زبان‌های این جدول درست است.
   */
  readonly comments?: CommentSyntax;
}

/** یک زبان پس از ساخته شدن جدول — با فیلدهای مشتق. */
export interface LanguageInfo extends LanguageDefinition {
  /** آیا symbol extraction عمیق برای این زبان پشتیبانی می‌شود؟ */
  readonly deepAnalysisSupported: boolean;
  /** همیشه پر است — پیش‌فرض خانوادهٔ C اگر زبان چیزی اعلام نکرده باشد. */
  readonly comments: CommentSyntax;
}

/**
 * جدول‌های lookup ساخته‌شده از یک فهرست زبان.
 */
import { BASIC_LANGUAGES, C_FAMILY_COMMENTS, DEEP_ANALYSIS_LANGUAGES } from './languageDefinitions';

export interface LanguageTable {
  readonly languages: readonly LanguageInfo[];
  readonly byId: ReadonlyMap<string, LanguageInfo>;
  readonly byExtension: ReadonlyMap<string, LanguageInfo>;
  readonly byFilename: ReadonlyMap<string, LanguageInfo>;
  /** به ترتیب اعلام؛ اولین تطبیق برنده است. */
  readonly patterns: readonly { readonly pattern: RegExp; readonly language: LanguageInfo }[];
  readonly byShebang: ReadonlyMap<string, LanguageInfo>;
}

/** `tsconfig.*.json` → `/^tsconfig\..*\.json$/` */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.*+?^${}()|[\]\\]/g, ch => (ch === '*' ? '\u0000' : `\\${ch}`));
  return new RegExp(`^${escaped.split('\u0000').join('.*')}$`, 'i');
}

/**
 * ساخت جدول از فهرست زبان‌ها، با رد کردن هر تعریف متعارض.
 *
 * این تابع در زمان بارگذاری ماژول صدا زده می‌شود؛ یعنی یک تعریف تکراری
 * به‌جای خرابیِ خاموشِ «آخری برنده»، کل پکیج را در همان `require` اول
 * می‌ترکاند. برای تست هم صادر شده است.
 */
export function buildLanguageTable(definitions: readonly LanguageDefinition[]): LanguageTable {
  const byId = new Map<string, LanguageInfo>();
  const byExtension = new Map<string, LanguageInfo>();
  const byFilename = new Map<string, LanguageInfo>();
  const byShebang = new Map<string, LanguageInfo>();
  const patterns: { pattern: RegExp; language: LanguageInfo }[] = [];
  const seenPatterns = new Map<string, string>();

  const claim = <T>(
    map: Map<string, T>,
    key: string,
    value: LanguageInfo,
    what: string
  ): void => {
    const existing = map.get(key) as LanguageInfo | undefined;
    if (existing) {
      throw new Error(
        `languageMap: ${what} ${JSON.stringify(key)} is claimed by both ` +
          `"${existing.id}" and "${value.id}"`
      );
    }
    map.set(key, value as unknown as T);
  };

  for (const definition of definitions) {
    if (byId.has(definition.id)) {
      throw new Error(`languageMap: duplicate language id: ${definition.id}`);
    }

    const language: LanguageInfo = Object.freeze({
      ...definition,
      deepAnalysisSupported: definition.extractionMethod !== null,
      comments: definition.comments ?? C_FAMILY_COMMENTS,
    });
    byId.set(language.id, language);

    for (const extension of language.extensions) {
      claim(byExtension, extension.toLowerCase(), language, 'extension');
    }
    for (const filename of language.filenames ?? []) {
      claim(byFilename, filename.toLowerCase(), language, 'filename');
    }
    for (const shebang of language.shebangs ?? []) {
      claim(byShebang, shebang.toLowerCase(), language, 'shebang');
    }
    for (const glob of language.filenamePatterns ?? []) {
      const key = glob.toLowerCase();
      const owner = seenPatterns.get(key);
      if (owner) {
        throw new Error(
          `languageMap: filename pattern ${JSON.stringify(glob)} is claimed by both ` +
            `"${owner}" and "${language.id}"`
        );
      }
      seenPatterns.set(key, language.id);
      patterns.push({ pattern: globToRegExp(key), language });
    }
  }

  return { languages: [...byId.values()], byId, byExtension, byFilename, patterns, byShebang };
}

export const LANGUAGE_TABLE: LanguageTable = buildLanguageTable([
  ...DEEP_ANALYSIS_LANGUAGES,
  ...BASIC_LANGUAGES,
]);

/** تمام زبان‌ها */
export const ALL_LANGUAGES: readonly LanguageInfo[] = LANGUAGE_TABLE.languages;

// extension → LanguageInfo
export const EXTENSION_MAP: ReadonlyMap<string, LanguageInfo> = LANGUAGE_TABLE.byExtension;

// filename → LanguageInfo
export const FILENAME_MAP: ReadonlyMap<string, LanguageInfo> = LANGUAGE_TABLE.byFilename;

// shebang keyword → LanguageInfo
export const SHEBANG_MAP: ReadonlyMap<string, LanguageInfo> = LANGUAGE_TABLE.byShebang;

/**
 * تشخیص روش استخراج symbol ترجیحی برای یک زبان.
 *
 * از جدول می‌خواند. نسخهٔ قبلی یک `switch` جدا بود که می‌توانست — و
 * می‌کرد — با جدول اختلاف پیدا کند.
 */
export function getSymbolExtractionMethod(languageId: string): SymbolExtractionMethod {
  return LANGUAGE_TABLE.byId.get(languageId)?.extractionMethod ?? null;
}

/**
 * نشانه‌های کامنت یک زبان — تنها منبع، برای همهٔ مصرف‌کننده‌ها.
 *
 * زبان ناشناخته خانوادهٔ C می‌گیرد، همان رفتاری که هر دو جدولِ قبلی
 * داشتند.
 */
export function commentSyntaxFor(languageId: string | null | undefined): CommentSyntax {
  if (!languageId) return C_FAMILY_COMMENTS;
  return LANGUAGE_TABLE.byId.get(languageId.toLowerCase())?.comments ?? C_FAMILY_COMMENTS;
}
