/**
 * GitClient — اجرای دستورات git و استخراج اطلاعات پروژه.
 *
 * طراحی:
 * - اگر git در workspace موجود نباشد، به‌جای throw مقدار null برمی‌گرداند.
 * - تمام دستورات async و با child_process.exec هستند.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { sha256 } from '../utils/hash';

import { GitSource, readBranchAndChanges, readFileCommitStats, readRepositoryHistory } from './gitHistory';

const execFileAsync = promisify(execFile);

export interface GitStatusInfo {
  readonly trackedFiles: readonly string[];
  readonly modifiedFiles: readonly string[];
  readonly untrackedFiles: readonly string[];
  readonly stagedFiles: readonly string[];
  readonly isDirty: boolean;
}

export interface GitCommitInfo {
  readonly hash: string;
  readonly shortHash: string;
  readonly message: string;
  readonly author: string;
  readonly date: string;
}

export interface GitContributorInfo {
  readonly author: string;
  /** شناسهٔ پایدار — تجمیع بر اساس نام نمایشی نادرست است (SE-GIT-04). */
  readonly email: string;
  readonly commitCount: number;
}

export interface GitFileCommitStats {
  readonly commitCount: number;
  readonly lastCommit: GitCommitInfo | null;
  readonly contributors: readonly GitContributorInfo[];
}

/** خروجی یک پیمایش تاریخچه برای *کل* مخزن. */
export interface RepositoryHistory {
  /** مسیر فایل → آمار commitهایش. */
  readonly statsByPath: ReadonlyMap<string, GitFileCommitStats>;
  /** چند commit پیمایش شد. برای تشخیص برخورد با سقف. */
  readonly commitsScanned: number;
  /** آیا به سقف خوردیم و تاریخچه ناقص است. */
  readonly truncated: boolean;
}

export class GitClient {
  /**
   * شمار پروسه‌های `git` که تا حالا اجرا شده‌اند.
   *
   * یک پروسه به‌ازای هر فایل، گران‌ترین چیزی بود که ارزیابی پیدا کرد
   * (SE-PERF-01). بدون یک عدد، «بهتر شد» قابل اثبات نیست — و معیار
   * پذیرش این فاز خودش یک عدد است.
   */
  static processCount = 0;

  static resetProcessCount(): void {
    GitClient.processCount = 0;
  }

  private repositoryCache: { isRepository: boolean; prefix: string } | undefined;

  constructor(private readonly workspaceRoot: string) {}

  private source(): GitSource {
    return this;
  }

  /**
   * بررسی اینکه آیا دایرکتوری workspace تحت git است.
   */
  /**
   * آیا این پوشه یک مخزن git است.
   *
   * پاسخ کش می‌شود: در یک اسکن چند بار پرسیده می‌شود و جوابش وسط کار
   * عوض نمی‌شود.
   */
  async isGitRepository(): Promise<boolean> {
    return (await this.resolveRepository()).isRepository;
  }

  /**
   * مسیر کارگاه نسبت به ریشهٔ مخزن — مثلاً `semantic-engine/src/`.
   *
   * لازم است چون `git log --name-only` مسیرها را نسبت به **ریشهٔ
   * مخزن** می‌دهد، ولی فهرست فایل‌های اسکن نسبت به کارگاه است. وقتی
   * کارگاه یک زیرپوشه باشد، این دو هرگز با هم جور در نمی‌آیند.
   *
   * برای مخزنی که کارگاهش خودِ ریشه است، رشتهٔ خالی برمی‌گردد.
   */
  async getRepositoryPrefix(): Promise<string> {
    return (await this.resolveRepository()).prefix;
  }

  /**
   * یک `git rev-parse` که هر دو سؤال را با هم جواب می‌دهد.
   *
   * پاسخ کش می‌شود: در یک اسکن چند بار پرسیده می‌شود و وسط کار عوض
   * نمی‌شود.
   */
  private async resolveRepository(): Promise<{ isRepository: boolean; prefix: string }> {
    if (this.repositoryCache) return this.repositoryCache;

    try {
      const output = await this.execGit(['rev-parse', '--git-dir', '--show-prefix']);
      const lines = output.split('\n');
      this.repositoryCache = {
        isRepository: true,
        prefix: (lines[1] ?? '').trim(),
      };
    } catch {
      this.repositoryCache = { isRepository: false, prefix: '' };
    }

    return this.repositoryCache;
  }

  /**
   * شاخه و وضعیت کاری با **یک** فراخوانی.
   *
   * `git status -b --porcelain` سطر اول را به شاخه اختصاص می‌دهد و
   * بقیه را به فایل‌های تغییرکرده. سه چیزی که مسیر جمع‌آوری لازم
   * دارد — نام شاخه، dirty بودن، و فهرست مسیرهای تغییرکرده — همه در
   * همین یک خروجی هستند (SE-PERF-01).
   */
  async getBranchAndChanges(): Promise<{
    branch: string | null;
    changedPaths: Set<string>;
    isDirty: boolean;
  }> {
    return readBranchAndChanges(this.source());
  }

