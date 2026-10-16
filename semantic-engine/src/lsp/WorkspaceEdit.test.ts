/**
 * اعمال `WorkspaceEdit` — جایی که یک اشتباه، فایل کاربر را خراب
 * می‌کند.
 *
 * بیشتر این آزمون‌ها دربارهٔ *نه گفتن* است: مسیر بیرون از ریشه،
 * ویرایش‌های هم‌پوشان، عملیات فایلی که پشتیبانی نمی‌شود. برای کدی که
 * می‌نویسد، «کاری نکرد» همیشه بهتر از «کار اشتباه کرد» است.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import {
  WorkspaceEditError,
  applyEditPlan,
  applyTextEdits,
  planWorkspaceEdit,
  resolveInsideRoot,
} from './WorkspaceEdit';

const at = (line: number, character: number) => ({ line, character });
const range = (l1: number, c1: number, l2: number, c2: number) => ({
  start: at(l1, c1),
  end: at(l2, c2),
});

describe('applyTextEdits', () => {
  const text = ['const alpha = 1;', 'const beta = 2;', 'const gamma = 3;', ''].join('\n');

  it('یک ویرایش ساده', () => {
    expect(applyTextEdits(text, [{ range: range(0, 6, 0, 11), newText: 'first' }])).toBe(
      ['const first = 1;', 'const beta = 2;', 'const gamma = 3;', ''].join('\n')
    );
  });

  it('چند ویرایش، از آخر به اول اعمال می‌شوند', () => {
    /*
    | اگر از اول اعمال شوند، اولین تغییر طولِ متن را عوض می‌کند و
    | موقعیت ویرایش دوم — که نسبت به متن *اصلی* بیان شده — می‌لغزد.
    | با متن‌های هم‌طول این باگ دیده نمی‌شود، پس اینجا عمداً
    | طول‌ها فرق می‌کنند.
    */
    const out = applyTextEdits(text, [
      { range: range(0, 6, 0, 11), newText: 'a' },
      { range: range(2, 6, 2, 11), newText: 'muchLongerName' },
    ]);
    expect(out).toBe(
      ['const a = 1;', 'const beta = 2;', 'const muchLongerName = 3;', ''].join('\n')
    );
  });

  it('ترتیب ورودی مهم نیست', () => {
    const forwards = applyTextEdits(text, [
      { range: range(0, 6, 0, 11), newText: 'a' },
      { range: range(2, 6, 2, 11), newText: 'c' },
    ]);
    const backwards = applyTextEdits(text, [
      { range: range(2, 6, 2, 11), newText: 'c' },
      { range: range(0, 6, 0, 11), newText: 'a' },
    ]);
    expect(forwards).toBe(backwards);
  });

  it('درج (بازهٔ خالی) کار می‌کند', () => {
    expect(applyTextEdits(text, [{ range: range(0, 0, 0, 0), newText: '// top\n' }])).toBe(
      ['// top', 'const alpha = 1;', 'const beta = 2;', 'const gamma = 3;', ''].join('\n')
    );
  });

  it('حذف یک خط کامل', () => {
    expect(applyTextEdits(text, [{ range: range(1, 0, 2, 0), newText: '' }])).toBe(
      ['const alpha = 1;', 'const gamma = 3;', ''].join('\n')
    );
  });

  it('CRLF جای دیگر فایل دست‌نخورده می‌ماند', () => {
    const crlf = 'const a = 1;\r\nconst b = 2;\r\n';
    const out = applyTextEdits(crlf, [{ range: range(1, 6, 1, 7), newText: 'renamed' }]);
    expect(out).toBe('const a = 1;\r\nconst renamed = 2;\r\n');
  });

  it('کاراکتر فراصفحه‌ای (UTF-16) درست شمرده می‌شود', () => {
    /*
    | سرور `positionEncoding: "utf-16"` اعلام کرد و رشتهٔ
    | جاوااسکریپت هم UTF-16 است. یک ایموجی در هر دو **دو** واحد
    | است؛ اگر جایی با نقطهٔ کد یا بایت شمرده شود، ویرایش وسط
    | کاراکتر می‌افتد.
    */
    const withEmoji = 'const a = "🙂"; // tail\n';
    const out = applyTextEdits(withEmoji, [{ range: range(0, 16, 0, 23), newText: '// done' }]);
    expect(out).toBe('const a = "🙂"; // done\n');
  });

  it('BOM جزو ستون صفر شمرده می‌شود و در خروجی می‌ماند', () => {
    /*
    | probe روی سرور واقعی: در فایلی که با BOM شروع می‌شود، سرور
    | ستون‌های خط اول را **یکی جلوتر** گزارش می‌کند — یعنی BOM را
    | یک کاراکتر می‌شمارد. چون `fs.readFileSync(…, 'utf8')` هم
    | `\uFEFF` را نگه می‌دارد، دو طرف با هم می‌خوانند. اگر جایی
    | BOM حذف شود، هر ویرایش خط اول یکی می‌لغزد.
    */
    const withBom = '\uFEFFexport function target(): void {}\n';
    const out = applyTextEdits(withBom, [{ range: range(0, 17, 0, 23), newText: 'renamed' }]);

    expect(out).toBe('\uFEFFexport function renamed(): void {}\n');
    expect(out.charCodeAt(0)).toBe(0xfeff);
  });

  it('ویرایش‌های هم‌پوشان رد می‌شوند', () => {
    expect(() =>
      applyTextEdits(text, [
        { range: range(0, 0, 0, 10), newText: 'x' },
        { range: range(0, 5, 0, 15), newText: 'y' },
      ])
    ).toThrow(WorkspaceEditError);
  });

  it('دو ویرایش چسبیده هم‌پوشان نیستند', () => {
    // همان چیزی که organizeImports واقعی می‌فرستد: [0,1) و [1,2).
    const out = applyTextEdits(text, [
      { range: range(0, 0, 1, 0), newText: 'const alpha = 1;\n' },
      { range: range(1, 0, 2, 0), newText: '' },
    ]);
    expect(out).toBe(['const alpha = 1;', 'const gamma = 3;', ''].join('\n'));
  });

  it('بازهٔ برعکس رد می‌شود', () => {
    expect(() => applyTextEdits(text, [{ range: range(2, 0, 1, 0), newText: 'x' }])).toThrow(
      WorkspaceEditError
    );
  });

  it('موقعیت بیرون از فایل به مرز بریده می‌شود', () => {
    expect(applyTextEdits(text, [{ range: range(99, 0, 99, 0), newText: '// end\n' }])).toBe(
      `${text}// end\n`
    );
  });

  it('فهرست خالی، متن را دست نمی‌زند', () => {
    expect(applyTextEdits(text, [])).toBe(text);
  });
});

