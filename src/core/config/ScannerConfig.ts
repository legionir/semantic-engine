import {
  DEFAULT_IGNORE_DIRECTORIES,
  DEFAULT_IGNORE_FILE_PATTERNS,
  SKIP_HIDDEN_DIRECTORIES,
} from './defaultIgnorePatterns';

/**
 * تنظیمات WorkspaceScanner.
 *
 * طراحی: immutable config object + builder pattern.
 * هر فیلد default معقول دارد — کاربر فقط چیزهایی که می‌خواهد عوض کند را override می‌کند.
 */
export interface ScannerConfig {
  /** حداکثر اندازه فایل برای خواندن محتوا (بایت). فایل‌های بزرگ‌تر فقط metadata دارند. */
  readonly maxFileSizeBytes: number;

  /** پوشه‌های ignore (نام — نه glob) */
  readonly ignoreDirectories: readonly string[];

  /** الگوهای glob برای فایل‌های ignore */
  readonly ignoreFilePatterns: readonly string[];

  /** آیا پوشه‌های مخفی (شروع با نقطه) skip شوند؟ */
  readonly skipHiddenDirectories: boolean;

  /** الگوهای اضافی ignore از کاربر (ترکیب با پیش‌فرض‌ها) */
  readonly additionalIgnorePatterns: readonly string[];

  /** حداکثر عمق بازگشتی اسکن (0 = نامحدود) */
  readonly maxDepth: number;

  /** فعال‌سازی محاسبه‌ی metrics پایه (LOC, blank lines, ...) در فاز اسکن */
  readonly computeBasicMetrics: boolean;

  /** آیا از .gitignore پیروی شود؟ (پیش‌فرض: true) */
  readonly useGitignore: boolean;

  /**
   * چند فایل هم‌زمان پردازش شوند.
   *
   * SE-SCAN-06 — پردازش کاملاً ترتیبی بود. با I/O دیسک، یک استخر
   * محدود چند برابر سریع‌تر است و به determinism آسیبی نمی‌زند چون
   * خروجی از قبل مرتب می‌شود.
   */
  readonly concurrency: number;

  /**
   * پوشه‌های مخفی‌ای که با وجود `skipHiddenDirectories` ایندکس
   * می‌شوند.
   *
   * SE-SCAN-09 — نادیده گرفتن *همهٔ* پوشه‌های مخفی یعنی کل پیکربندی
   * CI از دید ابزاری که ادعای «درک پروژه» دارد پنهان می‌ماند.
   */
  readonly hiddenDirectoryAllowlist: readonly string[];

  /** پیمایش symlink پوشه‌ها (با تشخیص حلقه). */
  readonly followSymlinks: boolean;
}

/** مقادیر پیش‌فرض */
export const DEFAULT_SCANNER_CONFIG: ScannerConfig = {
  maxFileSizeBytes: 5 * 1024 * 1024, // 5MB
  ignoreDirectories: [...DEFAULT_IGNORE_DIRECTORIES],
  ignoreFilePatterns: [...DEFAULT_IGNORE_FILE_PATTERNS],
  skipHiddenDirectories: SKIP_HIDDEN_DIRECTORIES,
  additionalIgnorePatterns: [],
  maxDepth: 0,
  computeBasicMetrics: true,
  useGitignore: true,
  concurrency: 8,
  /*
  | `.vscode` عمداً اینجا نیست: در `DEFAULT_IGNORE_DIRECTORIES` به‌عنوان
  | «تنظیمات ادیتور» رد می‌شود. گذاشتنش در هر دو فهرست یعنی دو تنظیم
  | با هم مخالف باشند.
  */
  hiddenDirectoryAllowlist: [
    '.github', '.circleci', '.gitlab', '.husky', '.changeset', '.config',
  ],
  followSymlinks: true,
};

/**
 * ساخت config با override partial — فیلدهای ارائه‌نشده از default گرفته می‌شوند.
 */
export function createScannerConfig(overrides?: Partial<ScannerConfig>): ScannerConfig {
  if (!overrides) return DEFAULT_SCANNER_CONFIG;
  return { ...DEFAULT_SCANNER_CONFIG, ...overrides };
}
