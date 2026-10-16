/**
 * SE-EXT-05 — barrel عمومی باید قابل `require` باشد.
 *
 * `src/index.ts` خودش را «تنها فایلی که مصرف‌کننده باید از آن import
 * کند» معرفی می‌کند، و `LocalEmbeddingGenerator` را صادر می‌کرد. آن
 * فایل `@xenova/transformers` را به‌صورت *ایستا* import می‌کرد، که
 * خودش `sharp` را می‌کشد — یک ماژول native که باینری‌اش را در نصب
 * دانلود می‌کند.
 *
 * نتیجه: در هر محیطی که `sharp` build نشده باشد، `require` کردن کل
 * API عمومی می‌ترکد:
 *
 * ```
 * Something went wrong installing the "sharp" module
 * Cannot find module '../build/Release/sharp-linux-x64.node'
 * ```
 *
 * همان الگوی SE-BUILD-09 است که فاز ۰۵ حلش کرد: یک
 * وابستگی سنگین و اختیاری، از طریق import ایستا، کل پکیج را گروگان
 * می‌گیرد. و این‌بار مستقیماً بلوک G را تهدید می‌کند — `structured-ai`
 * صفر-وابستگی و CommonJS خالص است.
 */

import * as path from 'path';
import * as fs from 'fs';
import { execFileSync } from 'child_process';

const PACKAGE_ROOT = path.join(__dirname, '..', '..');
const DIST_BARREL = path.join(PACKAGE_ROOT, 'dist', 'index.js');

/**
 * در یک پروسهٔ *جدا* اجرا می‌شود.
 *
 * داخل همین پروسه، jest از قبل ماژول‌ها را کش کرده و `moduleNameMapper`
 * هم در کار است؛ هیچ‌کدام نمایندهٔ کاری که یک مصرف‌کنندهٔ واقعی
 * می‌کند نیستند. تنها سنجش صادقانه، یک `node -e "require(...)"` تازه
 * است.
 */
function requireInFreshProcess(script: string): { ok: boolean; output: string } {
  try {
    const output = execFileSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      cwd: PACKAGE_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, output };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: `${failure.stdout ?? ''}${failure.stderr ?? failure.message ?? ''}` };
  }
}

const built = fs.existsSync(DIST_BARREL);
const describeIfBuilt = built ? describe : describe.skip;

describeIfBuilt('SE-EXT-05 — barrel در CommonJS بار می‌شود', () => {
  it('require کردن barrel نمی‌ترکد', () => {
    const result = requireInFreshProcess(
      `const api = require(${JSON.stringify(DIST_BARREL)});
       process.stdout.write(String(Object.keys(api).length));`
    );

    expect(result.ok).toBe(true);
    expect(Number(result.output)).toBeGreaterThan(20);
  });

  it('هیچ وابستگی native در زمان بارگذاری کشیده نمی‌شود', () => {
    /*
    | `sharp` و `usearch` باینری دانلودی دارند (SE-BUILD-10).
    | هیچ‌کدام نباید صرفاً با `require` کردن barrel بار شوند.
    */
    const result = requireInFreshProcess(
      `require(${JSON.stringify(DIST_BARREL)});
       const loaded = Object.keys(require.cache)
         .filter(p => /node_modules[\\\\/](sharp|usearch|@xenova)[\\\\/]/.test(p));
       process.stdout.write(JSON.stringify(loaded.slice(0, 5)));`
    );

    expect(result.ok).toBe(true);
    expect(JSON.parse(result.output)).toEqual([]);
  });

  it('کلاس embedding همچنان صادر شده و قابل ساخت است', () => {
    const result = requireInFreshProcess(
      `const { LocalEmbeddingGenerator } = require(${JSON.stringify(DIST_BARREL)});
       const generator = new LocalEmbeddingGenerator();
       process.stdout.write(generator.modelName);`
    );

    expect(result.ok).toBe(true);
    expect(result.output).toContain('all-MiniLM');
  });
});