  /**
   * آخرین commit فعلی branch.
   */
  async getCurrentCommit(): Promise<GitCommitInfo | null> {
    try {
      const format = '%H|%h|%s|%an|%aI';
      const output = await this.execGit(['log', '-1', `--format=${format}`]);
      const [hash, shortHash, message, author, date] = output.split('|');
      if (!hash) return null;
      return {
        hash: hash.trim(),
        shortHash: (shortHash ?? hash.slice(0, 7)).trim(),
        message: (message ?? '').trim(),
        author: (author ?? '').trim(),
        date: (date ?? new Date().toISOString()).trim(),
      };
    } catch {
      return null;
    }
  }

  /**
   * نام branch فعلی.
   */
  async getCurrentBranch(): Promise<string | null> {
    try {
      const output = await this.execGit(['rev-parse', '--abbrev-ref', 'HEAD']);
      const branch = output.trim();
      return branch || null;
    } catch {
      return null;
    }
  }

  /**
   * آدرس remote اصلی (origin) یا null.
   */
  async getRemoteUrl(): Promise<string | null> {
    try {
      const output = await this.execGit(['remote', 'get-url', 'origin']);
      return output.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * لیست تمام فایل‌های tracked در repository.
   */
  async getTrackedFiles(): Promise<readonly string[]> {
    try {
      const output = await this.execGit(['ls-files', '-z']);
      return this.splitNul(output);
    } catch {
      return [];
    }
  }

  /**
   * وضعیت فعلی working tree.
   */
  async getStatus(): Promise<GitStatusInfo> {
    try {
      const [trackedFiles, porcelain] = await Promise.all([
        this.getTrackedFiles(),
        this.execGit(['status', '--porcelain', '-uall', '-z']),
      ]);

      const modifiedFiles: string[] = [];
      const untrackedFiles: string[] = [];
      const stagedFiles: string[] = [];

      /*
      | با -z هر رکورد این شکل است:  XY SP <path> NUL
      | و برای rename/copy یک مسیر دوم هم می‌آید:
      |     XY SP <new> NUL <old> NUL
      | پس نمی‌شود صرفاً روی NUL split کرد و هر تکه را یک رکورد گرفت؛
      | باید بعد از R یا C یک تکهٔ اضافه مصرف شود.
      */

      const records = porcelain.split('\0');

      for (let i = 0; i < records.length; i++) {
        const record = records[i]!;
        if (record.length < 3) continue;

        const indexStatus = record[0]!;
        const workTreeStatus = record[1]!;
        const filePath = record.slice(3);

        if (indexStatus === 'R' || indexStatus === 'C') {
          // مسیر قدیمی رکورد بعدی است و رکورد مستقلی نیست
          i++;
        }

        if (indexStatus === '?' && workTreeStatus === '?') {
          untrackedFiles.push(filePath);
          continue;
        }

        if (indexStatus !== ' ' && indexStatus !== '?') {
          stagedFiles.push(filePath);
        }

        if (workTreeStatus !== ' ' && workTreeStatus !== '?') {
          modifiedFiles.push(filePath);
        }
      }

      return {
        trackedFiles,
        modifiedFiles,
        untrackedFiles,
        stagedFiles,
        isDirty: modifiedFiles.length > 0 || stagedFiles.length > 0 || untrackedFiles.length > 0,
      };
    } catch {
      return {
        trackedFiles: [],
        modifiedFiles: [],
        untrackedFiles: [],
        stagedFiles: [],
        isDirty: false,
      };
    }
  }

  /**
   * لیست فایل‌هایی که از آخرین commit تغییر کرده‌اند.
   * شامل modified/untracked/staged.
   */
  async getChangedFilesSince(commit: string): Promise<readonly string[]> {
    try {
      /*
      | دو‌نقطه، نه سه‌نقطه. سه‌نقطه تفاوت متقارن از merge-base است و به
      | سؤال «از این commit به بعد چه چیزی عوض شده» جواب نمی‌دهد.
      */
      const output = await this.execGit(['diff', '--name-only', '-z', `${commit}..HEAD`]);
      return this.splitNul(output);
    } catch {
      return [];
    }
  }

  /**
   * تاریخچه‌ی commit های اخیر.
   */
  async getLog(limit: number = 10): Promise<GitCommitInfo[]> {
    try {
      const format = '%H|%h|%s|%an|%aI';
      const output = await this.execGit(['log', `-${limit}`, `--format=${format}`]);
      return output
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
          const [hash, shortHash, message, author, date] = line.split('|');
          return {
            hash: hash!,
            shortHash: shortHash ?? hash!.slice(0, 7),
            message: message ?? '',
            author: author ?? '',
            date: date ?? '',
          };
        });
    } catch {
      return [];
    }
  }

