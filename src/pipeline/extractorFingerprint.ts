/**
 * اثر انگشت استخراج‌گرها برای ابطال `ExtractionCache`.
 *
 * هر چیزی که خروجی استخراج یک فایل را عوض می‌کند باید در آن باشد: نسخهٔ پکیج،
 * کد ماژول‌های استخراج (نام، اندازه و زمان تغییر)، گرامرهای tree-sitter و
 * کلیدهایی که مجموعهٔ استخراج‌گرها را تعیین می‌کنند. زمان تغییر باعث می‌شود
 * بعد از هر build محلی هم کش باطل شود؛ در نصب منتشرشده ثابت می‌ماند.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/** پوشه‌ها و فایل‌هایی (نسبت به ریشهٔ `src`/`dist`) که استخراج به آن‌ها وابسته است. */
const SOURCE_ENTRIES = ['symbols', 'dependencies', 'language', 'core/utils', 'ai/ConfigUsageMapper'];

function packageVersion(): string {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')
    ) as { version?: string };
    return manifest.version ?? '0';
  } catch {
    return '0';
  }
}

function isCodeFile(name: string): boolean {
  if (/\.(test|spec)\.[jt]s$/.test(name)) return false;
  if (name.endsWith('.d.ts') || name.endsWith('.map')) return false;
  return /\.[jt]s$/.test(name) || name.endsWith('.wasm');
}

function collect(entry: string, out: string[]): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(entry);
  } catch {
    return;
  }
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(entry).sort()) collect(path.join(entry, name), out);
  } else if (isCodeFile(path.basename(entry))) {
    out.push(`${path.basename(entry)}:${stat.size}:${Math.floor(stat.mtimeMs)}`);
  }
}

export interface FingerprintInput {
  readonly treeSitter: boolean;
  readonly grammarDir: string | null;
}

export function extractorFingerprint(input: FingerprintInput): string {
  const parts: string[] = [`v${packageVersion()}`, `ts=${input.treeSitter}`];
  const base = path.join(__dirname, '..');
  for (const entry of SOURCE_ENTRIES) {
    const resolved = path.join(base, entry);
    collect(fs.existsSync(resolved) ? resolved : `${resolved}.js`, parts);
    collect(`${resolved}.ts`, parts);
  }
  if (input.treeSitter && input.grammarDir) collect(input.grammarDir, parts);
  return crypto.createHash('sha1').update(parts.join('\n')).digest('hex');
}
