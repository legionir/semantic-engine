/**
 * اسکنر — فاز ۲۱.
 *
 * همهٔ موارد اینجا اول روی فایل واقعی بازتولید شدند. شدیدترینشان
 * SE-SCAN-01 است:
 *
 *     دو فایل ۱۰MB که فقط در بایت آخر فرق دارند
 *     → hash یکسان
 *
 * یعنی تشخیص staleness در مسیر incremental برای هر فایل بزرگی
 * کاملاً از کار افتاده است.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceScanner } from './WorkspaceScanner';
import { FileEntry } from '../core/types/project-index.types';

let root: string;

function write(relative: string, content: string | Buffer): void {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

async function scan(
  config: Record<string, unknown> = {}
): Promise<{ files: FileEntry[]; errorCount: number; diagnostics: readonly unknown[] }> {
  const result = await new WorkspaceScanner(root, config).scan();
  if (!result.ok) throw result.error;
  return {
    files: [...result.value.files],
    errorCount: result.value.errorCount,
    diagnostics: result.value.diagnostics ?? [],
  };
}

const find = (files: FileEntry[], relative: string) => files.find(f => f.path === relative);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'se-scan-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('hashing large files (SE-SCAN-01)', () => {

  /*
  | معیار پذیرش فاز: «فایل ۱۰MB با تغییر در بایت آخر، hash متفاوت
  | بدهد.» پیش از این، فقط ۸۱۹۲ بایت اول خوانده می‌شد و hash همان
  | تکه بود — پس هر تغییری بعد از بایت ۸۱۹۲ نامرئی بود.
  */
  it('gives two large files that differ in the last byte different hashes', async () => {
    const base = 'x'.repeat(6 * 1024 * 1024 - 1);
    write('big-a.txt', base + 'A');
    write('big-b.txt', base + 'B');

    const { files } = await scan();

    expect(find(files, 'big-a.txt')!.hash).not.toBe(find(files, 'big-b.txt')!.hash);
  }, 60_000);

  /*
  | همان باگ، مسیر باینری — که تا حالا تست نداشت.
  |
  | `createBinaryFileEntry` از همان بافر ۸KB ای hash می‌گرفت که برای
  | تشخیص باینری خوانده شده بود. بازتولید شد: دو فایل ۶MB با یک بایت
  | آخرِ متفاوت، hash یکسان می‌گرفتند — یعنی برای هر باینریِ بزرگ،
  | تشخیص کهنگی کور بود.
  */
  it('gives two large binary files that differ in the last byte different hashes', async () => {
    const makeBinary = (lastByte: number): Buffer => {
      const buffer = Buffer.alloc(6 * 1024 * 1024);
      buffer[50] = 0x00; // NUL → باینری تشخیص داده می‌شود
      buffer[buffer.length - 1] = lastByte;
      return buffer;
    };

    write('blob-a.bin', makeBinary(0x01));
    write('blob-b.bin', makeBinary(0xff));

    const { files } = await scan();

    const a = find(files, 'blob-a.bin')!;
    const b = find(files, 'blob-b.bin')!;

    expect(a.binary).toBe(true);
    expect(b.binary).toBe(true);
    expect(a.hash).not.toBe(b.hash);
  }, 60_000);

  it('hashes a small binary from its own bytes, unchanged', async () => {
    /*
    | فایل کوچک همان مسیر قبلی را می‌رود؛ این تست فقط مطمئن می‌شود
    | بهینه‌سازی «کامل بود، از بافر hash بگیر» چیزی را نشکسته.
    */
    const small = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    write('tiny.bin', small);

    const { files } = await scan();
    const entry = find(files, 'tiny.bin')!;

    expect(entry.binary).toBe(true);
    expect(entry.hash).toHaveLength(64);
  }, 30_000);

  it('marks an oversized file as truncated', async () => {
    write('big.txt', 'x'.repeat(6 * 1024 * 1024));
    write('small.txt', 'x');

    const { files } = await scan();

    expect(find(files, 'big.txt')!.truncated).toBe(true);
    expect(find(files, 'small.txt')!.truncated).toBeFalsy();
  }, 60_000);

  /*
  | خطوطی که فقط از ۸KB اول شمرده شده باشند، عددی می‌سازند که با
  | `size` نمی‌خواند و هیچ مصرف‌کننده‌ای نمی‌تواند به آن اعتماد کند.
  */
  it('counts the lines of the whole file, not of the first chunk', async () => {
    const line = 'y'.repeat(100) + '\n';
    const count = 70_000;                                  // خیلی بیشتر از ۸KB
    write('many-lines.txt', line.repeat(count));

    const { files } = await scan();

    expect(find(files, 'many-lines.txt')!.lines).toBe(count);
  }, 60_000);

  it('still hashes a small file the same way', async () => {
    write('a.ts', 'export const x = 1;\n');
    write('b.ts', 'export const x = 1;\n');

    const { files } = await scan();

    expect(find(files, 'a.ts')!.hash).toBe(find(files, 'b.ts')!.hash);
  });
});

