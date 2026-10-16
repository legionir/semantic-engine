/**
 * LSP-13 — آزمون‌ها بدون هیچ زبان‌سرور نصب‌شده‌ای اجرا شوند.
 *
 * این معیار پذیرش فاز ۳۸ است و تنها راه نگه داشتنش، یک نگهبان است.
 * وگرنه اولین باری که کسی برای راحتی `resolveTypeScriptLspCommand()`
 * را در یک آزمون واحد صدا بزند، سوئیت روی ماشین بدون سرور می‌شکند و
 * پیامش هم نمی‌گوید چرا.
 *
 * قاعده: **فقط `*.integration.test.ts` حق دارد به سرور واقعی برسد.**
 * بقیه با `__fixtures__/fakeLspServer.js` کار می‌کنند، که هیچ نصبی
 * لازم ندارد.
 *
 * ── اندازه‌گیری‌ای که این را لازم کرد ───────────────────────────────
 *
 * با پنهان کردن `@typescript/native-preview` از `node_modules`:
 *
 * ```
 * ۱۲ سوئیت سبز · ۷ قرمز
 *   پنج‌تا  *.integration.test.ts        ← عمدی، با پیام نصب
 *   دوتا    registry.test.ts، typescriptServer.test.ts   ← ناخواسته
 * ```
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, spawn } from 'child_process';

const SRC = path.join(__dirname, '..');

function testFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name.endsWith('.test.ts')) found.push(full);
    }
  };
  walk(SRC);
  return found;
}

/*
| خودِ این فایل کنار گذاشته می‌شود: الگوهایی که دنبالشان می‌گردد،
| به‌عنوان رشته داخلش هستند و خودش را پیدا می‌کند.
*/
const UNIT_TESTS = testFiles().filter(
  file => !file.endsWith('.integration.test.ts') && file !== __filename.replace(/\.js$/, '.ts')
);

describe('LSP-13 — هیچ آزمون واحدی به زبان‌سرور نصب‌شده نیاز ندارد', () => {
  it('فهرست آزمون‌ها خالی نیست — وگرنه بررسی زیر بی‌معنی است', () => {
    expect(UNIT_TESTS.length).toBeGreaterThan(50);
  });

  it('هیچ آزمون واحدی، resolve را روی محیط واقعی اجرا نمی‌کند', () => {
    /*
    | فراخوانی **بدون آرگومان** یعنی «برو ببین روی این ماشین چه
    | نصب است». همان فراخوانی با `exists`/`probeVersion` تزریق‌شده
    | یک آزمون منطقی است و هیچ ربطی به محیط ندارد — پس تفاوت را
    | همین آرگومان‌ها می‌سازند، نه نام تابع.
    */
    const offenders = UNIT_TESTS.filter(file =>
      /resolveTypeScriptLspCommand\s*\(\s*\)/.test(fs.readFileSync(file, 'utf8'))
    ).map(file => path.relative(SRC, file));

    expect(offenders).toEqual([]);
  });

  it('هیچ آزمون واحدی رجیستری پیش‌فرض را resolve نمی‌کند', () => {
    /*
    | `new LspServerRegistry()` بدون `specs` یعنی جدول واقعی نُه
    | سرور، و `resolveForLanguage`/`resolveSpec` روی آن یعنی رفتن
    | سراغ دیسک. ساختن رجیستری با جدول ساختگی مشکلی ندارد.
    */
    const offenders: string[] = [];
    for (const file of UNIT_TESTS) {
      const source = fs.readFileSync(file, 'utf8');
      if (!/new LspServerRegistry\(/.test(source)) continue;
      /*
      | جدول پیش‌فرض یعنی سرور واقعی TypeScript هم داخلش است، و
      | resolve کردنش به `node_modules` سر می‌زند. رجیستری با
      | `specs:` ساختگی، هرقدر هم resolve شود، محیط را نمی‌بیند.
      */
      const usesDefaultTable = /new LspServerRegistry\((?![^)]*specs)/.test(source);
      const resolves = /\.(resolveForLanguage|resolveSpec|detectAll)\s*\(/.test(source);
      if (usesDefaultTable && resolves) offenders.push(path.relative(SRC, file));
    }

    expect(offenders).toEqual([]);
  });

  /*
  | یک قاعدهٔ سوم هم امتحان شد و کنار گذاشته شد: «هر فایلی که
  | `describeMissingTypeScriptLsp` را صدا بزند باید integration
  | باشد». آن تابع فقط یک رشته می‌سازد و به هیچ‌جای محیط دست
  | نمی‌زند؛ قاعده، آزمون‌های کاملاً بی‌ضرر را متهم می‌کرد. یک
  | نگهبانِ پرسروصدا، همان‌قدر بی‌فایده است که نبودنش.
  */

  it('سرور ساختگی، بدون هیچ وابستگی، اجرا می‌شود', () => {
    /*
    | خودِ سرور ساختگی نباید چیزی از `node_modules` بخواهد: تنها
    | چیزی که آزمون‌های واحد به آن تکیه دارند همین فایل است.
    */
    const fake = path.join(__dirname, '__fixtures__', 'fakeLspServer.js');
    const source = fs.readFileSync(fake, 'utf8');

    const requires = Array.from(source.matchAll(/require\(['"]([^'"]+)['"]\)/g)).map(m => m[1]);
    expect(requires.filter(name => !name.startsWith('.') && !name.startsWith('node:'))).toEqual([]);

    // و واقعاً بالا می‌آید.
    execFileSync(process.execPath, ['--check', fake], { stdio: 'ignore' });
  });
});

/*
| گیت ۵ فقط در محیطی معنا دارد که PID 1 یتیم‌ها را re reap کند:
| وقتی والد با SIGKILL می‌میرد، سوکت stdin فرزند باید بسته شود تا
| زبان‌سرور بر پایهٔ EOF بمیرد. در sandbox بدون initِ مناسب
| (PID 1 reaper نیست) آن FD باز می‌ماند و یتیم زنده می‌ماند؛ این
| محدودیت محیط است، نه انحراف محصول. با کاوشگرِ همگامِ ظرفیت سنجیده
| می‌شود و صادقانه skip می‌گردد.
*/
function environmentReapsOrphans(): boolean {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'orphan-probe-'));
  const pidFile = path.join(dir, 'pid');
  const script = `
    const cp = require('child_process');
    const fs = require('fs');
    const child = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
    setInterval(() => {}, 1000);
  `;
  try {
    const parent = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
    parent.unref();
    const deadline = Date.now() + 5_000;
    let pid = 0;
    while (Date.now() < deadline) {
      try {
        const raw = fs.readFileSync(pidFile, 'utf8').trim();
        if (raw.length > 0) {
          pid = Number(raw);
          break;
        }
      } catch {
        /* هنوز نوشته نشده */
      }
      execFileSync(process.execPath, ['-e', 'null'], { timeout: 100 });
    }
    if (!pid) return false;
    parent.kill('SIGKILL');
    execFileSync(process.execPath, ['-e', 'null'], { timeout: 2_000 });
    const reaped = !isAlive(pid);
    if (!reaped) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* بهترین تلاش */
      }
    }
    return reaped;
  } catch {
    return false;
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* دیر زمانی */
    }
  }
}