  /**
   * تاریخچه‌ی commit های یک فایل خاص.
   */
  async getFileLog(relativePath: string, limit: number = 10): Promise<GitCommitInfo[]> {
    try {
      const format = '%H|%h|%s|%an|%aI';
      const output = await this.execGit(['log', `-${limit}`, `--format=${format}`, '--', relativePath]);
      return output
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
          const [hash, shortHash, message, author, date] = line.split('|');
          return {
            hash: hash!,
            shortHash: shortHash ?? hash!.slice(0, 7),
            message: message ?? '',
            author: author ?? '',
            date: date ?? '',
          };
        });
    } catch {
      return [];
    }
  }

  /**
   * آمار commit همهٔ فایل‌ها با **یک** فراخوانی git — SE-PERF-01.
   *
   * نسخهٔ قبلی به‌ازای هر فایل یک `git log` می‌زد. روی همین مخزن با
   * ۴۹۹ فایل، اندازه‌گیری‌شده: ۵۰۰ پروسه و ۱٫۹ ثانیه.
   *
   * `--name-only` نام فایل‌های هر commit را در همان خروجی می‌دهد، پس
   * یک پیمایش تاریخچه برای همهٔ فایل‌ها کافی است.
   *
   * `maxCommits` سقف دارد چون تاریخچهٔ کامل یک مخزن قدیمی می‌تواند
   * ده‌ها مگابایت باشد. نتیجه در آن حالت `truncated` علامت می‌خورد —
   * شمارش تا افق پیمایش درست است، نه مطلق.
   */
  async getRepositoryHistory(maxCommits: number = 2000): Promise<RepositoryHistory> {
    return readRepositoryHistory(this.source(), maxCommits);
  }

  /**
   * مسیرهایی که نسبت به HEAD تفاوت دارند — با **یک** فراخوانی.
   *
   * SE-PERF-01: نسخهٔ قبلی به‌ازای هر فایل یک `git show HEAD:<path>`
   * می‌زد و محتوای کامل را دو بار hash می‌کرد. اندازه‌گیری‌شده روی
   * ۴۹۹ فایل: ۵۰۵ پروسه و ۱٫۸ ثانیه — برای جوابی که خودِ git با یک
   * دستور می‌دهد.
   */
  async getChangedPathsSinceHead(): Promise<Set<string>> {
    const changed = new Set<string>();

    try {
      /*
      | `git status` هر سه حالت را با هم می‌دهد: تغییر یافته، staged
      | شده، حذف‌شده و untracked. `git diff HEAD` فقط tracked را
      | می‌دهد و فایل جدید را از قلم می‌اندازد.
      */
      const output = await this.execGit(['status', '--porcelain', '-z', '--untracked-files=all']);

      for (const entry of output.split('\u0000')) {
        if (entry.length < 4) continue;
        // قالب: XY<space>path
        changed.add(entry.slice(3));
      }
    } catch {
      return changed;
    }

    return changed;
  }

  /**
   * آمار commit های یک فایل خاص: تعداد، آخرین commit، و contributors.
   */
  async getFileCommitStats(relativePath: string, limit: number = 200): Promise<GitFileCommitStats> {
    return readFileCommitStats(this.source(), relativePath, limit);
  }

  /**
   * محتوای یک فایل در commit خاص.
   */
  async getFileContentAtCommit(relativePath: string, commit: string = 'HEAD'): Promise<string | null> {
    try {
      const output = await this.execGit(['show', `${commit}:${relativePath}`]);
      return output;
    } catch {
      return null;
    }
  }

  /**
   * hash محتوای یک فایل در commit خاص.
   */
  async getFileHashAtCommit(relativePath: string, commit: string = 'HEAD'): Promise<string | null> {
    try {
      const output = await this.execGit(['show', `${commit}:${relativePath}`], true);
      return output;
    } catch {
      return null;
    }
  }

  /**
   * اجرای git بدون shell.
   *
   * پیش‌تر آرگومان‌ها داخل یک رشتهٔ shell قرار می‌گرفتند و فقط `"` escape
   * می‌شد. اما پوستهٔ POSIX داخل double-quote هنوز `$(...)` و backtick را
   * بسط می‌دهد، یعنی یک نام فایل کافی بود تا فرمان دلخواه اجرا شود.
   *
   * execFile آرایهٔ آرگومان را مستقیم به پروسه می‌دهد؛ هیچ پوسته‌ای در
   * میان نیست، پس هیچ چیزی برای بسط دادن هم نیست.
   */
  async execGit(args: string[], returnRawBuffer: boolean = false): Promise<string> {
    GitClient.processCount++;

    const { stdout } = await execFileAsync('git', args, {
      cwd: this.workspaceRoot,
      encoding: returnRawBuffer ? 'buffer' : 'utf8',
      maxBuffer: 10 * 1024 * 1024, // 10MB
      windowsHide: true,
    });

    if (returnRawBuffer && Buffer.isBuffer(stdout)) {
      return sha256(stdout);
    }

    return stdout as string;
  }

  /**
   * تقسیم خروجی NUL-جدا شده.
   *
   * فرم متنی git مسیرهای غیر‌ASCII را quote و escape می‌کند و مسیرهای
   * دارای فاصله را مبهم می‌گذارد. با `-z` مسیر خام می‌آید و هیچ تجزیه‌ای
   * لازم نیست.
   */
  private splitNul(output: string): string[] {
    return output.split('\0').filter(part => part.length > 0);
  }
}