describe('cross-OS portability of hash/size/lines (SE-PORT-01)', () => {
  /*
  | همان فایل، یک‌بار با CRLF (ویندوز) و یک‌بار با LF (لینوکس). باید
  | hash، size و lines یکسان باشند تا جابه‌جایی OS نیازی به re-index
  | نداشته باشد.
  */
  it('gives CRLF and LF versions of the same file identical hash, size and lines', async () => {
    const body = ['export const a = 1;', 'export const b = 2;', 'export const c = 3;', ''].join('\n');
    write('lf.ts', body);
    write('crlf.ts', body.replace(/\n/g, '\r\n'));

    const { files } = await scan();
    const lf = find(files, 'lf.ts')!;
    const crlf = find(files, 'crlf.ts')!;

    expect(crlf.hash).toBe(lf.hash);
    expect(crlf.size).toBe(lf.size);
    expect(crlf.lines).toBe(lf.lines);
  });

  it('normalizes line endings for the streamed (oversized) path too', async () => {
    const line = 'y'.repeat(100);
    const count = 70_000; // خیلی بیشتر از ۸KB → مسیر استریم
    const lfBody = (line + '\n').repeat(count);
    write('big-lf.txt', lfBody);
    write('big-crlf.txt', lfBody.replace(/\n/g, '\r\n'));

    const { files } = await scan();
    const lf = find(files, 'big-lf.txt')!;
    const crlf = find(files, 'big-crlf.txt')!;

    expect(crlf.hash).toBe(lf.hash);
    expect(crlf.lines).toBe(lf.lines);
  }, 60_000);

  it('gives a file the same id and hash regardless of path separator / OS', async () => {
    // همان فایل در یک زیرپوشه؛ fileId از مسیرِ نرمال‌شده (/) ساخته می‌شود
    // پس ویندوز (\\) و لینوکس (/) شناسهٔ یکسان می‌دهند. hash هم روی
    // محتوای نرمال‌شده است، پس CRLF/LF اثری ندارد.
    write('pkg/mod/file.ts', 'export const v = 42;\r\n');
    const { files } = await scan();
    const f = find(files, 'pkg/mod/file.ts')!;

    // path همیشه با forward slash ذخیره می‌شود (portable)
    expect(f.path).toBe('pkg/mod/file.ts');
    // hash همان چیزی است که نسخهٔ LF می‌داد
    write('pkg/mod/file-lf.ts', 'export const v = 42;\n');
    const { files: files2 } = await scan();
    expect(find(files2, 'pkg/mod/file.ts')!.hash).toBe(find(files2, 'pkg/mod/file-lf.ts')!.hash);
  });
});

