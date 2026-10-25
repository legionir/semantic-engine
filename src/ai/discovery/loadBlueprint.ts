/**
 * loadBlueprint — SE-BP-06: کسی که بالاخره blueprint را می‌خواند.
 *
 * `BlueprintExporter` این فایل را کنار `project-index.json` می‌نویسد و
 * تا فاز ۴۳ هیچ مسیری در کد آن را بازنمی‌خواند:
 *
 * ```
 * $ grep -rn "JSON.parse" src | grep -i blueprint
 * (خالی)
 * ```
 *
 * پس این تابع عمداً کوچک و بی‌سروصداست: اگر فایل نبود یا خراب بود،
 * `null` برمی‌گرداند و مصرف‌کننده بدون blueprint ادامه می‌دهد. کشف
 * نامزد باید بدون blueprint هم کار کند — blueprint یک *منبع دومِ*
 * دانه است، نه پیش‌نیاز.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { Blueprint } from '../../core/types/blueprint.types';
import { BlueprintIndex } from './BlueprintIndex';

export interface BlueprintLoadResult {
  readonly index: BlueprintIndex | null;
  /** چرا بارگذاری نشد — برای اینکه شکستِ بی‌صدا نداشته باشیم. */
  readonly note?: string;
  readonly loadedFrom?: string;
}

/** نام قراردادیِ فایل، همان که `BlueprintExporter` می‌نویسد. */
export const BLUEPRINT_FILENAME = 'blueprint.json';

/**
 * blueprint را از کنارِ یک `project-index.json` می‌خواند.
 *
 * دو آرتیفکت همیشه با هم و در یک پوشه نوشته می‌شوند (`OutputWriter`)،
 * پس مسیرِ دوم قابل استنتاج است و لازم نیست از کاربر پرسیده شود.
 */
export function loadBlueprintBeside(projectIndexPath: string): BlueprintLoadResult {
  const blueprintPath = path.join(path.dirname(projectIndexPath), BLUEPRINT_FILENAME);
  return loadBlueprint(blueprintPath);
}

export function loadBlueprint(blueprintPath: string): BlueprintLoadResult {
  if (!fs.existsSync(blueprintPath)) {
    return { index: null, note: `no blueprint at ${blueprintPath}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(blueprintPath, 'utf8'));
  } catch (error) {
    return {
      index: null,
      note: `blueprint is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!isBlueprintLike(parsed)) {
    return { index: null, note: `blueprint at ${blueprintPath} has no usable moduleMap` };
  }

  return { index: new BlueprintIndex(parsed), loadedFrom: blueprintPath };
}

/**
 * حداقلِ چیزی که برای کشف لازم است، نه اعتبارسنجی کاملِ schema.
 *
 * `discover_context` فقط `moduleMap` را مصرف می‌کند. رد کردن یک
 * blueprint سالم به‌خاطر بخشی که استفاده نمی‌شود، سخت‌گیریِ بی‌فایده
 * است — به‌ویژه که SE-BP-02 می‌گوید چهار بخش از یازده بخش همیشه
 * خالی‌اند.
 */
function isBlueprintLike(value: unknown): value is Blueprint {
  if (typeof value !== 'object' || value === null) return false;
  const modules = (value as { moduleMap?: unknown }).moduleMap;
  if (!Array.isArray(modules)) return false;
  return modules.every(
    m =>
      typeof m === 'object' &&
      m !== null &&
      typeof (m as { id?: unknown }).id === 'string' &&
      Array.isArray((m as { fileIds?: unknown }).fileIds)
  );
}