const describeIfReaper = environmentReapsOrphans() ? describe : describe.skip;

describeIfReaper('گیت ۵ — هیچ پروسهٔ زبان‌سرور یتیمی نمی‌ماند', () => {
  it('کشتنِ ناگهانی کلاینت، سرور را هم می‌برد', async () => {
    /*
    | خطر واقعی این نیست که `stop()` را فراموش کنیم — آن را
    | آزمون‌های فاز ۳۲ می‌گیرند. خطر این است که خودِ پروسهٔ ما
    | کشته شود (worker جست، Ctrl+C، OOM) و سروری با ۸۰۰ مگابایت
    | حافظه بی‌صاحب بماند.
    |
    | تکیه‌گاه ما این است که سرور با بسته شدن stdin می‌میرد. این
    | یک *فرض* است تا وقتی اندازه گرفته نشود؛ اینجا با یک پروسهٔ
    | واقعی و یک SIGKILL اندازه گرفته می‌شود.
    |
    | pid از راه **فایل** رد می‌شود و نه stdout: خواندن همگام از
    | یک استریم، حلقهٔ رویداد را می‌بندد و خودش را قفل می‌کند —
    | نسخهٔ اول همین آزمون ده دقیقه معلق ماند تا timeout.
    */
    const fake = path.join(__dirname, '__fixtures__', 'fakeLspServer.js');
    const pidFile = path.join(
      fs.mkdtempSync(path.join(require('os').tmpdir(), 'orphan-')),
      'pid'
    );

    const script = `
      const cp = require('child_process');
      const fs = require('fs');
      const child = cp.spawn(process.execPath, [${JSON.stringify(fake)}], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      setInterval(() => {}, 1000);
    `;

    const parent = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });

    const pid = await waitForPid(pidFile);
    expect(pid).toBeGreaterThan(0);
    expect(isAlive(pid)).toBe(true);

    parent.kill('SIGKILL');

    const died = await waitUntil(() => !isAlive(pid), 5_000);
    if (!died) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* بهترین تلاش */
      }
    }
    expect(died).toBe(true);
  }, 30_000);
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPid(pidFile: string): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const raw = fs.readFileSync(pidFile, 'utf8').trim();
      if (raw.length > 0) return Number(raw);
    } catch {
      /* هنوز نوشته نشده */
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('the child never reported its pid');
}

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return condition();
}
