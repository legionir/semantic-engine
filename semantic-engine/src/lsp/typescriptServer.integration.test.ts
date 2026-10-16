/**
 * LSP-13 — ادعاهایی که دربارهٔ *محیط*‌اند، نه دربارهٔ منطق.
 *
 * پیش از فاز ۳۸، این آزمون‌ها داخل `typescriptServer.test.ts` و
 * `registry.test.ts` بودند — دو فایلی که از نامشان برمی‌آید آزمون
 * واحدند. با پنهان کردن `@typescript/native-preview` معلوم شد هر دو
 * بی‌سروصدا به نصب بودن یک زبان‌سرور وابسته‌اند:
 *
 * ```
 * بدون سرور: ۱۲ سوئیت سبز، ۷ قرمز
 *   پنج‌تا  *.integration.test.ts   ← عمدی، با پیام نصب
 *   دوتا    registry.test.ts، typescriptServer.test.ts   ← ناخواسته
 * ```
 *
 * ثبت‌شده به‌عنوان SE-LSP-15. آزمون واحدی که سرور بخواهد، روی
 * ماشین یا لگ CIای که سرور ندارد با خطای گیج‌کننده می‌ترکد، نه با
 * پیام «این را نصب کن».
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  describeMissingTypeScriptLsp,
  resolveTypeScriptLspCommand,
  supportsLsp,
} from './typescriptServer';
import { LspServerRegistry } from './registry';

const resolved = resolveTypeScriptLspCommand();

describe('LSP-01 — زبان‌سرور در همین مخزن', () => {
  it('پیدا می‌شود', () => {
    if (!resolved) throw new Error(describeMissingTypeScriptLsp());
    expect(resolved.source).toBe('native-preview');
    expect(supportsLsp(resolved.version ?? null)).toBe(true);
    expect(fs.existsSync(resolved.command)).toBe(true);
  });

  it('باینری بومی است، نه shim جاوااسکریپتی', () => {
    /*
    | پکیج اصلی فقط یک shim ESM دارد (`bin/tsgo`) و باینری واقعی در
    | پکیج مخصوص سکو است. اجرای مستقیم باینری، یک راه‌اندازی Node
    | صرفه‌جویی می‌کند — روی سروری که در ۱۲ms دست می‌دهد بی‌اهمیت
    | نیست.
    */
    if (!resolved) throw new Error(describeMissingTypeScriptLsp());
    expect(resolved.command).toMatch(/native-preview-[^/\\]+[/\\]lib[/\\]tsgo(\.exe)?$/);
  });
});

describe('LSP-04 — رجیستری روی همین مخزن', () => {
  it('TypeScript را بدون اینکه روی PATH باشد پیدا می‌کند', () => {
    /*
    | `tsgo` روی PATH نیست؛ داخل `node_modules` است. resolve مخصوص
    | فاز ۳۲ همان را پیدا می‌کند و نسخه‌اش را می‌سنجد.
    */
    const workspace = fs.mkdtempSync(path.join(require('os').tmpdir(), 'registry-int-'));
    try {
      const found = new LspServerRegistry({ env: { PATH: '/nowhere' } }).resolveForLanguage(
        'typescript',
        workspace
      );
      if (!found) throw new Error(describeMissingTypeScriptLsp());

      expect(found.id).toBe('typescript');
      expect(found.args).toEqual(['--lsp', '--stdio']);
      expect(found.source).toBe('bundled');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('هیچ سرور دیگری روی این ماشین نیست — و این خطا نیست', () => {
    const workspace = fs.mkdtempSync(path.join(require('os').tmpdir(), 'registry-int-'));
    try {
      const detections = new LspServerRegistry().detectAll(workspace);
      const available = detections.filter(entry => entry.resolved && entry.suitable);

      expect(available.map(entry => entry.id)).toEqual(['typescript']);
      for (const missing of detections.filter(entry => !entry.resolved)) {
        expect(missing.reason.length).toBeGreaterThan(10);
      }
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
