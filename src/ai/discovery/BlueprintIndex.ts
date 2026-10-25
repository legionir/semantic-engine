/**
 * BlueprintIndex — SE-BP-06: blueprint را از یک آرتیفکتِ فقط‌نوشتنی به
 * یک منبعِ قابلِ پرس‌وجو تبدیل می‌کند.
 *
 * ## چرا لازم شد
 *
 * جست‌وجوی کد نشان داد `blueprint.json` تولید می‌شود، نوشته می‌شود، و
 * **هیچ‌جا خوانده نمی‌شود**. هیچ ابزار AI ای، هیچ فرمان CLI ای، هیچ
 * مسیر incremental ای آن را بازنمی‌خواند:
 *
 * ```
 * $ grep -rn "JSON.parse" src | grep -i blueprint
 * (خالی)
 * ```
 *
 * یعنی هزینهٔ ساختش پرداخت می‌شد و فایده‌اش صفر بود — دقیقاً همان
 * الگویی که GAP-06 دربارهٔ `aiScore` توصیف کرده بود. و GAP-04 صریحاً
 * می‌گوید کشف نامزد باید «جست‌وجو + blueprint» باشد؛ بدون خواننده،
 * نیمِ دوم آن جمله وجود خارجی ندارد.
 *
 * ## چه چیزی از blueprint واقعاً به درد کشف می‌خورد
 *
 * اندازه‌گیری روی ایندکس واقعی این پکیج نشان داد فیلد `responsibility`
 * تا پیش از رفع SE-BP-05 برای ۲۵ ماژول از ۳۲ ماژول یک رشتهٔ غلطِ
 * یکسان بود. پس از رفع هم صادق شد ولی *کم‌اطلاع*: بیشتر ماژول‌ها
 * `Module <name>` می‌گیرند، چون نام‌گذاری فایل‌های این مخزن از قرارداد
 * controller/service/repository پیروی نمی‌کند.
 *
 * نتیجهٔ عملی: تطبیق روی **نام و مسیر ماژول** وزن اصلی را دارد و
 * `responsibility` فقط یک سیگنال کمکی است. اگر روی prose ای که خودش
 * heuristic است تکیه کنیم، دو لایه حدس روی هم می‌نشیند.
 */

import type {
  Blueprint,
  ModuleEntry,
} from '../../core/types/blueprint.types';

export interface ModuleMatch {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  /** بازهٔ ۰..۱ — نسبت اصطلاحاتِ task که با این ماژول خواندند. */
  readonly score: number;
  readonly fileIds: readonly string[];
  /** توضیح خواندنی، برای اینکه «چرا این ماژول» جواب داشته باشد. */
  readonly reason: string;
}

/** وزن هر محلِ برخورد. نام ماژول از prose ی که خودش heuristic است مهم‌تر است. */
const WEIGHT_NAME = 1.0;
const WEIGHT_PATH = 0.6;
const WEIGHT_RESPONSIBILITY = 0.3;

export class BlueprintIndex {
  private readonly moduleById = new Map<string, ModuleEntry>();
  private readonly moduleByFileId = new Map<string, ModuleEntry>();

  constructor(readonly blueprint: Blueprint) {
    for (const mod of blueprint.moduleMap) {
      this.moduleById.set(mod.id, mod);
      for (const fileId of mod.fileIds) {
        // نخستین ماژول برنده است؛ SE-BP-01 نشان داده بود که idها
        // می‌توانند تصادم کنند، پس «آخرین برنده» نتیجه را به ترتیب
        // ورودی گره می‌زد.
        if (!this.moduleByFileId.has(fileId)) this.moduleByFileId.set(fileId, mod);
      }
    }
  }

  get moduleCount(): number {
    return this.moduleById.size;
  }

  moduleOf(fileId: string): ModuleEntry | undefined {
    return this.moduleByFileId.get(fileId);
  }

  getModule(moduleId: string): ModuleEntry | undefined {
    return this.moduleById.get(moduleId);
  }

  /**
   * ماژول‌هایی که با اصطلاحات task می‌خوانند، مرتب‌شده و امتیازدار.
   *
   * امتیاز نسبتِ *پوشش* است نه شمارشِ خام: ماژولی که با دو اصطلاح از
   * سه اصطلاح می‌خواند، از ماژولی که با دو اصطلاح از ده می‌خواند
   * بالاتر است.
   */
  matchModules(terms: readonly string[], limit = 5): ModuleMatch[] {
    if (terms.length === 0) return [];

    const matches: ModuleMatch[] = [];

    for (const mod of this.moduleById.values()) {
      const name = mod.name.toLowerCase();
      const modulePath = mod.path.toLowerCase();
      const responsibility = (mod.responsibility ?? '').toLowerCase();

      let weighted = 0;
      const hits: string[] = [];

      for (const term of terms) {
        if (name.includes(term)) {
          weighted += WEIGHT_NAME;
          hits.push(`name~${term}`);
        } else if (modulePath.includes(term)) {
          weighted += WEIGHT_PATH;
          hits.push(`path~${term}`);
        } else if (responsibility.includes(term)) {
          weighted += WEIGHT_RESPONSIBILITY;
          hits.push(`responsibility~${term}`);
        }
      }

      if (weighted === 0) continue;

      matches.push({
        id: mod.id,
        name: mod.name,
        path: mod.path,
        score: Math.min(1, weighted / terms.length),
        fileIds: mod.fileIds,
        reason: `blueprint module ${mod.id} matched ${hits.join(', ')}`,
      });
    }

    return matches
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, limit);
  }
}
