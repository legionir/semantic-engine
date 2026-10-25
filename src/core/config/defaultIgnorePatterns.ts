/**
 * الگوهای ignore پیش‌فرض.
 *
 * این لیست از رایج‌ترین پوشه‌ها/فایل‌هایی که نباید اسکن شوند تشکیل شده.
 * قابل override توسط کاربر در ScannerConfig.
 */

/** پوشه‌هایی که کلاً skip می‌شوند (نه محتوایشان، خود پوشه) */
export const DEFAULT_IGNORE_DIRECTORIES: readonly string[] = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  'vendor',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.parcel-cache',
  '__pycache__',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  'target',         // Rust/Java
  '.gradle',
  '.idea',
  '.vscode',        // تنظیمات ادیتور
  '.vs',
  '.semantic-engine', // خروجی‌های این extension
];

/** الگوهای glob برای فایل‌هایی که skip می‌شوند */
export const DEFAULT_IGNORE_FILE_PATTERNS: readonly string[] = [
  '*.min.js',
  '*.min.css',
  '*.map',          // source maps
  '*.lock',         // lock files
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  '*.log',
  '.DS_Store',
  'Thumbs.db',
  '*.swp',
  '*.swo',
  '*~',
];

/** پوشه‌هایی که با نقطه شروع می‌شوند (hidden directories) به‌صورت پیش‌فرض skip می‌شوند */
export const SKIP_HIDDEN_DIRECTORIES = true;