describe('ignore patterns (SE-SCAN-02)', () => {

  /*
  | معیار پذیرش فاز: «`src/generated/*.ts` در `.gitignore` واقعاً
  | نادیده گرفته شود.» الگو به `minimatch` داده می‌شد ولی فقط با
  | *نام پایه* مقایسه می‌شد، پس هر الگوی دارای `/` هرگز match
  | نمی‌کرد.
  */
  it('honours a gitignore pattern that contains a path', async () => {
    write('.gitignore', 'src/generated/*.ts\n');
    write('src/generated/api.ts', 'export const gen = 1;\n');
    write('src/real.ts', 'export const real = 1;\n');

    const { files } = await scan();

    expect(find(files, 'src/generated/api.ts')).toBeUndefined();
    expect(find(files, 'src/real.ts')).toBeDefined();
  });

  it('honours a double-star pattern', async () => {
    write('.gitignore', '**/vendor/**\n');
    write('a/vendor/lib.js', 'x\n');
    write('a/keep.js', 'y\n');

    const { files } = await scan();

    expect(find(files, 'a/vendor/lib.js')).toBeUndefined();
    expect(find(files, 'a/keep.js')).toBeDefined();
  });

  /*
  | جهت مخالف همان باگ: `/dist/` در gitignore فقط ریشه را هدف
  | می‌گیرد، ولی مقایسه با نام پایه باعث می‌شد *هر* پوشهٔ `dist` در
  | هر عمقی حذف شود.
  */
  /*
  | نام‌های `dist` و `build` و `coverage` عمداً استفاده نشده‌اند: آن‌ها
  | در `DEFAULT_IGNORE_DIRECTORIES` هستند و رفتار gitignore را از
  | رفتار پیش‌فرض قابل تفکیک نمی‌کنند.
  */
  it('treats a leading slash as anchored to the root', async () => {
    write('.gitignore', '/artifacts/\n');
    write('artifacts/out.js', 'x\n');
    write('packages/app/artifacts/keep.js', 'y\n');

    const { files } = await scan();

    expect(find(files, 'artifacts/out.js')).toBeUndefined();
    expect(find(files, 'packages/app/artifacts/keep.js')).toBeDefined();
  });

  it('still ignores an unanchored directory at any depth', async () => {
    write('.gitignore', 'artifacts/\n');
    write('artifacts/a.js', 'x\n');
    write('packages/app/artifacts/b.js', 'y\n');

    const { files } = await scan();

    expect(find(files, 'artifacts/a.js')).toBeUndefined();
    expect(find(files, 'packages/app/artifacts/b.js')).toBeUndefined();
  });

  it('honours a negation on a file', async () => {
    write('.gitignore', '*.log\n!keep.log\n');
    write('drop.log', 'x\n');
    write('keep.log', 'y\n');

    const { files } = await scan();

    expect(find(files, 'drop.log')).toBeUndefined();
    expect(find(files, 'keep.log')).toBeDefined();
  });

  /*
  | همان معنایی که خودِ git دارد: «اگر یک پوشهٔ والد مستثنا شده باشد،
  | نمی‌شود فایلی داخلش را دوباره وارد کرد». تقلید از این رفتار عمدی
  | است — هر رفتار دیگری یعنی ایندکس با `git status` نمی‌خواند.
  */
  it('does not re-include a file inside an excluded directory', async () => {
    write('.gitignore', 'artifacts/\n!artifacts/keep.md\n');
    write('artifacts/out.js', 'x\n');
    write('artifacts/keep.md', '# keep\n');

    const { files } = await scan();

    expect(find(files, 'artifacts/out.js')).toBeUndefined();
    expect(find(files, 'artifacts/keep.md')).toBeUndefined();
  });

  it('still ignores node_modules without being told', async () => {
    write('node_modules/pkg/index.js', 'x\n');
    write('src/a.ts', 'y\n');

    const { files } = await scan();

    expect(find(files, 'node_modules/pkg/index.js')).toBeUndefined();
  });
});

