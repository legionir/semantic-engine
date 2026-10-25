/**
 * Static language definitions (data only) — split from languageMap.ts, unchanged.
 */

import type { CommentSyntax, LanguageDefinition } from './languageMap';

/** خانوادهٔ C — پیش‌فرض هر زبانی که خلافش را اعلام نکند. */
export const C_FAMILY_COMMENTS: CommentSyntax = { line: ['//'], block: ['/*', '*/'] };

/** زبانی که اصلاً کامنت ندارد. */
export const NO_COMMENTS: CommentSyntax = { line: [] };

export const HASH_COMMENTS: CommentSyntax = { line: ['#'] };

/**
 * زبان‌های با پشتیبانی عمیق (LSP + tree-sitter + heuristic)
 */
export const DEEP_ANALYSIS_LANGUAGES: readonly LanguageDefinition[] = [
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
export const BASIC_LANGUAGES: readonly LanguageDefinition[] = [
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
