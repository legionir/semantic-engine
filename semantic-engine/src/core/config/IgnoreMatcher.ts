/**
 * IgnoreMatcher — یک تصمیم دربارهٔ «این مسیر نادیده گرفته می‌شود؟» — MIG-42.
 *
 * ── SE-SCAN-03 ────────────────────────────────────────────────────
 *
 * این منطق **دو بار** وجود داشت و آن دو با هم نمی‌خواندند:
 *
 *   • `WorkspaceScanner` — پیش‌فرض‌ها، `.gitignore`، الگوهای افزوده،
 *     پوشهٔ مخفی با allowlist.
 *   • `extension.ts:shouldWatch` — چهار regex دستی:
 *     `node_modules`, `.git`, `.semantic-engine`, `.vscode`.
 *
 * یعنی watcher فایل‌های `dist/`, `build/`, `coverage/`, `out/`,
 * `target/` را رصد می‌کرد و incremental آن‌ها را **به ایندکس اضافه
 * می‌کرد**، در حالی که اسکن کامل هرگز نمی‌دیدشان. ایندکس به‌مرور با
 * خروجی build آلوده می‌شد و یک اسکن کامل بعدی ناگهان همه را حذف
 * می‌کرد — و آن حذف، برای هر مصرف‌کننده‌ای شبیه «کاربر فایل‌ها را
 * پاک کرد» به نظر می‌رسید.
 *
 * همان الگوی SE-SCAN-05 و SE-SCAN-16: چند منبع حقیقت موازی. راه‌حل
 * هم همان است — یک جا، و همه از آن بخوانند.
 */

import * as path from 'path';
import { Minimatch } from 'minimatch';
import { ScannerConfig } from './ScannerConfig';
import { parseGitignore, mergeGitignorePatterns } from './gitignoreParser';

export interface IgnoreMatcherOptions {
  readonly workspaceRoot: string;
  readonly config: ScannerConfig;
  /**
   * پوشهٔ خروجی — SE-SCAN-17. اگر داخل کارگاه باشد، نادیده گرفته
   * می‌شود، وگرنه موتور خروجی خودش را ایندکس می‌کند.
   */
  readonly outputDir?: string | undefined;
}

