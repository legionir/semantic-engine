import * as path from 'path';
import {
  LanguageInfo,
  EXTENSION_MAP,
  FILENAME_MAP,
  SHEBANG_MAP,
  ALL_LANGUAGES,
  LANGUAGE_TABLE,
} from './languageMap';

/**
 * LanguageRegistry — تشخیص زبان فایل با سه استراتژی:
 * 1. نام فایل خاص (مثل Dockerfile, Makefile)
 * 2. پسوند فایل
 * 3. Shebang line (خط اول فایل، برای فایل‌های بدون پسوند)
 *
 * طراحی extensible: افزودن زبان جدید = اضافه کردن یک entry در languageMap.ts.
 * هیچ کد جدیدی لازم نیست.
 */
export class LanguageRegistry {
  /**
   * تشخیص زبان بر اساس path + اختیاراً محتوای اولیه (برای shebang).
   *
   * @param filePath - مسیر فایل (relative یا absolute)
   * @param firstLine - خط اول فایل (اختیاری — فقط اگر فایل باینری نیست و خوانده شده)
   * @returns LanguageInfo یا null اگر ناشناخته
   */
  detect(filePath: string, firstLine?: string): LanguageInfo | null {
    // ۱. بررسی نام فایل خاص
    const fileName = path.basename(filePath).toLowerCase();
    const byFilename = FILENAME_MAP.get(fileName);
    if (byFilename) return byFilename;

    /*
    | ۲. الگوی نام فایل — `tsconfig.build.json` باید مثل `tsconfig.json`
    | زبانِ jsonc باشد، وگرنه پسوند `.json` تحویلش می‌گیرد و کامنت‌هایش
    | خطای تجزیه می‌دهند. پیش از پسوند بررسی می‌شود، چون دقیق‌تر است.
    */
    for (const { pattern, language } of LANGUAGE_TABLE.patterns) {
      if (pattern.test(fileName)) return language;
    }

    // ۳. بررسی پسوند
    const ext = this.extractExtension(filePath);
    if (ext) {
      const byExt = EXTENSION_MAP.get(ext);
      if (byExt) return byExt;
    }

    // ۴. بررسی shebang (فایل‌های بدون پسوند)
    if (firstLine) {
      const byShebang = this.detectByShebang(firstLine);
      if (byShebang) return byShebang;
    }

    return null;
  }

  /**
   * بررسی اینکه آیا زبان خاصی پشتیبانی تحلیل عمیق دارد.
   *
   * SE-SCAN-05: نسخهٔ قبلی `.some()` روی کل فهرست می‌زد، پس اگر یک id
   * دو تعریف با پرچم‌های متفاوت داشت، اولین `true` برنده می‌شد — در
   * حالی که `detect()` آخرین تعریف را برمی‌گرداند. حالا هر دو از یک
   * جدول lookup می‌خوانند و اصلاً نمی‌توانند اختلاف پیدا کنند.
   */
  isDeepAnalysisSupported(languageId: string): boolean {
    return LANGUAGE_TABLE.byId.get(languageId)?.deepAnalysisSupported ?? false;
  }

  /**
   * لیست تمام زبان‌های با پشتیبانی عمیق.
   */
  getDeepAnalysisLanguages(): readonly LanguageInfo[] {
    return ALL_LANGUAGES.filter(lang => lang.deepAnalysisSupported);
  }

  /**
   * استخراج extension بدون نقطه، lowercase.
   * مدیریت edge case: فایل‌های .d.ts، .config.js، و مشابه.
   */
  private extractExtension(filePath: string): string | null {
    const basename = path.basename(filePath);

    // بررسی پسوندهای ترکیبی (مثل .d.ts, .spec.ts)
    const dtsMatch = basename.match(/\.d\.(ts|mts|cts)$/i);
    if (dtsMatch) return 'ts'; // .d.ts → typescript

    const lastDot = basename.lastIndexOf('.');
    if (lastDot === -1 || lastDot === 0) return null; // بدون پسوند یا hidden file
    return basename.substring(lastDot + 1).toLowerCase();
  }

  /**
   * تشخیص shebang — خط اول فایل: #!/usr/bin/env node, #!/bin/bash, ...
   */
  private detectByShebang(firstLine: string): LanguageInfo | null {
    const trimmed = firstLine.trim();
    if (!trimmed.startsWith('#!')) return null;

    // استخراج interpreter: آخرین بخش path بعد از / یا env
    // مثال: #!/usr/bin/env node → node
    // مثال: #!/bin/bash → bash
    const parts = trimmed.substring(2).trim().split(/\s+/);
    let interpreter: string;

    if (parts[0]?.endsWith('/env') && parts.length > 1) {
      // #!/usr/bin/env python3 → python3
      interpreter = path.basename(parts[1]!);
    } else {
      // #!/bin/bash → bash
      interpreter = path.basename(parts[0] || '');
    }

    // حذف نسخه از interpreter: python3 → python, node18 → node
    const normalized = interpreter.replace(/[0-9.]+$/, '').toLowerCase();

    return SHEBANG_MAP.get(normalized) || SHEBANG_MAP.get(interpreter.toLowerCase()) || null;
  }
}