describe('resolveInsideRoot', () => {
  const root = path.join(path.sep, 'work', 'project');

  it('مسیر داخل ریشه پذیرفته می‌شود', () => {
    const uri = pathToFileURL(path.join(root, 'src', 'a.ts')).toString();
    expect(resolveInsideRoot(uri, root)).toBe(path.join(root, 'src', 'a.ts'));
  });

  it('مسیر بیرون از ریشه رد می‌شود', () => {
    const uri = pathToFileURL(path.join(path.sep, 'etc', 'passwd')).toString();
    expect(() => resolveInsideRoot(uri, root)).toThrow(/outside the workspace root/);
  });

  it('فرار با `..` رد می‌شود', () => {
    const uri = `${pathToFileURL(root).toString()}/../sibling/a.ts`;
    expect(() => resolveInsideRoot(uri, root)).toThrow(/outside the workspace root/);
  });

  it('پوشهٔ همسایه با پیشوند مشترک رد می‌شود', () => {
    /*
    | `project-backup` با `project` یک پیشوند مشترک دارد. مقایسهٔ
    | رشته‌ای این را «داخل» می‌بیند؛ `path.relative` نه.
    */
    const uri = pathToFileURL(path.join(path.sep, 'work', 'project-backup', 'a.ts')).toString();
    expect(() => resolveInsideRoot(uri, root)).toThrow(/outside the workspace root/);
  });

  it('خودِ ریشه رد می‌شود', () => {
    expect(() => resolveInsideRoot(pathToFileURL(root).toString(), root)).toThrow(/outside/);
  });

  it('URIای که file نیست رد می‌شود', () => {
    expect(() => resolveInsideRoot('https://example.com/a.ts', root)).toThrow(/non-file URI/);
    expect(() => resolveInsideRoot('untitled:Untitled-1', root)).toThrow(/non-file URI/);
  });
});

