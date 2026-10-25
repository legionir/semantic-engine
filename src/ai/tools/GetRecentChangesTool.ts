/**
 * GetRecentChangesTool — تاریخچه‌ی git اخیر برای فایل‌ها یا کل پروژه.
 */

import { AiTool, AiToolInput, AiToolOutput } from './types';
import * as path from 'path';
import { GitClient } from '../../core/git/GitClient';

export interface GetRecentChangesInput extends AiToolInput {
  /** اختیاری: پیش‌فرض ریشهٔ خودِ پروژهٔ ایندکس‌شده است. */
  readonly workspaceRoot?: string;
  readonly path?: string;
  readonly limit?: number;
  readonly since?: string; // ISO date
}

export class GetRecentChangesTool implements AiTool<GetRecentChangesInput> {
  readonly name = 'get_recent_changes';
  readonly description = 'Get recent git commit history for a file or the whole project.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      /*
      | این فیلد قبلاً `required` بود، درحالی‌که خودِ ابزار ریشهٔ پروژه را
      | از رجیستری می‌دانست. نتیجه برای agent: پرس‌وجوی «تغییرات اخیر این
      | پروژه» با خطای اعتبارسنجی رد می‌شد مگر مسیرِ مطلقِ مخزن را از قبل
      | بداند — یعنی یک پارامترِ تنظیماتی به‌جای پرس‌وجو.
      */
      workspaceRoot: { type: 'string', description: 'Git repository root; defaults to the indexed project root' },
      path: { type: 'string', description: 'Optional relative file path' },
      limit: { type: 'integer', default: 10 },
      since: { type: 'string', description: 'ISO date to filter commits from' },
    },
  };

  constructor(private readonly defaultWorkspaceRoot?: string) {}

  async execute(input: GetRecentChangesInput): Promise<AiToolOutput> {
    try {
      /* MCP models commonly answer `workspaceRoot: "."`. Resolve that
         relative to the project selected by the server, not the process
         directory used to launch semantic-engine. */
      const requested = input.workspaceRoot ?? '.';
      const base = this.defaultWorkspaceRoot ?? process.cwd();
      const workspaceRoot = path.isAbsolute(requested)
        ? requested
        : path.resolve(base, requested);
      const git = new GitClient(workspaceRoot);
      const limit = input.limit ?? 10;
      if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1)) {
        return { success: false, error: 'limit must be a positive integer', items: [] };
      }
      let sinceDate: Date | undefined;
      if (input.since !== undefined) {
        sinceDate = new Date(input.since);
        if (isNaN(sinceDate.getTime())) {
          /*
          | گذشته: `since` بد بدون هیچ اعلامی نادیده گرفته می‌شد و نتیجه
          | «انگار فیلتر اعمال شده» برمی‌گشت. حالا صریح رد می‌شود تا AI
          | بازهٔ اعمال‌شده را با بازهٔ درخواستی اشتباه نگیرد.
          */
          return { success: false, error: 'since must be a valid ISO date', items: [] };
        }
      }

      /*
      | تفکیکِ «مخزن نیست» از «کامیتی نیست» (§16): خالی‌بودنِ log هر دو
      | حالت را یکسان نشان می‌داد. حالا خودِ مخزن بودن پرسیده و اعلام
      | می‌شود؛ اگر نبود، نتیجهٔ خالی «شواهدی پیدا نشد» است نه «شواهدی
      | وجود ندارد».
      */
      const isRepo = await git.isGitRepository();

      const log = input.path
        ? await git.getFileLog(input.path, limit)
        : await git.getLog(limit);

      /*
      | پنجرهٔ بررسی = دقیقاً `limit` کامیتِ آخر. اگر `since` بعد از
      | این برش اعمال شود و پنجره پر باشد، کامیت‌های منطبقِ بازه که
      | کهنه‌تر از ابتدای پنجره‌اند هرگز دیده نشده‌اند؛ «خالی» در آن
      | حالت یعنی «در پنجرهٔ بررسی‌شده پیدا نشد»، نه «تغییری نیست»
      | (§16). این محدودیت حالا machine-readable اعلام می‌شود.
      */
      const windowFilled = log.length >= limit;
      const filtered = sinceDate ? log.filter(e => new Date(e.date) >= sinceDate) : log;
      const sinceMayReachBeyondWindow = windowFilled && sinceDate !== undefined;

      const items = filtered.map(entry => ({
        id: entry.hash,
        name: entry.message.split('\n')[0] ?? entry.hash,
        kind: 'commit',
        source: entry.author,
        excerpt: `${entry.date} | ${entry.message.split('\n')[0] ?? entry.message}`,
      }));

      return {
        success: true,
        items,
        // کدام ریشه واقعاً خوانده شد، برای agent پنهان نمی‌ماند
        metadata: {
          count: items.length,
          workspaceRoot,
          path: input.path,
          since: input.since,
          limit,
          isGitRepository: isRepo,
          examinedCommits: log.length,
          ...(log.length > 0 ? { oldestExamined: log[log.length - 1]!.date } : {}),
          truncated: windowFilled,
          ...(isRepo ? {} : { emptyNote: 'path is not a git repository — an empty result means history could not be read, not that no changes exist' }),
          ...(windowFilled
            ? {
                countNote: sinceMayReachBeyondWindow
                  ? 'since-filter applied to the newest limit commits only; matching commits older than oldestExamined were not examined'
                  : 'scan stopped at limit; older commits may exist beyond oldestExamined',
              }
            : {}),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        items: [],
      };
    }
  }
}
