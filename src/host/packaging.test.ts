/**
 * فاز ۳۱ — قرارداد بسته‌بندی.
 *
 *   MIG-60  حذف `engines.vscode`, `categories`, `contributes`؛
 *           افزودن `engines.node`, `bin`, `files`, `license`, `repository`
 *   MIG-61  حذف `@types/vscode` و `@vscode/test-electron`
 *   MIG-62  تست محافظ: جست‌وجوی `'vscode'` در `src/` → شکست
 *   MIG-64/65/66  README و مستند محدودیت‌ها
 *   SE-BUILD-06/07  وابستگی‌های runtime در جای درست
 *   SE-BUILD-10  نصب بدون شبکه
 *
 * این فایل قرارداد *منتشر شده* را می‌سنجد، نه کد را. یک پکیج
 * می‌تواند کاملاً درست کار کند و همچنان غیرقابل نصب باشد.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');

interface PackageJson {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly license?: string;
  readonly repository?: unknown;
  readonly main?: string;
  readonly types?: string;
  readonly bin?: Record<string, string>;
  readonly files?: string[];
  readonly engines?: Record<string, string>;
  readonly dependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly [key: string]: unknown;
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as PackageJson;

describe('MIG-60 — package.json دیگر یک افزونهٔ ویرایشگر نیست', () => {
  it.each(['categories', 'contributes', 'activationEvents', 'displayName', 'publisher', 'icon'])(
    'فیلد افزونه‌ایِ «%s» حذف شده است',
    field => {
      expect(pkg[field]).toBeUndefined();
    }
  );

  it('`engines` نسخهٔ Node را اعلام می‌کند، نه VS Code را', () => {
    expect(pkg.engines?.['vscode']).toBeUndefined();
    expect(pkg.engines?.['node']).toBeDefined();
    /*
    | `>=20`: `fs.watch` بازگشتی روی لینوکس از همان نسخه کار می‌کند،
    | و ماتریس CI هم ۲۰ و ۲۲ است.
    */
    expect(pkg.engines!['node']).toMatch(/>=\s*20/);
  });

  it('فیلدهای لازم برای انتشار وجود دارند', () => {
    expect(pkg.license).toBeTruthy();
    expect(pkg.repository).toBeTruthy();
    expect(pkg.description).toBeTruthy();
    expect(pkg.main).toBeTruthy();
    expect(pkg.types).toBeTruthy();
  });

  it('`bin` به یک فایل موجود اشاره می‌کند', () => {
    expect(pkg.bin).toBeDefined();
    for (const [, target] of Object.entries(pkg.bin!)) {
      const resolved = path.join(ROOT, target);
      /*
      | مسیرهای `dist/` تا وقتی build نشده وجود ندارند؛ فقط
      | راه‌انداز `bin/` باید همیشه در مخزن باشد.
      */
      if (target.startsWith('./bin/')) {
        expect(fs.existsSync(resolved)).toBe(true);
      }
    }
  });

  it('`files` هرچه را که اعلام کرده واقعاً دارد', () => {
    expect(pkg.files).toBeDefined();
    for (const entry of pkg.files!) {
      /*
      | `dist/` خروجی `tsc` است؛ تا وقتی build نشده در درخت منبع وجود
      | ندارد (دقیقاً همان دلیلی که تست `bin` فقط مقصد `bin/` را بررسی
      | می‌کند). پس نبودِ آن در نصبِ پیش از build نباید این گیت را قرمز کند؛
      | presence واقعی‌اش را خودِ `npm pack` در انتشار تضمین می‌کند.
      */
      if (entry.replace(/\/$/, '') === 'dist') continue;
      const resolved = path.join(ROOT, entry.replace(/\/$/, ''));
      expect(fs.existsSync(resolved)).toBe(true);
    }
  });

  it('`files` منبع و fixture را منتشر نمی‌کند', () => {
    const shipped = pkg.files!.join(' ');
    expect(shipped).not.toMatch(/\bsrc\b/);
    expect(shipped).not.toMatch(/test-fixture/);
    expect(shipped).not.toMatch(/node_modules/);
  });
});