describe('planWorkspaceEdit', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-edit-'));
    fs.mkdirSync(path.join(workspace, 'src'));
    fs.writeFileSync(path.join(workspace, 'src', 'a.ts'), 'export const value = 1;\n', 'utf8');
    fs.writeFileSync(path.join(workspace, 'src', 'b.ts'), 'export const other = 2;\n', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  const uriOf = (relative: string) => pathToFileURL(path.join(workspace, relative)).toString();

  it('چند فایل، با مسیر نسبی و شمار ویرایش', () => {
    const plan = planWorkspaceEdit(
      {
        changes: {
          [uriOf('src/b.ts')]: [{ range: range(0, 13, 0, 18), newText: 'renamed' }],
          [uriOf('src/a.ts')]: [{ range: range(0, 13, 0, 18), newText: 'renamed' }],
        },
      },
      { rootPath: workspace }
    );

    expect(plan.totalEdits).toBe(2);
    // ترتیب قطعی، نه ترتیب کلیدهای شیء.
    expect(plan.files.map(file => file.relativePath)).toEqual([
      path.join('src', 'a.ts'),
      path.join('src', 'b.ts'),
    ]);
    expect(plan.files[0].after).toBe('export const renamed = 1;\n');
  });

  it('نقشه هیچ‌چیزی روی دیسک نمی‌نویسد', () => {
    /*
    | ستون فقرات `dry_run`: همان تابعی که نقشه را می‌سازد، مسیر
    | واقعی هم هست. اگر `dry_run` مسیر جداگانه‌ای داشت، می‌توانست
    | با مسیر واقعی واگرا شود و پیش‌نمایش دروغ بگوید.
    */
    planWorkspaceEdit(
      { changes: { [uriOf('src/a.ts')]: [{ range: range(0, 13, 0, 18), newText: 'renamed' }] } },
      { rootPath: workspace }
    );
    expect(fs.readFileSync(path.join(workspace, 'src', 'a.ts'), 'utf8')).toBe(
      'export const value = 1;\n'
    );
  });

  it('`documentChanges` هم پشتیبانی می‌شود', () => {
    const plan = planWorkspaceEdit(
      {
        documentChanges: [
          {
            textDocument: { uri: uriOf('src/a.ts'), version: 1 },
            edits: [{ range: range(0, 13, 0, 18), newText: 'renamed' }],
          },
        ],
      },
      { rootPath: workspace }
    );
    expect(plan.files[0].after).toBe('export const renamed = 1;\n');
  });

  it('عملیات فایلی (ساخت/حذف/تغییرنام) صریحاً رد می‌شود', () => {
    expect(() =>
      planWorkspaceEdit({ documentChanges: [{ kind: 'delete' }] }, { rootPath: workspace })
    ).toThrow(/not supported/);
  });

  it('یک مسیر بیرونی، کل نقشه را باطل می‌کند', () => {
    /*
    | همه یا هیچ. اگر فایل سالم نوشته شود و فایل بیرونی رد، کاربر
    | با یک تغییرِ نیمه‌کاره می‌ماند که نه قبل است نه بعد.
    */
    expect(() =>
      planWorkspaceEdit(
        {
          changes: {
            [uriOf('src/a.ts')]: [{ range: range(0, 13, 0, 18), newText: 'renamed' }],
            [pathToFileURL(path.join(os.tmpdir(), 'elsewhere.ts')).toString()]: [
              { range: range(0, 0, 0, 0), newText: 'x' },
            ],
          },
        },
        { rootPath: workspace }
      )
    ).toThrow(WorkspaceEditError);

    expect(fs.readFileSync(path.join(workspace, 'src', 'a.ts'), 'utf8')).toBe(
      'export const value = 1;\n'
    );
  });

  it('ویرایش خالی، نقشهٔ خالی می‌دهد', () => {
    expect(planWorkspaceEdit(null, { rootPath: workspace })).toEqual({ files: [], totalEdits: 0 });
    expect(planWorkspaceEdit({}, { rootPath: workspace }).files).toEqual([]);
  });

  it('applyEditPlan فقط فایل‌های واقعاً تغییرکرده را می‌نویسد', async () => {
    const plan = planWorkspaceEdit(
      {
        changes: {
          [uriOf('src/a.ts')]: [{ range: range(0, 13, 0, 18), newText: 'renamed' }],
          // ویرایشی که هیچ‌چیز عوض نمی‌کند.
          [uriOf('src/b.ts')]: [{ range: range(0, 13, 0, 18), newText: 'other' }],
        },
      },
      { rootPath: workspace }
    );

    const untouchedBefore = fs.statSync(path.join(workspace, 'src', 'b.ts')).mtimeMs;
    const written = await applyEditPlan(plan);

    expect(written).toEqual([path.join('src', 'a.ts')]);
    expect(fs.readFileSync(path.join(workspace, 'src', 'a.ts'), 'utf8')).toBe(
      'export const renamed = 1;\n'
    );
    expect(fs.statSync(path.join(workspace, 'src', 'b.ts')).mtimeMs).toBe(untouchedBefore);
  });
});
