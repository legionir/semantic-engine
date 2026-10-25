/**
 * کارایی Git — فاز ۲۰ (SE-PERF-01، SE-GIT-01، SE-GIT-04).
 *
 * اندازه‌گیری پیش از تغییر، روی همین مخزن با ۴۹۹ فایل:
 *
 *     collect()             → 505 پروسهٔ git · ۱٫۸ ثانیه
 *     collectFileMetrics()  → 500 پروسهٔ git · ۱٫۹ ثانیه
 *
 * یعنی بیش از هزار فرایند فرزند برای یک اسکن. بدتر اینکه مسیر
 * incremental همین را با فهرست کامل فایل‌ها بعد از هر ذخیره صدا
 * می‌زد.
 *
 * معیار پذیرش فاز: روی مخزن ۱۰۰۰ فایلی، تعداد پروسه‌ها در یک اسکن
 * حداکثر ۵.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { GitClient } from './GitClient';
import { GitInfoCollector } from './GitInfoCollector';

let root: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function write(relative: string, content: string): void {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

/** یک مخزن کوچک با تاریخچهٔ واقعی و دو نویسنده. */
function makeRepository(fileCount: number): string[] {
  git('init', '-q');
  git('config', 'user.email', 'first@example.com');
  git('config', 'user.name', 'First Author');

  const paths: string[] = [];
  for (let index = 0; index < fileCount; index++) {
    const relative = `src/mod${index}.ts`;
    write(relative, `export const value${index} = ${index};\n`);
    paths.push(relative);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'first commit');

  // یک commit دوم که فقط چند فایل را لمس می‌کند، با نویسندهٔ دیگر
  git('config', 'user.email', 'second@example.com');
  git('config', 'user.name', 'Second Author');
  for (let index = 0; index < Math.min(3, fileCount); index++) {
    write(`src/mod${index}.ts`, `export const value${index} = ${index + 100};\n`);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'second commit');

  return paths;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'se-git-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('process count (SE-PERF-01)', () => {

  /*
  | معیار پذیرش فاز، همان‌طور که نوشته شده. عدد بالا نگه داشته شده
  | تا آزمون رفتار را مهار کند نه یک پیاده‌سازی خاص را: هر تعداد
  | پروسه‌ای که *مستقل از تعداد فایل‌ها* باشد قبول است.
  */
  it('stays under five processes for a whole scan', async () => {
    const paths = makeRepository(60);
    const collector = new GitInfoCollector(root);

    GitClient.resetProcessCount();
    await collector.collect(paths);
    await collector.collectFileMetrics(paths);

    expect(GitClient.processCount).toBeLessThanOrEqual(5);
  });

  /*
  | مهم‌تر از عدد مطلق: تعداد پروسه نباید با تعداد فایل‌ها رشد کند.
  | این همان چیزی است که روی مخزن بزرگ فرق می‌کند.
  */
  /*
  | مهم‌تر از عدد مطلق: تعداد پروسه نباید با تعداد فایل‌ها رشد کند.
  | این همان چیزی است که روی مخزن بزرگ فرق می‌کند.
  |
  | فراخوانی اول کش «آیا مخزن git است» را گرم می‌کند، پس مقایسه بین
  | دومی و سومی انجام می‌شود تا اثر گرم شدن از اندازه‌گیری بیرون
  | بماند.
  */
  it('does not grow with the number of files', async () => {
    const paths = makeRepository(60);
    const collector = new GitInfoCollector(root);
    await collector.collectFileMetrics(paths.slice(0, 1));   // گرم کردن

    GitClient.resetProcessCount();
    await collector.collectFileMetrics(paths.slice(0, 5));
    const forFive = GitClient.processCount;

    GitClient.resetProcessCount();
    await collector.collectFileMetrics(paths);

    expect(GitClient.processCount).toBe(forFive);
    expect(forFive).toBeLessThanOrEqual(2);
  });

  it('does not grow for drift either', async () => {
    const paths = makeRepository(60);
    const collector = new GitInfoCollector(root);
    await collector.collect(paths.slice(0, 1));              // گرم کردن

    GitClient.resetProcessCount();
    await collector.collect(paths.slice(0, 5));
    const forFive = GitClient.processCount;

    GitClient.resetProcessCount();
    await collector.collect(paths);

    expect(GitClient.processCount).toBe(forFive);
  });

  /*
  | یک اسکن واقعی هر دو متد را روی *یک* collector صدا می‌زند — همان
  | کاری که IndexPipeline می‌کند. معیار پذیرش فاز روی همین عدد است.
  */
  it('needs at most five processes for a realistic single scan', async () => {
    const paths = makeRepository(200);
    const collector = new GitInfoCollector(root);

    GitClient.resetProcessCount();
    await collector.collect(paths);
    await collector.collectFileMetrics(paths);

    expect(GitClient.processCount).toBeLessThanOrEqual(5);
  });
});