describe('encodings (SE-SCAN-04)', () => {

  it('decodes a UTF-16LE file instead of mangling it', async () => {
    const source = 'export const greeting = "hello";\n';
    write('utf16.ts', Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(source, 'utf16le'),
    ]));

    const { files } = await scan();

    expect(find(files, 'utf16.ts')!.lines).toBe(1);
  });

  it('decodes a UTF-16BE file', async () => {
    const source = 'export const x = 1;\n';
    const le = Buffer.from(source, 'utf16le');
    const be = Buffer.alloc(le.length);
    for (let index = 0; index < le.length; index += 2) {
      be[index] = le[index + 1]!;
      be[index + 1] = le[index]!;
    }
    write('utf16be.ts', Buffer.concat([Buffer.from([0xfe, 0xff]), be]));

    const { files } = await scan();

    expect(find(files, 'utf16be.ts')!.lines).toBe(1);
  });

  /*
  | BOM در UTF-8 حذف نمی‌شد و به خط اول نشت می‌کرد — یعنی به تشخیص
  | shebang و به اولین symbol هر فایلی که با BOM ذخیره شده باشد.
  */
  it('strips a UTF-8 BOM so it cannot leak into the first line', async () => {
    write('bom.ts', Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('export function first() {}\n'),
    ]));

    const { files } = await scan();
    const entry = find(files, 'bom.ts')!;

    expect(entry.encoding).toBe('utf8-bom');
    // hash باید از محتوای بدون BOM باشد، وگرنه با نسخهٔ بدون BOM فرق می‌کند
    write('plain.ts', 'export function first() {}\n');
    const again = await scan();
    expect(find(again.files, 'bom.ts')!.hash).toBe(find(again.files, 'plain.ts')!.hash);
  });

  it('detects a shebang that sits behind a BOM', async () => {
    write('script', Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('#!/usr/bin/env python\nprint(1)\n'),
    ]));

    const { files } = await scan();

    expect(find(files, 'script')!.language).toBe('python');
  });
});

describe('hidden directories (SE-SCAN-09)', () => {

  /*
  | نادیده گرفتن همهٔ پوشه‌های مخفی یعنی کل پیکربندی CI از دید ابزاری
  | که ادعای «درک پروژه» دارد پنهان می‌ماند.
  */
  it('indexes .github even when hidden directories are skipped', async () => {
    write('.github/workflows/ci.yml', 'name: ci\n');
    write('.cache/junk.tmp', 'x\n');

    const { files } = await scan({ skipHiddenDirectories: true });

    expect(find(files, '.github/workflows/ci.yml')).toBeDefined();
    expect(find(files, '.cache/junk.tmp')).toBeUndefined();
  });

  /*
  | `.vscode` عمداً در این فهرست نیست: در ignoreهای پیش‌فرض به‌عنوان
  | «تنظیمات ادیتور» رد می‌شود و گذاشتنش اینجا یعنی دو تنظیم با هم
  | مخالف باشند.
  */
  it.each(['.github', '.circleci', '.husky'])('keeps %s', async dir => {
    write(`${dir}/config.yml`, 'x\n');

    const { files } = await scan({ skipHiddenDirectories: true });

    expect(find(files, `${dir}/config.yml`)).toBeDefined();
  });

  it('still skips .git itself', async () => {
    write('.git/config', '[core]\n');

    const { files } = await scan({ skipHiddenDirectories: true });

    expect(find(files, '.git/config')).toBeUndefined();
  });
});

describe('symlinks (SE-SCAN-07)', () => {

  it('follows a symlinked directory', async () => {
    write('real/lib.ts', 'export const x = 1;\n');
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'linked'), 'dir');

    const { files } = await scan();

    expect(find(files, 'linked/lib.ts')).toBeDefined();
  });

  /*
  | یک symlink حلقوی — که در monorepo با `node_modules` محلی رایج
  | است — نباید باعث پیمایش بی‌نهایت شود.
  */
  it('does not loop forever on a cycle', async () => {
    write('a/file.ts', 'export const x = 1;\n');
    fs.symlinkSync(path.join(root, 'a'), path.join(root, 'a', 'self'), 'dir');

    const { files } = await scan();

    expect(find(files, 'a/file.ts')).toBeDefined();
  }, 20_000);

  it('reports a skipped cycle rather than staying silent', async () => {
    write('a/file.ts', 'export const x = 1;\n');
    fs.symlinkSync(path.join(root, 'a'), path.join(root, 'a', 'self'), 'dir');

    const { diagnostics } = await scan();

    expect(diagnostics.length).toBeGreaterThan(0);
  }, 20_000);

  it('does not visit the same real directory twice', async () => {
    write('real/lib.ts', 'export const x = 1;\n');
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'linked'), 'dir');

    const { files } = await scan();
    const ids = files.map(f => f.id);

    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('errors become diagnostics (SE-SCAN-08)', () => {

  it('records the path and reason of a file it could not read', async () => {
    write('good.ts', 'export const x = 1;\n');
    const bad = path.join(root, 'locked.ts');
    fs.writeFileSync(bad, 'export const y = 2;\n');
    fs.chmodSync(bad, 0o000);

    const { files, diagnostics } = await scan();

    // اگر تست به‌عنوان root اجرا شود، chmod بی‌اثر است
    if (find(files, 'locked.ts') === undefined) {
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(JSON.stringify(diagnostics)).toContain('locked.ts');
    }

    fs.chmodSync(bad, 0o644);
  });

  it('reports no diagnostics for a clean tree', async () => {
    write('a.ts', 'export const x = 1;\n');

    const { diagnostics, errorCount } = await scan();

    expect(diagnostics).toEqual([]);
    expect(errorCount).toBe(0);
  });
});

