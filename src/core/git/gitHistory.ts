/**
 * تاریخچهٔ مخزن و آمار کامیت فایل — جدا شده از `GitClient` (رفتار بدون تغییر).
 * فقط به دو قابلیت `GitClient` نیاز دارد: اجرای git و پیشوند مخزن.
 */

import type {
  GitCommitInfo,
  GitContributorInfo,
  GitFileCommitStats,
  RepositoryHistory,
} from './GitClient';

export interface GitSource {
  execGit(args: string[], returnRawBuffer?: boolean): Promise<string>;
  getRepositoryPrefix(): Promise<string>;
}

export async function readRepositoryHistory(
  git: GitSource,
  maxCommits: number = 2000
): Promise<RepositoryHistory> {
  /*
  | مسیرهای `--name-only` نسبت به ریشهٔ مخزن‌اند، نه کارگاه. وقتی
  | کارگاه یک زیرپوشه است — که حالت رایج در monorepo است — بدون
  | برداشتن این پیشوند هیچ فایلی تطبیق نمی‌خورد و **همهٔ متریک‌های
  | git خالی می‌مانند**. این را روی اسکن `semantic-engine/src`
  | گرفتیم: صفر فایل از ۲۰۳ فایل متریک داشت.
  */
  const prefix = await git.getRepositoryPrefix();

  const statsByPath = new Map<string, {
    commitCount: number;
    lastCommit: GitCommitInfo | null;
    contributors: Map<string, GitContributorInfo>;
  }>();

  let commitsScanned = 0;

  try {
    /*
    | جداکنندهٔ رکورد یک بایت غیرقابل ظاهر شدن در متن commit است.
    | `\n\n` کافی نیست: پیام commit خودش می‌تواند خط خالی داشته
    | باشد و آن‌وقت یک commit به دو تکه می‌شکند.
    */
    const format = '%x00%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s';
    const output = await git.execGit([
      'log',
      `-${maxCommits}`,
      '--name-only',
      '--no-merges',
      `--format=${format}`,
    ]);

    for (const record of output.split('\u0000')) {
      if (record.trim() === '') continue;

      const newline = record.indexOf('\n');
      const header = newline === -1 ? record : record.slice(0, newline);
      const body = newline === -1 ? '' : record.slice(newline + 1);

      const [hash, shortHash, author, email, date, message] = header.split('\u001f');
      if (!hash) continue;

      commitsScanned++;
      const commit: GitCommitInfo = {
        hash,
        shortHash: shortHash ?? hash.slice(0, 7),
        message: message ?? '',
        author: author ?? '',
        date: date ?? '',
      };

      for (const rawPath of body.split('\n')) {
        const repoPath = rawPath.trim();
        if (repoPath === '') continue;

        // فایل‌های بیرون از کارگاه به این اسکن ربطی ندارند
        if (prefix && !repoPath.startsWith(prefix)) continue;
        const filePath = prefix ? repoPath.slice(prefix.length) : repoPath;

        let entry = statsByPath.get(filePath);
        if (!entry) {
          entry = { commitCount: 0, lastCommit: null, contributors: new Map() };
          statsByPath.set(filePath, entry);
        }

        entry.commitCount++;
        // `git log` از جدید به قدیم می‌آید، پس اولین دیده‌شده تازه‌ترین است
        if (!entry.lastCommit) entry.lastCommit = commit;

        /*
        | SE-GIT-04 — کلید تجمیع ایمیل است، نه نام نمایشی. دو نفر
        | هم‌نام در آمار قاطی می‌شدند و یک نفر که نامش را عوض کرده
        | دو نفر شمرده می‌شد.
        */
        const key = email ?? author ?? '';
        const existing = entry.contributors.get(key);
        entry.contributors.set(key, {
          author: existing?.author ?? author ?? '',
          email: key,
          commitCount: (existing?.commitCount ?? 0) + 1,
        });
      }
    }
  } catch {
    return { statsByPath: new Map(), commitsScanned: 0, truncated: false };
  }

  const result = new Map<string, GitFileCommitStats>();
  for (const [filePath, entry] of statsByPath) {
    result.set(filePath, {
      commitCount: entry.commitCount,
      lastCommit: entry.lastCommit,
      contributors: [...entry.contributors.values()]
        .sort((a, b) => b.commitCount - a.commitCount || a.email.localeCompare(b.email)),
    });
  }

  return {
    statsByPath: result,
    commitsScanned,
    truncated: commitsScanned >= maxCommits,
  };
}

