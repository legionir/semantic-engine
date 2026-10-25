/**
 * GitInfoCollector — جمع‌آوری GitInfo برای project-index و driftScore برای blueprint.
 */

import { GitClient } from './GitClient';
import { GitInfo, GitFileMetrics } from '../types/project-index.types';

export interface GitCollectionResult {
  readonly gitInfo: GitInfo | null;
  readonly driftScore: number;
  readonly driftedFilePaths: readonly string[];
}

export interface FileGitMetricsResult {
  readonly metricsByPath: ReadonlyMap<string, GitFileMetrics>;
  readonly maxCommitCount: number;
}

export class GitInfoCollector {
  /**
   * یک client مشترک بین `collect` و `collectFileMetrics`.
   *
   * هر متد قبلاً client خودش را می‌ساخت، پس `isGitRepository` دو بار
   * پرسیده می‌شد. با اشتراک‌گذاری، پاسخ کش‌شده یک بار گرفته می‌شود —
   * که وقتی هدف «کل اسکن حداکثر ۵ پروسه» است، اهمیت پیدا می‌کند.
   */
  private readonly client: GitClient;

  constructor(private readonly workspaceRoot: string) {
    this.client = new GitClient(this.workspaceRoot);
  }

  async collect(filePaths: readonly string[]): Promise<GitCollectionResult> {
    const client = this.client;
    const isRepo = await client.isGitRepository();

    if (!isRepo) {
      return {
        gitInfo: null,
        driftScore: 0,
        driftedFilePaths: [],
      };
    }

    /*
    | سه فراخوانی، نه پنج‌تا. `getBranchAndChanges` شاخه، dirty بودن و
    | فهرست مسیرهای تغییرکرده را با یک `git status -b --porcelain`
    | می‌دهد؛ قبلاً این سه چیز سه دستور جدا بودند و drift هم یک
    | `git show` به‌ازای *هر فایل*.
    */
    const [commit, remoteUrl, working] = await Promise.all([
      client.getCurrentCommit(),
      client.getRemoteUrl(),
      client.getBranchAndChanges(),
    ]);
    const branch = working.branch;

    if (!commit || !branch) {
      return {
        gitInfo: null,
        driftScore: 0,
        driftedFilePaths: [],
      };
    }

    const gitInfo: GitInfo = {
      commit: commit.hash,
      branch,
      isDirty: working.isDirty,
      remoteUrl,
    };

    /*
    | مخرج، تعداد فایل‌های *اسکن‌شده* است نه کل فایل‌های tracked مخزن.
    |
    | دو دلیل. اول اینکه سؤال معنادار «چه کسری از کدی که ایندکس کرده‌ام
    | از HEAD فاصله گرفته» است، نه کسری از چیزهایی که اصلاً ایندکس
    | نشده‌اند. دوم اینکه شمردن کل tracked یک `git ls-files` جداگانه
    | می‌خواست — یک پروسهٔ دیگر برای عددی که اینجا مخرج بهتری هم
    | نیست.
    */
    const driftedFilePaths = filePaths.filter(path => working.changedPaths.has(path));
    const driftScore = filePaths.length > 0 ? driftedFilePaths.length / filePaths.length : 0;

    return {
      gitInfo,
      driftScore,
      driftedFilePaths,
    };
  }

  /**
   * جمع‌آوری متریک‌های git سطح فایل: commit count، last commit، contributors، hotspot score.
   * Hotspot = churn × complexity. چون پیچیدگی را اینجا نداریم، از commitCount نرمال‌شده استفاده می‌کنیم.
   */
  async collectFileMetrics(
    filePaths: readonly string[],
    fileComplexityByPath?: ReadonlyMap<string, number>
  ): Promise<FileGitMetricsResult> {
    const client = this.client;
    const isRepo = await client.isGitRepository();

    if (!isRepo) {
      return { metricsByPath: new Map(), maxCommitCount: 0 };
    }

    const entries: { path: string; commitCount: number; metrics: GitFileMetrics }[] = [];
    let maxCommitCount = 0;

    /*
    | SE-PERF-01 — یک پیمایش تاریخچه برای کل مخزن، به‌جای یک
    | `git log` به‌ازای هر فایل. اندازه‌گیری‌شده روی این مخزن با ۴۹۹
    | فایل: ۵۰۰ پروسه و ۱٫۹ ثانیه، برای داده‌ای که در یک فراخوانی
    | جا می‌شود.
    */
    const history = await client.getRepositoryHistory();

    for (const filePath of filePaths) {
      const stats = history.statsByPath.get(filePath);
      const commitCount = stats?.commitCount ?? 0;
      maxCommitCount = Math.max(maxCommitCount, commitCount);

      const metrics: GitFileMetrics = {
        commitCount,
        lastCommitDate: stats?.lastCommit?.date,
        lastCommitHash: stats?.lastCommit?.hash,
        topContributors: stats?.contributors.slice(0, 3) ?? [],
        hotspotScore: 0,
      };

      entries.push({ path: filePath, commitCount, metrics });
    }

    // رتبه‌بندی churn
    entries.sort((a, b) => b.commitCount - a.commitCount);
    const rankByPath = new Map<string, number>();
    for (let i = 0; i < entries.length; i++) {
      rankByPath.set(entries[i]!.path, i + 1);
    }

    // محاسبهٔ hotspot score
    const result = new Map<string, GitFileMetrics>();
    for (const entry of entries) {
      const normalizedChurn = maxCommitCount > 0 ? entry.commitCount / maxCommitCount : 0;
      const complexity = fileComplexityByPath?.get(entry.path) ?? 1;
      const normalizedComplexity = Math.max(1, complexity) / 10; // scale rough complexity
      const hotspotScore = Math.min(100, normalizedChurn * normalizedComplexity * 100);

      result.set(entry.path, {
        ...entry.metrics,
        hotspotScore,
        churnRank: rankByPath.get(entry.path),
      });
    }

    return { metricsByPath: result, maxCommitCount };
  }

}