describe('generated file detection (SE-SCAN-11)', () => {

  it('does not call a hand-written .d.ts generated', async () => {
    write('types.d.ts', 'export declare const handWritten: number;\n');

    const { files } = await scan();

    expect(find(files, 'types.d.ts')!.generated).toBe(false);
  });

  it('still calls a .d.ts with a generated banner generated', async () => {
    write('api.d.ts', '// Code generated by openapi-generator. DO NOT EDIT.\nexport declare const x: number;\n');

    const { files } = await scan();

    expect(find(files, 'api.d.ts')!.generated).toBe(true);
  });

  it('still detects a generated marker in an ordinary file', async () => {
    write('schema.ts', '/* eslint-disable */\n// @generated by protoc\nexport const x = 1;\n');

    const { files } = await scan();

    expect(find(files, 'schema.ts')!.generated).toBe(true);
  });
});

describe('comment counting (SE-SCAN-10)', () => {

  it('does not treat a C preprocessor directive as a comment', async () => {
    write('a.c', '#include <stdio.h>\n#define X 1\nint main(void) { return 0; }\n');

    const { files } = await scan();
    const metrics = find(files, 'a.c')!.metrics!;

    expect(metrics.commentLines).toBe(0);
  });

  it('counts a hash comment in python', async () => {
    write('a.py', '# a comment\nx = 1\n');

    const { files } = await scan();

    expect(find(files, 'a.py')!.metrics!.commentLines).toBe(1);
  });

  it('counts a line comment in typescript', async () => {
    write('a.ts', '// one\nconst x = 1;\n// two\n');

    const { files } = await scan();

    expect(find(files, 'a.ts')!.metrics!.commentLines).toBe(2);
  });

  it('counts a block comment across its lines', async () => {
    write('a.ts', '/*\n * one\n */\nconst x = 1;\n');

    const { files } = await scan();

    expect(find(files, 'a.ts')!.metrics!.commentLines).toBe(3);
  });

  /*
  | شمردن `TODO` داخل یک رشته، عددی می‌سازد که با هیچ TODO واقعی
  | متناظر نیست.
  */
  it('does not count a TODO that lives inside a string', async () => {
    write('a.ts', 'const message = "TODO: not a real todo";\n');

    const { files } = await scan();

    expect(find(files, 'a.ts')!.metrics!.todoCount).toBe(0);
  });

  it('counts a real TODO comment', async () => {
    write('a.ts', '// TODO: fix this\nconst x = 1;\n');

    const { files } = await scan();

    expect(find(files, 'a.ts')!.metrics!.todoCount).toBe(1);
  });
});

describe('concurrency (SE-SCAN-06)', () => {

  it('produces the same output as a sequential scan', async () => {
    for (let index = 0; index < 40; index++) {
      write(`src/mod${index}.ts`, `export const value${index} = ${index};\n`);
    }

    const parallel = await scan({ concurrency: 8 });
    const sequential = await scan({ concurrency: 1 });

    expect(parallel.files.map(f => f.path)).toEqual(sequential.files.map(f => f.path));
    expect(parallel.files.map(f => f.id)).toEqual(sequential.files.map(f => f.id));
  }, 30_000);

  it('keeps the output sorted regardless of completion order', async () => {
    for (let index = 0; index < 30; index++) {
      write(`src/mod${index}.ts`, 'x'.repeat((index % 7) * 1000) + '\n');
    }

    const { files } = await scan({ concurrency: 8 });
    const paths = files.map(f => f.path);

    expect(paths).toEqual([...paths].sort());
  }, 30_000);
});
