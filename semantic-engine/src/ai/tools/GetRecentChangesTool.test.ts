/**
 * `get_recent_changes` نباید بخواهد agent مسیرِ مطلقِ مخزن را از قبل بداند.
 *
 * ریشهٔ پروژه از رجیستری به ابزار داده می‌شود؛ `workspaceRoot` فقط یک
 * پوششِ اختیاری است. پیش از این همان در schema `required` بود، پس پرس‌وجوی
 * «تغییرات اخیر این پروژه» با خطای اعتبارسنجی رد می‌شد.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { GetRecentChangesTool } from './GetRecentChangesTool';

function makeRepo(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-recent-changes-')));
  const run = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  run('init', '-q');
  run('config', 'user.email', 'probe@example.com');
  run('config', 'user.name', 'Probe');
  run('config', 'commit.gpgsign', 'false');

  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  run('add', '-A');
  run('commit', '-q', '-m', 'first commit');

  fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'export const b = 2;\n');
  run('add', '-A');
  run('commit', '-q', '-m', 'second commit');
  return root;
}

describe('get_recent_changes — ریشه اختیاری', () => {
  let repoRoot: string;

  beforeAll(() => {
    repoRoot = makeRepo();
  });

  afterAll(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('schema دیگر workspaceRoot را اجباری نمی‌کند', () => {
    const schema = new GetRecentChangesTool(repoRoot).inputSchema as { required?: unknown };
    expect(schema.required).toBeUndefined();
  });

  it('بدون هیچ پارامتری تاریخچهٔ همان پروژه را می‌دهد', async () => {
    const result = await new GetRecentChangesTool(repoRoot).execute({});

    expect(result.success).toBe(true);
    expect(result.items.map(i => i.name)).toEqual(expect.arrayContaining(['first commit', 'second commit']));
    // ریشهٔ واقعاً خوانده‌شده اعلام می‌شود، نه پنهان
    expect(fs.realpathSync(String(result.metadata?.workspaceRoot))).toBe(repoRoot);
  });

  it('`workspaceRoot: "."` به ریشهٔ پروژه حل می‌شود (رفتارِ همیشگیِ MCP)', async () => {
    const result = await new GetRecentChangesTool(repoRoot).execute({ workspaceRoot: '.', limit: 5 });
    expect(result.success).toBe(true);
    expect(result.items.length).toBe(2);
  });

  it('با path فقط کامیت‌های همان فایل', async () => {
    const result = await new GetRecentChangesTool(repoRoot).execute({ path: 'src/a.ts' });

    expect(result.success).toBe(true);
    expect(result.items.map(i => i.name)).toEqual(['first commit']);
  });

  it('`since` در آینده یعنی هیچ کامیتی', async () => {
    const result = await new GetRecentChangesTool(repoRoot).execute({ since: '2999-01-01' });
    expect(result.success).toBe(true);
    expect(result.items).toEqual([]);
  });

  it('ریشهٔ غیر-git نمی‌ترکد: نتیجهٔ خالی با همان ریشهٔ اعلام‌شده', async () => {
    /*
    | `GitClient` روی مسیرِ غیرمخزن خطا نمی‌دهد، آرایهٔ خالی می‌دهد؛ این
    | تست همان رفتار را قفل می‌کند که ابزار می‌شکند. «مخزن نیست» با
    | «کامیتی نیست» یکی نشانه می‌رود — یک کاستیِ اعلامِ صادقانه که
    | جدا ثبت شده، نه اینکه اینجا پنهان بماند.
    */
    const missing = path.join(os.tmpdir(), 'se-definitely-not-a-repo-123456');
    const result = await new GetRecentChangesTool().execute({ workspaceRoot: missing });

    expect(result.success).toBe(true);
    expect(result.items).toEqual([]);
    expect(result.metadata?.workspaceRoot).toBe(missing);
  });
});
