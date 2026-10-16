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

/** خانوادهٔ C — پیش‌فرض هر زبانی که خلافش را اعلام نکند. */
const C_FAMILY_COMMENTS: CommentSyntax = { line: ['//'], block: ['/*', '*/'] };

/** زبانی که اصلاً کامنت ندارد. */
const NO_COMMENTS: CommentSyntax = { line: [] };

const HASH_COMMENTS: CommentSyntax = { line: ['#'] };

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
 * زبان‌های با پشتیبانی عمیق (LSP + tree-sitter + heuristic)
 */
const DEEP_ANALYSIS_LANGUAGES: readonly LanguageDefinition[] = [
  {
    id: 'typescript',
    displayName: 'TypeScript',
    extractionMethod: 'lsp',
    extensions: ['ts', 'mts', 'cts'],
  },
  {
    id: 'typescriptreact',
    displayName: 'TypeScript React',
    extractionMethod: 'lsp',
    extensions: ['tsx'],
  },
  {
    id: 'javascript',
    displayName: 'JavaScript',
    extractionMethod: 'lsp',
    extensions: ['js', 'mjs', 'cjs'],
    shebangs: ['node', 'nodejs'],
  },
  {
    id: 'javascriptreact',
    displayName: 'JavaScript React',
    extractionMethod: 'lsp',
    extensions: ['jsx'],
  },
  {
    id: 'python',
    displayName: 'Python',
    extractionMethod: 'heuristic',
    extensions: ['py', 'pyw', 'pyi'],
    shebangs: ['python', 'python3'],
    /*
    | SE-SYM-33: `//` در Python تقسیم صحیح است. هر دو جدولِ قبلی آن را
    | کامنت می‌گرفتند، پس `a // b or c` به `a` تبدیل می‌شد و `or` از
    | شمارش پیچیدگی می‌افتاد.
    */
    comments: { line: ['#'], tripleQuoted: true },
  },
  {
    id: 'go',
    displayName: 'Go',
    extractionMethod: 'heuristic',
    extensions: ['go'],
  },
  {
    id: 'php',
    displayName: 'PHP',
    extractionMethod: 'heuristic',
    extensions: ['php', 'phtml', 'php3', 'php4', 'php5', 'phps'],
    shebangs: ['php'],
    /* PHP هر سه شکل را می‌پذیرد؛ `#` را هیچ‌کدام از دو جدول قبلی نداشت. */
    comments: { line: ['//', '#'], block: ['/*', '*/'] },
  },
  {
    id: 'shellscript',
    displayName: 'Shell Script',
    extractionMethod: 'heuristic',
    extensions: ['sh', 'bash', 'zsh'],
    shebangs: ['bash', 'sh', 'zsh'],
    comments: HASH_COMMENTS,
  },
  {
    id: 'java',
    displayName: 'Java',
    extractionMethod: 'imperative',
    extensions: ['java'],
  },
  {
    id: 'rust',
    displayName: 'Rust',
    extractionMethod: 'imperative',
    extensions: ['rs'],
  },
  {
    id: 'csharp',
    displayName: 'C#',
    extractionMethod: 'imperative',
    extensions: ['cs'],
  },
  {
    id: 'c',
    displayName: 'C',
    extractionMethod: 'imperative',
    extensions: ['c', 'h'],
  },
  {
    id: 'cpp',
    displayName: 'C++',
    extractionMethod: 'imperative',
    extensions: ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx'],
  },
  {
    id: 'ruby',
    displayName: 'Ruby',
    extractionMethod: 'imperative',
    extensions: ['rb'],
    shebangs: ['ruby'],
    /* `/` در Ruby تقسیم و شروع regex است، نه کامنت. */
    comments: HASH_COMMENTS,
  },
  {
    id: 'swift',
    displayName: 'Swift',
    extractionMethod: 'imperative',
    extensions: ['swift'],
  },
  {
    id: 'kotlin',
    displayName: 'Kotlin',
    extractionMethod: 'imperative',
    extensions: ['kt', 'kts'],
  },
  {
    id: 'json',
    displayName: 'JSON',
    extractionMethod: 'declarative',
    extensions: ['json'],
    /* JSON سخت‌گیرانه اصلاً کامنت ندارد — همان چیزی که SE-SCAN-12 بود. */
    comments: NO_COMMENTS,
    /*
    | فقط نام‌هایی که واقعاً JSON سخت‌گیرانه‌اند. `package.json` کامنت
    | نمی‌پذیرد (npm ردش می‌کند)، پس این‌جا می‌ماند؛ `tsconfig.json`
    | می‌پذیرد، پس رفته زیر `jsonc`.
    */
    filenames: ['package.json', 'package-lock.json', 'composer.lock'],
  },
  {
    /*
    | SE-SCAN-12: تا امروز `.jsonc` و `.json5` پسوندهای زبانِ `json`
    | بودند، یعنی id ای که به استخراج‌گر می‌رسید همیشه `'json'` بود.
    | استخراج‌گر هم کامنت را فقط وقتی مجاز می‌دانست که id برابر
    | `'jsonc'` یا `'json5'` باشد — شرطی که هیچ فایل واقعی برآورده‌اش
    | نمی‌کرد. VS Code هم `jsonc` را زبان جدا می‌داند.
    */
    id: 'jsonc',
    displayName: 'JSON with Comments',
    extractionMethod: 'declarative',
    extensions: ['jsonc'],
    filenames: [
      'tsconfig.json',
      'jsconfig.json',
      '.eslintrc.json',
      '.babelrc',
      '.babelrc.json',
      'babel.config.json',
      '.swcrc',
      'typedoc.json',
    ],
    filenamePatterns: ['tsconfig.*.json', 'jsconfig.*.json'],
  },
  {
    id: 'json5',
    displayName: 'JSON5',
    extractionMethod: 'declarative',
    extensions: ['json5'],
  },
  {
    id: 'html',
    displayName: 'HTML',
    extractionMethod: 'declarative',
    extensions: ['html', 'htm', 'xhtml'],
    comments: { line: [], block: ['<!--', '-->'] },
  },
  {
    id: 'css',
    displayName: 'CSS',
    extractionMethod: 'declarative',
    extensions: ['css'],
    /* CSS خالص `//` ندارد؛ فقط SCSS و Less دارند. */
    comments: { line: [], block: ['/*', '*/'] },
  },
  {
    id: 'scss',
    displayName: 'SCSS',
    extractionMethod: 'declarative',
    extensions: ['scss'],
  },
  {
    id: 'less',
    displayName: 'Less',
    extractionMethod: 'declarative',
    extensions: ['less'],
  },
];