export async function readFileCommitStats(
  git: GitSource,
  relativePath: string, limit: number = 200
): Promise<GitFileCommitStats> {
  try {
    /*
    | SE-GIT-04: ایمیل هم خوانده می‌شود.
    |
    | تجمیع بر اساس نامِ تنها دو نفر هم‌نام را یکی می‌کرد، و یک نفر
    | را که نامش را در `git config` عوض کرده بود دو نفر نشان می‌داد.
    | ایمیل شناسهٔ پایدارتری است، پس کلید تجمیع همان است و نام فقط
    | برای نمایش می‌ماند.
    */
    const format = '%H|%h|%s|%an|%aI|%ae';
    const output = await git.execGit(['log', `-${limit}`, `--format=${format}`, '--', relativePath]);
    const lines = output
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);

    const emails: string[] = [];

    const commits: GitCommitInfo[] = lines.map(line => {
      /*
      | پیام commit خودش می‌تواند `|` داشته باشد. سه فیلد اول و دو
      | فیلد آخر ثابت‌اند، پس هرچه وسط ماند همان پیام است.
      */
      const parts = line.split('|');
      const hash = parts[0]!;
      const shortHash = parts[1] ?? hash.slice(0, 7);
      const email = parts.length >= 6 ? parts[parts.length - 1]! : '';
      const date = parts.length >= 5 ? parts[parts.length - 2]! : '';
      const author = parts.length >= 4 ? parts[parts.length - 3]! : '';
      const message = parts.length > 5 ? parts.slice(2, parts.length - 3).join('|') : (parts[2] ?? '');

      emails.push(email);

      return { hash, shortHash, message, author, date };
    });

    const contributorMap = new Map<string, { author: string; email: string; commitCount: number }>();

    commits.forEach((commit, index) => {
      const email = emails[index] ?? '';
      const key = email !== '' ? email.toLowerCase() : `name:${commit.author}`;
      const existing = contributorMap.get(key);

      if (existing) {
        existing.commitCount += 1;
        return;
      }

      contributorMap.set(key, { author: commit.author, email, commitCount: 1 });
    });

    const contributors = Array.from(contributorMap.values()).sort(
      (a, b) => b.commitCount - a.commitCount
    );

    return {
      commitCount: commits.length,
      lastCommit: commits[0] ?? null,
      contributors,
    };
  } catch {
    return { commitCount: 0, lastCommit: null, contributors: [] };
  }
}

export async function readBranchAndChanges(
  git: GitSource
): Promise<{
  branch: string | null;
  changedPaths: Set<string>;
  isDirty: boolean;
}> {
  const changedPaths = new Set<string>();

  /*
  | `git status` هم مسیرها را نسبت به **ریشهٔ مخزن** می‌دهد. pathspec
  | `.` فقط *فیلتر* می‌کند و مسیرها را نسبی نمی‌کند — این را با
  | آزمایش گرفتیم، نه از روی حدس. پس همان برداشتن پیشوند که برای
  | تاریخچه لازم بود، اینجا هم لازم است.
  */
  const prefix = await git.getRepositoryPrefix();
  const toWorkspacePath = (repoPath: string): string | null => {
    if (!prefix) return repoPath;
    return repoPath.startsWith(prefix) ? repoPath.slice(prefix.length) : null;
  };

  try {
    const output = await git.execGit([
      'status', '-b', '--porcelain', '-z', '--untracked-files=all', '.',
    ]);

    const records = output.split('\u0000');
    let branch: string | null = null;

    for (let index = 0; index < records.length; index++) {
      const record = records[index]!;
      if (record === '') continue;

      // سطر شاخه: `## main...origin/main` یا `## HEAD (no branch)`
      if (record.startsWith('## ')) {
        const rest = record.slice(3);
        const cut = rest.search(/\.\.\.| \(/);
        branch = (cut === -1 ? rest : rest.slice(0, cut)).trim() || null;
        continue;
      }

      if (record.length < 4) continue;

      const indexStatus = record[0]!;
      const changed = toWorkspacePath(record.slice(3));
      if (changed !== null) changedPaths.add(changed);

      /*
      | rename و copy مسیر دوم را در رکورد بعدی می‌آورند؛ آن رکورد
      | مستقل نیست و باید مصرف شود، وگرنه مسیر قدیمی به‌عنوان یک
      | فایل تغییرکردهٔ جداگانه شمرده می‌شود.
      */
      if (indexStatus === 'R' || indexStatus === 'C') {
        index++;
        const oldPath = records[index];
        if (oldPath) {
          const previous = toWorkspacePath(oldPath);
          if (previous !== null) changedPaths.add(previous);
        }
      }
    }

    return { branch, changedPaths, isDirty: changedPaths.size > 0 };
  } catch {
    return { branch: null, changedPaths, isDirty: false };
  }
}