describe('drift detection stays correct', () => {

  it('reports nothing drifted on a clean tree', async () => {
    const paths = makeRepository(5);

    const result = await new GitInfoCollector(root).collect(paths);

    expect(result.driftedFilePaths).toEqual([]);
    expect(result.driftScore).toBe(0);
  });

  it('reports a modified file', async () => {
    const paths = makeRepository(5);
    write('src/mod2.ts', 'export const value2 = 999;\n');

    const result = await new GitInfoCollector(root).collect(paths);

    expect(result.driftedFilePaths).toContain('src/mod2.ts');
  });

  it('reports a staged file', async () => {
    const paths = makeRepository(5);
    write('src/mod1.ts', 'export const value1 = 42;\n');
    git('add', 'src/mod1.ts');

    const result = await new GitInfoCollector(root).collect(paths);

    expect(result.driftedFilePaths).toContain('src/mod1.ts');
  });

  it('reports a deleted file', async () => {
    const paths = makeRepository(5);
    fs.rmSync(path.join(root, 'src/mod3.ts'));

    const result = await new GitInfoCollector(root).collect(paths);

    expect(result.driftedFilePaths).toContain('src/mod3.ts');
  });

  it('reports a file that is new since HEAD', async () => {
    const paths = makeRepository(5);
    write('src/brand-new.ts', 'export const fresh = 1;\n');

    const result = await new GitInfoCollector(root).collect([...paths, 'src/brand-new.ts']);

    expect(result.driftedFilePaths).toContain('src/brand-new.ts');
  });

  /*
  | drift فقط دربارهٔ فایل‌هایی است که اسکن شده‌اند. فایلی که خارج از
  | فهرست تغییر کرده نباید در نتیجه بیاید، وگرنه driftScore به چیزی
  | اشاره می‌کند که ایندکس اصلاً نمی‌شناسد.
  */
  it('ignores a changed file that was not scanned', async () => {
    const paths = makeRepository(5);
    write('src/mod4.ts', 'export const value4 = 777;\n');

    const result = await new GitInfoCollector(root).collect(paths.slice(0, 3));

    expect(result.driftedFilePaths).not.toContain('src/mod4.ts');
  });

  it('scales the drift score by the number of tracked files', async () => {
    const paths = makeRepository(10);
    write('src/mod0.ts', 'export const value0 = 1;\n');
    write('src/mod1.ts', 'export const value1 = 1;\n');

    const result = await new GitInfoCollector(root).collect(paths);

    expect(result.driftScore).toBeCloseTo(2 / 10, 5);
  });
});