/**
 * زبان‌هایی که شناسایی می‌شوند اما symbol extraction ندارند.
 *
 * `html`/`css`/`scss`/`less` عمداً این‌جا نیستند — تعریف دومشان همان
 * SE-SCAN-05 بود.
 */
const BASIC_LANGUAGES: readonly LanguageDefinition[] = [
  {
    id: 'yaml',
    displayName: 'YAML',
    extractionMethod: null,
    extensions: ['yml', 'yaml'],
    comments: HASH_COMMENTS,
  },
  {
    id: 'markdown',
    displayName: 'Markdown',
    extractionMethod: null,
    extensions: ['md', 'mdx'],
    comments: { line: [], block: ['<!--', '-->'] },
  },
  {
    id: 'dockerfile',
    displayName: 'Dockerfile',
    extractionMethod: null,
    extensions: [],
    filenames: ['Dockerfile'],
    filenamePatterns: ['Dockerfile.*', '*.Dockerfile'],
    comments: HASH_COMMENTS,
  },
  {
    id: 'sql',
    displayName: 'SQL',
    extractionMethod: null,
    extensions: ['sql'],
    comments: { line: ['--'], block: ['/*', '*/'] },
  },
  {
    id: 'graphql',
    displayName: 'GraphQL',
    extractionMethod: null,
    extensions: ['graphql', 'gql'],
    comments: HASH_COMMENTS,
  },
  {
    id: 'xml',
    displayName: 'XML',
    extractionMethod: null,
    extensions: ['xml', 'xsl', 'xslt', 'svg'],
    comments: { line: [], block: ['<!--', '-->'] },
  },
  {
    id: 'toml',
    displayName: 'TOML',
    extractionMethod: null,
    extensions: ['toml'],
    comments: HASH_COMMENTS,
  },
  {
    id: 'ini',
    displayName: 'INI',
    extractionMethod: null,
    extensions: ['ini', 'cfg', 'conf'],
    comments: { line: [';', '#'] },
  },
  {
    id: 'env',
    displayName: 'Environment',
    extractionMethod: null,
    extensions: ['env'],
    filenames: ['.env'],
    filenamePatterns: ['.env.*'],
    comments: HASH_COMMENTS,
  },
];

/**
 * جدول‌های lookup ساخته‌شده از یک فهرست زبان.
 */
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