/** همیشه اسلش رو به جلو، تا الگوها روی ویندوز هم کار کنند. */
export function normalizeSeparators(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

/*
| `minimatch(path, pattern, opts)` parses the pattern on every call. The scanner
| tests every file against every pattern, so patterns are compiled once and reused
| (same options, same result as the one-shot function).
*/
const GLOB_OPTIONS = { dot: true, nocase: true } as const;
const compiledGlobs = new Map<string, Minimatch>();

function globMatch(target: string, pattern: string): boolean {
  let matcher = compiledGlobs.get(pattern);
  if (!matcher) {
    matcher = new Minimatch(pattern, GLOB_OPTIONS);
    compiledGlobs.set(pattern, matcher);
  }
  return matcher.match(target);
}

/**
 * تطبیق یک الگوی سبک gitignore با یک مسیر نسبی.
 *
 * SE-SCAN-02 — الگوها به `minimatch` داده می‌شدند ولی فقط با نام پایه
 * مقایسه می‌شدند. `src/generated/*.ts` هرگز match نمی‌شد، و `/dist/`
 * که فقط ریشه را هدف می‌گیرد، هر پوشهٔ `dist` در هر عمقی را می‌برد.
 */
export function matchesPath(relativePath: string, pattern: string): boolean {
  const target = normalizeSeparators(relativePath);
  let raw = normalizeSeparators(pattern);

  const anchored = raw.startsWith('/');
  if (anchored) raw = raw.slice(1);

  const directoryOnly = raw.endsWith('/');
  if (directoryOnly) raw = raw.slice(0, -1);
  if (!raw) return false;

  const candidates = anchored ? [raw] : [raw, `**/${raw}`];

  for (const candidate of candidates) {
    if (globMatch(target, candidate)) return true;
    // یک الگوی پوشه‌ای، همهٔ چیزهای زیرش را هم می‌گیرد
    if (globMatch(target, `${candidate}/**`)) return true;
  }

  return false;
}

export class IgnoreMatcher {
  private readonly config: ScannerConfig;
  private readonly ignoreDirectories: readonly string[];
  private readonly ignoreFilePatterns: readonly string[];
  private readonly negationPatterns: readonly string[];
  /** مسیر نسبی پوشهٔ خروجی، اگر داخل کارگاه باشد. */
  private readonly outputRelative: string | null;

  constructor(options: IgnoreMatcherOptions) {
    this.config = options.config;

    let directories = [...options.config.ignoreDirectories];
    let filePatterns = [...options.config.ignoreFilePatterns];
    let negations: string[] = [];

    if (options.config.useGitignore) {
      const gitignore = parseGitignore(path.join(options.workspaceRoot, '.gitignore'));
      if (gitignore) {
        const merged = mergeGitignorePatterns(
          { ignoreDirectories: directories, ignoreFilePatterns: filePatterns },
          gitignore
        );
        directories = merged.ignoreDirectories;
        filePatterns = merged.ignoreFilePatterns;
        negations = gitignore.negationPatterns;
      }
    }

    this.ignoreDirectories = directories;
    this.ignoreFilePatterns = filePatterns;
    this.negationPatterns = negations;

    this.outputRelative = resolveOutputRelative(options.workspaceRoot, options.outputDir);
  }

  /**
   * آیا این پوشه — و همهٔ زیردرختش — نادیده گرفته می‌شود؟
   */
  ignoresDirectory(dirName: string, relativePath: string): boolean {
    /*
    | SE-SCAN-09 — پوشهٔ مخفی به‌طور پیش‌فرض رد می‌شود، مگر آن‌هایی
    | که واقعاً محتوای پروژه‌اند: پیکربندی CI، هوک‌ها، تنظیمات
    | ویرایشگر.
    */
    if (this.config.skipHiddenDirectories && dirName.startsWith('.') && dirName !== '.') {
      if (!this.config.hiddenDirectoryAllowlist.includes(dirName)) return true;
    }

    // `.git` هیچ‌وقت محتوای پروژه نیست
    if (dirName === '.git') return true;

    if (this.isOutput(relativePath)) return true;

    for (const negation of this.negationPatterns) {
      const bare = negation.endsWith('/') ? negation.slice(0, -1) : negation;
      if (bare === dirName || matchesPath(relativePath, bare)) return false;
    }

    if (this.ignoreDirectories.includes(dirName)) return true;

    return this.matchesIgnorePattern(relativePath, true);
  }

  /**
   * آیا این فایل نادیده گرفته می‌شود؟ (فقط خود فایل، نه پوشه‌هایش)
   */
  ignoresFile(fileName: string, relativePath: string): boolean {
    if (this.isOutput(relativePath)) return true;
    if (!this.matchesIgnorePattern(relativePath, false, fileName)) return false;

    for (const negation of this.negationPatterns) {
      if (
        matchesPath(relativePath, negation) ||
        globMatch(fileName, negation)
      ) {
        return false;
      }
    }

    return true;
  }

  /**
   * آیا این مسیر — به‌خاطر خودش **یا هر پوشه‌ای در راهش** — نادیده
   * گرفته می‌شود؟
   *
   * اسکنر درخت را پیمایش می‌کند و به پوشهٔ ignore شده اصلاً وارد
   * نمی‌شود، پس هرگز به این سؤال نیاز ندارد. watcher مسیر را یک‌جا
   * تحویل می‌گیرد و باید همان نتیجه را بگیرد — وگرنه دقیقاً همان
   * واگرایی SE-SCAN-03 برمی‌گردد.
   */
  ignoresPath(relativePath: string): boolean {
    const normalized = normalizeSeparators(relativePath);
    if (!normalized || normalized.startsWith('..')) return true;

    const segments = normalized.split('/').filter(Boolean);
    if (segments.length === 0) return true;

    for (let index = 0; index < segments.length - 1; index++) {
      const prefix = segments.slice(0, index + 1).join('/');
      if (this.ignoresDirectory(segments[index]!, prefix)) return true;
    }

    return this.ignoresFile(segments[segments.length - 1]!, normalized);
  }

  private isOutput(relativePath: string): boolean {
    if (!this.outputRelative) return false;
    const normalized = normalizeSeparators(relativePath);
    return normalized === this.outputRelative || normalized.startsWith(`${this.outputRelative}/`);
  }

  private matchesIgnorePattern(
    relativePath: string,
    isDirectory: boolean,
    fileName?: string
  ): boolean {
    const patterns = [...this.ignoreFilePatterns, ...this.config.additionalIgnorePatterns];

    for (const pattern of patterns) {
      if (matchesPath(relativePath, pattern)) return true;

      // الگوی بدون مسیر همچنان با نام پایه مقایسه می‌شود
      if (!isDirectory && fileName && !pattern.includes('/')) {
        if (globMatch(fileName, pattern)) return true;
      }
    }

    return false;
  }
}

function resolveOutputRelative(
  workspaceRoot: string,
  outputDir: string | undefined
): string | null {
  if (!outputDir) return null;
  const relative = normalizeSeparators(path.relative(workspaceRoot, path.resolve(outputDir)));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative;
}
