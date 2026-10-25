/**
 * `contracts/config.schema.json` — تنها منبع کلیدهای پیکربندی.
 *
 * ── چه چیزی عوض شد (فاز ۳۱) ───────────────────────────────────────
 *
 * تا فاز ۳۰ دو جای مستقل کلیدهای پیکربندی را تعریف می‌کردند:
 * `contributes.configuration` در `package.json` (که VS Code می‌خواند)
 * و این schema. این تست هم‌گامشان نگه می‌داشت.
 *
 * فاز ۳۱ `contributes` را حذف کرد — پکیج دیگر افزونه نیست. یعنی
 * *دلیل وجودی* این تست از بین رفت: وقتی یک منبع بیشتر نیست، چیزی
 * برای واگرا شدن نمانده.
 *
 * ولی خودِ خطر نرفته، فقط طرف دیگرش عوض شده: حالا schema باید با
 * *کدی* بخواند که پیکربندی را می‌خواند. یک کلید که `Config` بخواند
 * و schema نداشته باشد، در حالت strict رد می‌شود؛ و یک کلید در
 * schema که هیچ‌کس نخواند، مستندات مرده است.
 */

import * as fs from 'fs';
import * as path from 'path';

interface JsonSchemaProperty {
  type?: string | string[];
  default?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  description?: string;
}

const ROOT = path.join(__dirname, '..', '..');

const configSchema = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'contracts', 'config.schema.json'), 'utf8')
) as {
  $schema: string;
  type: string;
  additionalProperties: boolean;
  properties: Record<string, JsonSchemaProperty>;
};

/**
 * هر کلیدی که کد واقعاً می‌خواند.
 *
 * `Config.get('semanticEngine.x.y')` تنها راه رسیدن به پیکربندی است،
 * پس گشتن دنبال همان فراخوان‌ها، فهرست کاملی می‌دهد که با کد
 * به‌روز می‌ماند — برخلاف یک فهرست دستی که بی‌صدا کهنه می‌شود.
 */
function keysReadByCode(): Set<string> {
  const found = new Set<string>();
  const pattern = /['"`](semanticEngine\.[A-Za-z0-9_.]+)['"`]/g;

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;

      const source = fs.readFileSync(full, 'utf8');
      for (const match of source.matchAll(pattern)) found.add(match[1]!);
    }
  };
  walk(path.join(ROOT, 'src'));

  return found;
}

describe('config.schema.json is the only source of configuration keys', () => {

  it('every key the code reads is declared in the schema', () => {
    const declared = new Set(Object.keys(configSchema.properties));
    const undeclared = [...keysReadByCode()].filter(key => !declared.has(key));

    expect(undeclared).toEqual([]);
  });

  it('the schema is not empty, so the check above means something', () => {
    expect(Object.keys(configSchema.properties).length).toBeGreaterThan(5);
  });

  it('gives every key a default, because the default layer must be total', () => {
    for (const [key, property] of Object.entries(configSchema.properties)) {
      expect(property).toHaveProperty('default');
      expect(key.startsWith('semanticEngine.')).toBe(true);
    }
  });

  it('refuses unknown keys, so a typo in a config file is caught', () => {
    expect(configSchema.additionalProperties).toBe(false);
  });

  it('uses the same JSON Schema dialect as the other contracts', () => {
    const projectIndex = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'contracts', 'project-index.schema.json'), 'utf8')
    ) as { $schema: string };

    expect(configSchema.$schema).toBe(projectIndex.$schema);
  });

  /*
  | خودنگهبان: اگر روزی جست‌وجو بی‌اثر شود (مثلاً الگو دیگر چیزی
  | پیدا نکند)، تست بالا بی‌صدا سبز می‌ماند چون فهرست خالی هم
  | «هیچ کلید اعلام‌نشده‌ای» است.
  */
  it('actually finds keys in the code', () => {
    expect(keysReadByCode().size).toBeGreaterThan(0);
  });
});