describe('file metrics stay correct', () => {

  it('counts the commits that touched each file', async () => {
    const paths = makeRepository(5);

    const { metricsByPath } = await new GitInfoCollector(root).collectFileMetrics(paths);

    // mod0 در هر دو commit لمس شده، mod4 فقط در اولی
    expect(metricsByPath.get('src/mod0.ts')?.commitCount).toBe(2);
    expect(metricsByPath.get('src/mod4.ts')?.commitCount).toBe(1);
  });

  it('records the most recent commit of a file', async () => {
    const paths = makeRepository(5);

    const { metricsByPath } = await new GitInfoCollector(root).collectFileMetrics(paths);

    expect(metricsByPath.get('src/mod0.ts')?.lastCommitHash).toBeTruthy();
    expect(metricsByPath.get('src/mod0.ts')?.lastCommitDate).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it('ranks the busiest file first', async () => {
    const paths = makeRepository(5);

    const { metricsByPath } = await new GitInfoCollector(root).collectFileMetrics(paths);

    expect(metricsByPath.get('src/mod0.ts')?.churnRank)
      .toBeLessThan(metricsByPath.get('src/mod4.ts')!.churnRank!);
  });

  it('gives every requested file an entry', async () => {
    const paths = makeRepository(8);

    const { metricsByPath } = await new GitInfoCollector(root).collectFileMetrics(paths);

    for (const filePath of paths) {
      expect(metricsByPath.has(filePath)).toBe(true);
    }
  });

  it('reports zero commits for a file git has never seen', async () => {
    const paths = makeRepository(3);
    write('src/untracked.ts', 'export const x = 1;\n');

    const { metricsByPath } = await new GitInfoCollector(root)
      .collectFileMetrics([...paths, 'src/untracked.ts']);

    expect(metricsByPath.get('src/untracked.ts')?.commitCount).toBe(0);
  });

  /*
  | SE-GIT-04 — تجمیع بر اساس *نام* نویسنده بود. دو نفر با یک نام،
  | یا یک نفر که نامش را عوض کرده، در آمار قاطی می‌شوند. ایمیل
  | شناسهٔ پایدارتری است.
  */
  it('aggregates contributors by email, not by display name', async () => {
    const paths = makeRepository(3);
    // همان ایمیل، نام نمایشی متفاوت
    git('config', 'user.email', 'first@example.com');
    git('config', 'user.name', 'First Author Renamed');
    write('src/mod0.ts', 'export const value0 = 5;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'third commit');

    const { metricsByPath } = await new GitInfoCollector(root).collectFileMetrics(paths);
    const contributors = metricsByPath.get('src/mod0.ts')?.topContributors ?? [];
    const byEmail = contributors.filter(c => c.email === 'first@example.com');

    expect(byEmail).toHaveLength(1);
    expect(byEmail[0].commitCount).toBe(2);
  });

  it('keeps a readable author name alongside the email', async () => {
    const paths = makeRepository(3);

    const { metricsByPath } = await new GitInfoCollector(root).collectFileMetrics(paths);
    const contributors = metricsByPath.get('src/mod0.ts')?.topContributors ?? [];

    expect(contributors[0].author).toBeTruthy();
    expect(contributors[0].email).toContain('@');
  });

  it('separates two different people', async () => {
    const paths = makeRepository(3);

    const { metricsByPath } = await new GitInfoCollector(root).collectFileMetrics(paths);
    const emails = (metricsByPath.get('src/mod0.ts')?.topContributors ?? []).map(c => c.email);

    expect(new Set(emails).size).toBe(2);
  });
});

describe('workspace inside a subdirectory of the repository', () => {

  /*
  | این یک باگی است که خودِ فاز ۲۰ ساخت و روی اجرای واقعی گرفته شد.
  |
  | `git log --name-only` مسیرها را نسبت به **ریشهٔ مخزن** می‌دهد، ولی
  | فهرست فایل‌های اسکن نسبت به کارگاه است. وقتی کارگاه یک زیرپوشه
  | باشد — حالت رایج در monorepo، و دقیقاً وضعیت `semantic-engine/`
  | در همین مخزن — هیچ مسیری تطبیق نمی‌خورد و همهٔ متریک‌ها خالی
  | می‌مانند. اندازه‌گیری‌شده پیش از رفع: صفر از ۲۰۳ فایل متریک
  | داشت.
  |
  | حلقهٔ قبلی این مشکل را نداشت چون `git log -- <path>` را با cwd
  | داخل همان زیرپوشه اجرا می‌کرد و git خودش مسیر را حل می‌کرد.
  */

  function makeNestedWorkspace(): { workspace: string; paths: string[] } {
    makeRepository(3);
    const workspace = path.join(root, 'packages', 'inner');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'deep.ts'), 'export const deep = 1;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'add nested package');

    return { workspace, paths: ['deep.ts'] };
  }

  it('still finds git metrics when the workspace is not the repository root', async () => {
    const { workspace, paths } = makeNestedWorkspace();

    const { metricsByPath } = await new GitInfoCollector(workspace).collectFileMetrics(paths);

    expect(metricsByPath.get('deep.ts')?.commitCount).toBe(1);
  });

  it('still detects drift when the workspace is nested', async () => {
    const { workspace, paths } = makeNestedWorkspace();
    fs.writeFileSync(path.join(workspace, 'deep.ts'), 'export const deep = 2;\n');

    const result = await new GitInfoCollector(workspace).collect(paths);

    expect(result.driftedFilePaths).toEqual(['deep.ts']);
  });

  it('ignores files that live outside the nested workspace', async () => {
    const { workspace } = makeNestedWorkspace();

    const { metricsByPath } = await new GitInfoCollector(workspace)
      .collectFileMetrics(['deep.ts', 'src/mod0.ts']);

    // src/mod0.ts نسبت به ریشهٔ مخزن است، نه این کارگاه
    expect(metricsByPath.get('src/mod0.ts')?.commitCount).toBe(0);
  });

  it('keeps the process count constant when nested', async () => {
    const { workspace, paths } = makeNestedWorkspace();
    const collector = new GitInfoCollector(workspace);

    GitClient.resetProcessCount();
    await collector.collect(paths);
    await collector.collectFileMetrics(paths);

    expect(GitClient.processCount).toBeLessThanOrEqual(5);
  });
});

describe('not a git repository', () => {

  it('returns empty results instead of throwing', async () => {
    write('src/a.ts', 'export const x = 1;\n');
    const collector = new GitInfoCollector(root);

    await expect(collector.collect(['src/a.ts'])).resolves.toMatchObject({ gitInfo: null });
    await expect(collector.collectFileMetrics(['src/a.ts']))
      .resolves.toMatchObject({ maxCommitCount: 0 });
  });
});
