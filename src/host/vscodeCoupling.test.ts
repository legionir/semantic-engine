/**
 * دیوارِ نگه‌دارندهٔ گیت ۲.
 *
 * ارزیابی نشان داد وابستگی به VS Code کم‌عمق است: ۸ فایل از ۱۱۹. مسئله
 * این است که این عدد بی‌سروصدا بالا می‌رود — یک `import * as vscode` در
 * یک استخراج‌گر جدید کافی است تا مسیر ایندکس دوباره به ویرایشگر گره
 * بخورد و کسی متوجه نشود.
 *
 * این تست فهرست *مجاز* را نگه می‌دارد. هر فاز بلوک B یک ردیف از آن کم
 * می‌کند؛ افزودن فایل تازه به فهرست باید تصمیمی آگاهانه باشد، نه اتفاقی.
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..');

/**
 * فایل‌هایی که هنوز اجازهٔ import کردن `vscode` را دارند.
 *
 * در پایان بلوک B این فهرست خالی شد. خالی ماندنش شرط گیت ۲ است: هر
 * افزودنی به آن باید یک تصمیم آگاهانه باشد، نه یک import اتفاقی در
 * استخراج‌گر بعدی.
 */
const ALLOWED: readonly string[] = [];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__mocks__') continue;
      walk(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

const importers = walk(SRC)
  .filter(file => /(^|\n)\s*import[^;]*from\s+['"]vscode['"]/.test(fs.readFileSync(file, 'utf8')))
  .map(file => path.relative(SRC, file).split(path.sep).join('/'))
  .sort();

describe('coupling to vscode', () => {

  it('is confined to the files that are still scheduled for removal', () => {
    expect(importers).toEqual([...ALLOWED].sort());
  });

  it('has left the scanner', () => {
    expect(importers.filter(file => file.startsWith('scanner/'))).toEqual([]);
  });

  it('has left the incremental engine', () => {
    expect(importers.filter(file => file.startsWith('incremental/'))).toEqual([]);
  });

  it('has never touched the export, graph, dependency or vector layers', () => {
    const shouldBeClean = importers.filter(file =>
      /^(export|graphs|dependencies|vector|core|language|blueprint|host)\//.test(file)
    );

    expect(shouldBeClean).toEqual([]);
  });

  /*
  | خودنگهبان: اگر regex یا پیمایش بشکند، `importers` خالی می‌شود و
  | همهٔ تست‌های بالا بی‌معنی سبز می‌مانند.
  */
  it('is gone from the index path entirely', () => {
    expect(importers).toEqual([]);
  });

  /*
  | خودنگهبان: حالا که فهرست خالی است، شکستن regex یا پیمایش هم فهرست
  | خالی می‌دهد و همهٔ تست‌های بالا بی‌معنی سبز می‌مانند. پس باید ثابت
  | شود که آشکارساز هنوز کار می‌کند.
  */
  it('would still notice a vscode import if one came back', () => {
    expect(walk(SRC).length).toBeGreaterThan(100);

    const detector = /(^|\n)\s*import[^;]*from\s+['"]vscode['"]/;
    expect(detector.test("import * as vscode from 'vscode';")).toBe(true);
    expect(detector.test('import { Config } from "../host/Config";')).toBe(false);
  });
});
