/**
 * SE-DATA-04 — فیلدهای اعلام‌شده که هرگز پر نمی‌شدند.
 *
 * ارزیابی با grep روی کل سورس تأیید کرده بود:
 *
 * | فیلد | وضعیت |
 * |---|---|
 * | `FileEntry.role` | هرگز نوشته نمی‌شود (فقط در لایهٔ SQLiteٔ پیشین خوانده می‌شد) |
 * | `FileEntry.entryPoint` | محاسبه می‌شود ولی فقط داخل `aiScore.factors` می‌ماند |
 * | `FileEntry.blueprintRef` | هرگز نوشته نمی‌شود |
 *
 * یک فیلد در قرارداد که هیچ‌وقت مقدار نمی‌گیرد، از دو جهت بد است:
 * مصرف‌کننده کدی می‌نویسد که هرگز اجرا نمی‌شود، و خواننده فکر می‌کند
 * موتور چیزی می‌داند که نمی‌داند.
 */

import { classifyFileRole, isEntryPointPath } from './fileRole';

describe('classifyFileRole (SE-DATA-04)', () => {
  it('نقش را از نام فایل تشخیص می‌دهد', () => {
    expect(classifyFileRole('src/user.service.ts')).toBe('service');
    expect(classifyFileRole('src/user.controller.ts')).toBe('controller');
    expect(classifyFileRole('src/user.repository.ts')).toBe('repository');
    expect(classifyFileRole('src/user.model.ts')).toBe('model');
  });

  it('نقش را از پوشه هم تشخیص می‌دهد', () => {
    expect(classifyFileRole('src/services/user.ts')).toBe('service');
    expect(classifyFileRole('src/repositories/user.ts')).toBe('repository');
    expect(classifyFileRole('src/middleware/auth.ts')).toBe('middleware');
  });

  it('تست بر هر نقش دیگری مقدم است', () => {
    // `user.service.test.ts` یک تست است، نه یک service.
    expect(classifyFileRole('src/user.service.test.ts')).toBe('test');
    expect(classifyFileRole('src/__tests__/user.controller.ts')).toBe('test');
  });

  it('نقطهٔ ورود شناخته می‌شود', () => {
    expect(classifyFileRole('src/index.ts')).toBe('entrypoint');
    expect(classifyFileRole('src/main.ts')).toBe('entrypoint');
    expect(classifyFileRole('server.js')).toBe('entrypoint');
  });

  it('فایل تعریف نوع', () => {
    expect(classifyFileRole('src/types.d.ts')).toBe('type-definition');
    expect(classifyFileRole('src/core/types/project-index.types.ts')).toBe('type-definition');
  });

  it('پیکربندی', () => {
    expect(classifyFileRole('src/config.ts')).toBe('config');
    expect(classifyFileRole('vite.config.ts')).toBe('config');
  });

  it('util و component و hook', () => {
    expect(classifyFileRole('src/util/hash.ts')).toBe('util');
    expect(classifyFileRole('src/components/Button.tsx')).toBe('component');
    expect(classifyFileRole('src/hooks/useAuth.ts')).toBe('hook');
  });

  it('چیزی که نمی‌دانیم، unknown است — نه یک حدسِ دلبخواه', () => {
    expect(classifyFileRole('src/alpha/beta.ts')).toBe('unknown');
    expect(classifyFileRole('README.md')).toBe('unknown');
  });

  it('زیررشتهٔ تصادفی نقش نمی‌سازد', () => {
    // «serviceable» یک service نیست.
    expect(classifyFileRole('src/serviceable/a.ts')).toBe('unknown');
    // «remodel» یک model نیست.
    expect(classifyFileRole('src/remodel/a.ts')).toBe('unknown');
  });

  it('دترمینیستیک است', () => {
    expect(classifyFileRole('src/user.service.ts')).toBe(classifyFileRole('src/user.service.ts'));
  });
});

describe('isEntryPointPath (SE-DATA-04)', () => {
  it('نام‌های متعارف', () => {
    for (const p of ['index.ts', 'src/index.ts', 'src/main.js', 'app.ts', 'src/server.ts']) {
      expect({ p, entry: isEntryPointPath(p) }).toEqual({ p, entry: true });
    }
  });

  it('نامِ مشابه ولی متفاوت، نقطهٔ ورود نیست', () => {
    for (const p of ['src/indexer.ts', 'src/main-menu.ts', 'src/apply.ts']) {
      expect({ p, entry: isEntryPointPath(p) }).toEqual({ p, entry: false });
    }
  });

  it('فایلِ تستِ هم‌نام، نقطهٔ ورود نیست', () => {
    expect(isEntryPointPath('src/index.test.ts')).toBe(false);
  });
});