describe('MIG-61 / MIG-62 — هیچ ردی از VS Code نمانده', () => {
  it('وابستگی‌های VS Code حذف شده‌اند', () => {
    const everything = {
      ...pkg.dependencies,
      ...pkg.optionalDependencies,
      ...pkg.devDependencies,
    };
    /*
    | «هر اسمی که vscode دارد» تا فاز ۳۲ کافی بود، ولی خیلی گشاد
    | است: `vscode-jsonrpc` کتابخانهٔ سیم JSON-RPC است که هر
    | زبان‌سرور و هر ویرایشگری از آن استفاده می‌کند، و خودش هیچ
    | وابستگی‌ای ندارد — چه رسد به API ویرایشگر. چیزی که ممنوع است
    | خودِ API است: `vscode`, `@types/vscode`, `@vscode/*`.
    */
    const offenders = Object.keys(everything).filter(
      name => name === 'vscode' || name === '@types/vscode' || name.startsWith('@vscode/')
    );
    expect(offenders).toEqual([]);
  });

  it('`vscode-jsonrpc` خودش هیچ‌چیزی نمی‌کشد', () => {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, 'node_modules', 'vscode-jsonrpc', 'package.json'),
        'utf8'
      )
    ) as PackageJson;
    expect(Object.keys(manifest.dependencies ?? {})).toEqual([]);
  });

  it('هیچ فایلی در src/ ماژول `vscode` را import نمی‌کند', () => {
    /*
    | MIG-62 — همان دیواری که `vscodeCoupling.test.ts` نگه می‌دارد،
    | این‌جا هم به‌عنوان شرط گیت ۴ تکرار می‌شود. اشاره در *کامنت*
    | مجاز است و باید باشد: توضیح اینکه چه چیزی جایگزین چه شده،
    | همان چیزی است که تصمیم را قابل فهم نگه می‌دارد.
    */
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;

        const source = fs.readFileSync(full, 'utf8');
        if (/(?:^|\n)\s*import\s[^;]*['"]vscode['"]/.test(source)) offenders.push(full);
        if (/require\(\s*['"]vscode['"]\s*\)/.test(source)) offenders.push(full);
      }
    };
    walk(path.join(ROOT, 'src'));

    expect(offenders).toEqual([]);
  });

  it('پیکربندی jest دیگر `vscode` را نگاشت نمی‌کند', () => {
    const config = fs.readFileSync(path.join(ROOT, 'jest.config.js'), 'utf8');
    expect(config).not.toMatch(/moduleNameMapper[\s\S]{0,200}vscode\s*['"]?\s*:/);
  });

  it('پوشهٔ `__mocks__` وجود ندارد', () => {
    expect(fs.existsSync(path.join(ROOT, 'src', '__mocks__'))).toBe(false);
  });
});

describe('SE-BUILD-10 — نصب بدون شبکه ممکن است', () => {
  /**
   * ماژول‌هایی که در نصب باینری دانلود می‌کنند.
   *
   * `npm ci` در محیطی با گواهی TLS شرکتی یا بدون خروجی اینترنت روی
   * هرکدام از این‌ها کاملاً شکست می‌خورد. هیچ‌کدام نباید در
   * `dependencies` باشند، وگرنه نصبِ پکیج به آن‌ها گره می‌خورد.
   */
  const BINARY_DOWNLOADERS = [
    'usearch',
    'sharp',
    /*
    | فاز ۳۲: زبان‌سرور TypeScript یک باینری ۲۷ مگابایتی مخصوص سکو
    | است. برای *آزمون* لازم است، برای *استفاده* نه — اگر نبود،
    | موتور با tree-sitter ادامه می‌دهد. پس فقط devDependency.
    */
    '@typescript/native-preview',
  ];

  it.each(BINARY_DOWNLOADERS)('«%s» یک وابستگی اجباری نیست', name => {
    expect(pkg.dependencies?.[name]).toBeUndefined();
  });

  it('هرکدام که استفاده می‌شود، اختیاری اعلام شده است', () => {
    const optional = Object.keys(pkg.optionalDependencies ?? {});
    for (const name of ['usearch']) {
      expect(optional).toContain(name);
    }
  });

  it('وابستگی‌های اجباری، دانلود/بیلد زمان نصب ندارند', () => {
    /*
    | فهرست سفید صریح. هر افزودنی به `dependencies` باید یک تصمیم
    | آگاهانه باشد، نه چیزی که با `npm install --save` سر بخورد
    | داخل.
    |
    | ناوردا (invariant) واقعی این تست «خالص‌بودن» نیست، بلکه «نصب
    | فقط از رجیستری» است: هیچ وابستگی اجباری نباید در زمان نصب
    | به بیرون از رجیستری وصل شود یا چیزی بیلد کند. `@ast-grep/napi`
    | باینری `.node` را *داخل* تاربال سکویی‌اش دارد (بدون
    | install/postinstall script) و فقط تاربالِ سکوی جاری از همان
    | رجیستری گرفته می‌شود؛ روی سکوی بدون باینری، نصب موفق است و
    | موتور ast-grep در زمان اجرا با `AST_GREP_UNAVAILABLE` بسته
    | می‌ماند (lazy load در `Phase2AstGrep.ts`). نسخه دقیقاً pin
    | شده (D-0016) و تست `Phase2AstGrep` هر انحرافی را قرمز می‌کند.
    */
    const allowed = new Set([
      '@ast-grep/napi',
      '@modelcontextprotocol/sdk',
      'ajv',
      'ajv-formats',
      'chokidar',
      'minimatch',
      'typescript',
      /*
      | فاز ۳۲ (LSP-01). لایهٔ JSON-RPC زیرسیستم LSP. جاوااسکریپت
      | خالص، بدون وابستگی، و نسخهٔ **۸** عمدی است: نسخهٔ ۹ فقط
      | نقشهٔ `exports` دارد و زیر `moduleResolution: node10` این
      | پروژه اصلاً resolve نمی‌شود (SE-BUILD-14).
      */
      'vscode-jsonrpc',
      'web-tree-sitter',
    ]);
    expect(new Set(Object.keys(pkg.dependencies ?? {}))).toEqual(allowed);
  });

  it('`@typescript/native-preview` فقط برای توسعه است', () => {
    expect(pkg.devDependencies?.['@typescript/native-preview']).toBeTruthy();
    expect(pkg.optionalDependencies?.['@typescript/native-preview']).toBeUndefined();
  });

  it('`vscode-jsonrpc` روی major ۸ قفل است', () => {
    /*
    | SE-BUILD-14: `vscode-jsonrpc@9` نه `main` دارد نه `node.js` در
    | ریشه — فقط نقشهٔ `exports`. با tsconfig این پروژه نتیجه‌اش:
    |
    |   error TS2307: Cannot find module 'vscode-jsonrpc/node'
    |
    | یک `npm install vscode-jsonrpc@latest` بی‌دقت، build را
    | می‌شکند. این آزمون همان تصمیم را ثبت می‌کند.
    */
    expect(pkg.dependencies?.['vscode-jsonrpc']).toMatch(/^\^?8\./);
  });
});

describe('SE-PKG-02 — قفل نصب با مانیفست یکی است', () => {
  /**
   * فاز ۳۱ `@types/vscode` و `@vscode/test-electron` را از
   * `package.json` برداشت، ولی `package-lock.json` دست‌نخورده ماند.
   * یعنی `npm ci` — که *فقط* قفل را می‌خواند — هنوز هر دو پکیج
   * ویرایشگر را نصب می‌کرد. «حذف شد» در مانیفست، بدون قفل، فقط یک
   * ادعا است.
   */
  const lock = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')
  ) as { packages?: Record<string, unknown> };

  const installed = Object.keys(lock.packages ?? {});

  it.each(['@types/vscode', '@vscode/test-electron'])('«%s» در قفل نیست', name => {
    expect(installed.filter(entry => entry.endsWith(`node_modules/${name}`))).toEqual([]);
  });

  it('هر وابستگی مانیفست در قفل هم هست', () => {
    const declared = Object.keys({
      ...pkg.dependencies,
      ...pkg.devDependencies,
    });
    const missing = declared.filter(
      name => !installed.some(entry => entry.endsWith(`node_modules/${name}`))
    );
    expect(missing).toEqual([]);
  });
});

describe('MIG-64/65/66 — مستندات', () => {
  it('README وجود دارد و چیزی می‌گوید', () => {
    const readme = path.join(ROOT, 'README.md');
    expect(fs.existsSync(readme)).toBe(true);
    expect(fs.readFileSync(readme, 'utf8').length).toBeGreaterThan(800);
  });

  it('README دستورهای واقعی CLI را نشان می‌دهد', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    for (const command of ['index', 'watch', 'query', 'serve', 'doctor']) {
      expect(readme).toContain(`semantic-engine ${command}`);
    }
  });

  it('README محدودیت‌های واقعی را پنهان نمی‌کند', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    /*
    | مستندی که فقط چیزهای خوب را می‌گوید، کاربر را در اولین برخورد
    | با یک محدودیت غافلگیر می‌کند. این‌ها هرکدام یافتهٔ ثبت‌شده‌ای
    | در AUDIT دارند.
    */
    expect(readme).toMatch(/optional/i);
    expect(readme).toMatch(/offline|without network|no network/i);
    expect(readme).toMatch(/limitation/i);
  });
});
