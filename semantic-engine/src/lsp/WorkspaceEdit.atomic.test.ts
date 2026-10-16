/**
 * F-0025 — «همه یا هیچ» باید برای *نوشتن* هم صادق باشد، نه فقط برای ساختِ نقشه.
 *
 * قاعدهٔ ۲ در سرآمدِ خودِ `WorkspaceEdit.ts` نوشته شده بود، ولی
 * `applyEditPlan` ترتیبی و بدونِ بازگشت می‌نوشت: خطای I/O روی فایلِ دوم
 * یک rename را وسط راه ول می‌کرد و کاربر نمی‌دانست کدام فایل عوض شده.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import {
  WorkspaceEditError,
  applyEditPlan,
  planWorkspaceEdit,
} from './WorkspaceEdit';
import { NodeFileSystem } from '../host/FileSystem';

const at = (line: number, character: number) => ({ line, character });
const range = (l1: number, c1: number, l2: number, c2: number) => ({
  start: at(l1, c1),
  end: at(l2, c2),
});

describe('F-0025 — applyEditPlan اتمیک است', () => {
  let workspace: string;
  const original = {
    'src/a.ts': 'export const alpha = 1;\n',
    'src/b.ts': 'export const beta = 2;\n',
  };

  const uriOf = (rel: string) => pathToFileURL(path.join(workspace, rel)).toString();

  function makeWorkspace(): void {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-edit-plan-')));
    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
    for (const [rel, text] of Object.entries(original)) {
      fs.writeFileSync(path.join(workspace, rel), text, 'utf8');
    }
  }

  const twoFilePlan = () =>
    planWorkspaceEdit(
      {
        changes: {
          // `alpha` پنج حرفی است (۱۳..۱۸)، `beta` چهار (۱۳..۱۷) — بازه‌ها
          // باید با خودِ نام یکی باشند وگرنه فاصله هم جایگزین می‌شود.
          [uriOf('src/a.ts')]: [{ range: range(0, 13, 0, 18), newText: 'renamedA' }],
          [uriOf('src/b.ts')]: [{ range: range(0, 13, 0, 17), newText: 'renamedB' }],
        },
      },
      { rootPath: workspace }
    );

  const readBack = (rel: string) => fs.readFileSync(path.join(workspace, rel), 'utf8');

  beforeEach(makeWorkspace);
  afterEach(() => fs.rmSync(workspace, { recursive: true, force: true }));

  it('مسیرِ موفق: هر دو فایل نوشته می‌شوند و فایلِ موقت‌ای جا نمی‌ماند', async () => {
    const port = new NodeFileSystem();
    const written = await applyEditPlan(twoFilePlan(), {
      writeAtomic: (file, content) => port.writeFileAtomic(file, content).then(() => undefined),
    });

    expect(written).toEqual([path.join('src', 'a.ts'), path.join('src', 'b.ts')]);
    expect(readBack('src/a.ts')).toBe('export const renamedA = 1;\n');
    expect(readBack('src/b.ts')).toBe('export const renamedB = 2;\n');
    expect(fs.readdirSync(path.join(workspace, 'src')).sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('خرابی روی فایلِ دوم: فایلِ اول برمی‌گردد و هیچی نیمه‌کاره نمی‌ماند', async () => {
    let calls = 0;
    const failingWriter = async (file: string, content: string): Promise<void> => {
      calls += 1;
      if (file.endsWith('b.ts')) throw new Error('ENOSPC: no space left on device');
      await fs.promises.writeFile(file, content, 'utf8');
    };

    await expect(
      applyEditPlan(twoFilePlan(), { writeAtomic: failingWriter })
    ).rejects.toThrow(/ENOSPC/);

    // `a.ts` لحظه‌ای نوشته شده بود؛ بازگشت باید آن را به محتوای اول برساند
    expect(readBack('src/a.ts')).toBe(original['src/a.ts']);
    expect(readBack('src/b.ts')).toBe(original['src/b.ts']);
    expect(calls).toBeGreaterThan(2); // نوشتن + حداقل یک بازگردانی
  });

  it('نگهبانِ تازگی: فایلِ عوض‌شده روی دیسک، کل اعمال را قبل از هر نوشتن رد می‌کند', async () => {
    const plan = twoFilePlan();
    // بینِ نقشه و اعمال، شخصِ دیگری b.ts را عوض کرده است
    fs.writeFileSync(path.join(workspace, 'src', 'b.ts'), 'export const beta = 999;\n', 'utf8');

    let wrote = 0;
    await expect(
      applyEditPlan(plan, {
        writeAtomic: async () => {
          wrote += 1;
        },
      })
    ).rejects.toThrow(/changed on disk/);

    expect(wrote).toBe(0);
    expect(readBack('src/a.ts')).toBe(original['src/a.ts']);
    expect(readBack('src/b.ts')).toBe('export const beta = 999;\n');
  });

  it('خطا از نوعِ WorkspaceEditError است تا فراخوان بتواند تشخیص بدهد', async () => {
    const plan = twoFilePlan();
    fs.writeFileSync(path.join(workspace, 'src', 'b.ts'), 'tampered\n', 'utf8');

    await expect(applyEditPlan(plan)).rejects.toBeInstanceOf(WorkspaceEditError);
  });

  it('نقشهٔ بی‌تغییری هیچ نوشتنی نمی‌کند (حتی نگهبان اجرا نمی‌شود)', async () => {
    const plan = planWorkspaceEdit(
      { changes: { [uriOf('src/a.ts')]: [{ range: range(0, 13, 0, 18), newText: 'alpha' }] } },
      { rootPath: workspace }
    );
    let reads = 0;

    const written = await applyEditPlan(plan, {
      writeAtomic: async () => {
        throw new Error('must not write');
      },
      readCurrent: async () => {
        reads += 1;
        return '';
      },
    });

    expect(written).toEqual([]);
    expect(reads).toBe(0);
  });
});
