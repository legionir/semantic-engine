/**
 * TokenBudget — GAP-07: بودجهٔ توکنِ آگاه از ساختار.
 *
 * ## آنچه جایگزین می‌کند
 *
 * ```ts
 * private trimToTokens(text: string, maxTokens: number): string {
 *   const approxChars = maxTokens * 4;
 *   if (text.length <= approxChars) return text;
 *   return text.substring(0, approxChars) + '\n\n[Context truncated]';
 * }
 * ```
 *
 * سه ایراد، هر سه روی ایندکس واقعی دیده شد:
 *
 * ۱. **از انتها می‌بُرد.** ترتیب بخش‌ها در `AssembleContextTool` ثابت
 *    است و «تست‌های مرتبط» آخرین بخش است. با بودجهٔ ۴۰۰ توکن، آن بخش
 *    کامل ناپدید می‌شد — بی‌آنکه امتیازش دیده شود. یعنی «مرتبط‌ترین
 *    تست» همیشه اولین قربانی بود.
 *
 * ۲. **وسط آیتم می‌بُرد.** خروجی می‌توانست به «`- src/foo/ba`» ختم
 *    شود؛ یک سطر ناقص که مدل باید حدس بزند.
 *
 * ۳. **از بودجه رد می‌شد (SE-AI-16).** طول `'\n\n[Context truncated]'`
 *    *بعد* از برش اضافه می‌شد. اندازه‌گیری: درخواست ۴۰۰ توکن، خروجی
 *    ۴۰۶ توکن. برای مصرف‌کننده‌ای که پنجرهٔ prompt را بر همان عدد
 *    می‌بندد، این یعنی سرریز.
 *
 * ## الگوریتم
 *
 * ```
 * ۱. preamble و سرصفحه‌ها را از بودجه کم کن (هزینهٔ ساختار).
 * ۲. پاس تضمین  — هر بخشِ دارای guarantee تا کفِ سهمش پر می‌شود،
 *                  به ترتیب امتیاز نزولی؛ و دست‌کم پرامتیازترین
 *                  آیتمش را می‌گیرد اگر بودجهٔ کل جا داشته باشد.
 * ۳. پاس سراسری — هرچه مانده، از میان همهٔ آیتم‌های باقی‌مانده و
 *                  بر اساس امتیاز نزولی برداشته می‌شود.
 * ```
 *
 * دو نکتهٔ رفتاری که عمدی‌اند و آزمون دارند:
 *
 * - **تضمین کف است، نه سقف.** بخشِ تضمین‌دار در پاس دوم هم رقابت
 *   می‌کند؛ با بودجهٔ کافی همهٔ آیتم‌هایش را می‌گیرد.
 * - **آیتمِ جانشدنی، صف را نمی‌بندد.** اگر پرامتیازترین باقی‌مانده
 *   جا نشود، از آن رد می‌شویم و سراغ بعدی می‌رویم. این ترتیبِ اکید
 *   امتیاز را می‌شکند ولی بودجه را هدر نمی‌دهد؛ معاوضهٔ آگاهانه‌ای
 *   است به نفعِ چگالیِ اطلاعات.
 *
 * ## تخمین توکن
 *
 * چهار کاراکتر ≈ یک توکن. همان قاعدهٔ قبلی، ولی حالا در یک تابع
 * متمرکز است تا هر جا که بودجه حساب می‌شود یکسان باشد. تخمین است نه
 * اندازه‌گیری؛ SE-AI-09 نشان داده بود که فرمول‌های پراکندهٔ توکن در
 * این مخزن با هم نمی‌خواندند.
 */

/** چهار کاراکتر ≈ یک توکن، رو به بالا. */
export function estimateTokens(text: string): number {
  return estimateTokensFromLength(text.length);
}

/**
 * همان تخمین، وقتی فقط *طول* را داری و نه خودِ متن.
 *
 * `AiMetadataGenerator` اندازهٔ فایل را از ایندکس دارد و محتوایش را
 * ندارد؛ ساختنِ یک رشتهٔ به آن بزرگی فقط برای شمردنش، چند مگابایت
 * تخصیصِ بی‌مصرف است.
 */
export function estimateTokensFromLength(length: number): number {
  return Math.ceil(Math.max(0, length) / 4);
}

export interface BudgetItem {
  readonly id: string;
  /** یک سطر کامل؛ هرگز وسطش بریده نمی‌شود. */
  readonly text: string;
  /** بازهٔ ۰..۱ — معمولاً از `ContextRanker`. */
  readonly score: number;
}

export interface BudgetSection {
  readonly name: string;
  /** سرصفحه‌ای که فقط وقتی چاپ می‌شود که بخش دست‌کم یک آیتم نگه دارد. */
  readonly header?: string;
  readonly items: readonly BudgetItem[];
  /**
   * کفِ سهم این بخش از بودجه، بازهٔ ۰..۱. اگر مجموع تضمین‌ها از یک
   * بگذرد، همه به نسبت کوچک می‌شوند.
   */
  readonly guarantee?: number;
}

export interface SectionReport {
  readonly name: string;
  readonly kept: number;
  readonly dropped: number;
  readonly tokens: number;
  /**
   * شناسهٔ آیتم‌هایی که واقعاً نوشته شدند، به همان ترتیبِ خروجی.
   *
   * بدون این، مصرف‌کننده مجبور است با `text.includes(...)` حدس بزند
   * چه چیزی جا شده — که هم کند است و هم وقتی متنِ دو آیتم پیشوند هم
   * باشد غلط جواب می‌دهد.
   */
  readonly keptIds: readonly string[];
}

export interface BudgetResult {
  readonly text: string;
  readonly usedTokens: number;
  readonly maxTokens: number;
  readonly sections: readonly SectionReport[];
  /** آیا حتی یک آیتم افتاد. */
  readonly truncated: boolean;
}

export interface BudgetOptions {
  readonly maxTokens: number;
  /** متنی که پیش از همهٔ بخش‌ها می‌آید (مثلاً شرح task). */
  readonly preamble?: string;
  /** نشانگری که وقتی چیزی افتاده به انتها اضافه می‌شود. */
  readonly truncationMarker?: string;
}

/*
| نشانگر عمداً کوتاه است. نسخهٔ اول این ماژول یک جملهٔ کامل بود
| (۱۷ توکن) و روی بودجه‌های کوچک، *خودِ اطلاع‌رسانیِ بریدگی* بیشتر از
| محتوا جا می‌گرفت — با بودجهٔ ۳۰ توکن هیچ آیتمی باقی نمی‌ماند و
| خروجی فقط نشانگر بود. محتوا بر اطلاع‌رسانی مقدم است.
*/
const DEFAULT_MARKER = '[context truncated]';

interface Pick {
  readonly sectionIndex: number;
  readonly item: BudgetItem;
  readonly tokens: number;
}

export class TokenBudget {
  assemble(sections: readonly BudgetSection[], options: BudgetOptions): BudgetResult {
    const maxTokens = Math.max(0, Math.floor(options.maxTokens));
    const marker = options.truncationMarker ?? DEFAULT_MARKER;

    const emptyReports = sections.map(s => ({
      name: s.name,
      kept: 0,
      dropped: s.items.length,
      tokens: 0,
      keptIds: [] as readonly string[],
    }));

    if (maxTokens === 0) {
      return {
        text: '',
        usedTokens: 0,
        maxTokens,
        sections: emptyReports,
        truncated: sections.some(s => s.items.length > 0),
      };
    }

    /*
    | هزینهٔ ساختار پیش از هر انتخابی کنار گذاشته می‌شود. اگر بعد از
    | انتخابِ آیتم‌ها حساب شود، خروجی از بودجه رد می‌کند — دقیقاً همان
    | چیزی که SE-AI-16 روی نشانگرِ بریدگی نشان داد.
    |
    | هر خط یک `\n` هم می‌خواهد؛ در تخمین چهارکاراکتری، `+1` روی طول
    | متنِ خط این را می‌پوشاند.
    */
    const lineTokens = (text: string): number => estimateTokens(text + '\n');

    const preamble = options.preamble ?? '';
    const preambleTokens = preamble ? lineTokens(preamble) + 1 : 0;

    if (preambleTokens > maxTokens) {
      return {
        text: '',
        usedTokens: 0,
        maxTokens,
        sections: emptyReports,
        truncated: true,
      };
    }

    // سرصفحه‌ها فقط برای بخش‌هایی که آیتم دارند هزینه دارند.
    const headerTokens = sections.map(s =>
      s.header && s.items.length > 0 ? lineTokens(s.header) + 1 : 0
    );

    let remaining = maxTokens - preambleTokens;

    const chosen: Pick[][] = sections.map(() => []);
    const taken = new Set<string>();
    const sectionOpen = sections.map(() => false);

    /** بازکردن یک بخش، هزینهٔ سرصفحه‌اش را یک‌بار برمی‌دارد. */
    const openCost = (index: number): number => (sectionOpen[index] ? 0 : headerTokens[index]);

    const tryTake = (sectionIndex: number, item: BudgetItem, ceiling: number): boolean => {
      const cost = lineTokens(item.text) + openCost(sectionIndex);
      if (cost > ceiling) return false;
      chosen[sectionIndex].push({ sectionIndex, item, tokens: lineTokens(item.text) });
      taken.add(`${sectionIndex}::${item.id}`);
      if (!sectionOpen[sectionIndex]) sectionOpen[sectionIndex] = true;
      remaining -= cost;
      return true;
    };

    const byScore = (a: BudgetItem, b: BudgetItem): number =>
      b.score - a.score || a.id.localeCompare(b.id);

    /*
    | پاس ۱ — تضمین‌ها.
    |
    | اگر مجموع تضمین‌ها از ۱ بگذرد به نسبت کوچک می‌شوند، وگرنه یک
    | بخش می‌تواند بودجهٔ بخش دیگر را ببلعد و «تضمین» بی‌معنی شود.
    */
    const guarantees = sections.map(s => Math.max(0, Math.min(1, s.guarantee ?? 0)));
    const guaranteeSum = guarantees.reduce((a, b) => a + b, 0);
    const scale = guaranteeSum > 1 ? 1 / guaranteeSum : 1;

    for (let i = 0; i < sections.length; i++) {
      if (guarantees[i] === 0 || sections[i].items.length === 0) continue;

      const floor = Math.floor(guarantees[i] * scale * maxTokens);
      let spent = 0;
      const ordered = [...sections[i].items].sort(byScore);

      for (const item of ordered) {
        const cost = lineTokens(item.text) + openCost(i);
        const isFirst = chosen[i].length === 0;

        /*
        | «دست‌کم یکی» — بخشِ تضمین‌دار باید پرامتیازترین آیتمش را
        | بگیرد حتی اگر آن آیتم به‌تنهایی از کفِ سهم بزرگ‌تر باشد،
        | به شرطی که بودجهٔ کل جا داشته باشد. بدون این قاعده، یک
        | بخش با آیتم‌های بلند در بودجه‌های کوچک همیشه خالی می‌ماند
        | و معیار پذیرش فاز ۴۲ نقض می‌شود.
        */
        const ceiling = isFirst ? remaining : Math.min(remaining, floor - spent);
        if (!tryTake(i, item, ceiling)) continue;
        spent += cost;
      }
    }

    /*
    | پاس ۲ — استخر سراسری. هرچه از بودجه مانده، صرفِ پرامتیازترین
    | آیتم‌های باقی‌مانده می‌شود، بی‌توجه به اینکه از کدام بخش‌اند.
    */
    const pool: Array<{ sectionIndex: number; item: BudgetItem }> = [];
    for (let i = 0; i < sections.length; i++) {
      for (const item of sections[i].items) {
        if (!taken.has(`${i}::${item.id}`)) pool.push({ sectionIndex: i, item });
      }
    }
    pool.sort((a, b) => byScore(a.item, b.item));

    /*
    | برای نشانگرِ بریدگی جا رزرو **نمی‌شود**.
    |
    | نسخهٔ اول رزرو می‌کرد و نتیجه‌اش این بود که با بودجهٔ ۳۰ توکن،
    | تنها آیتمِ موجود (۲۵ توکن) جا نمی‌شد و خروجی فقط نشانگر بود:
    | بودجه صرفِ اعلامِ نبودِ محتوا می‌شد. محتوا مقدم است؛ نشانگر در
    | پایان و فقط اگر جا داشته باشد اضافه می‌شود. مصرف‌کننده‌ای که به
    | یقین نیاز دارد، `result.truncated` را دارد که هرگز دروغ
    | نمی‌گوید.
    */
    const poolCeiling = remaining;
    let poolSpent = 0;

    for (const entry of pool) {
      const cost = lineTokens(entry.item.text) + openCost(entry.sectionIndex);
      // ردشدن از آیتم جانشدنی، به‌جای شکستن حلقه.
      if (poolSpent + cost > poolCeiling) continue;
      tryTake(entry.sectionIndex, entry.item, remaining);
      poolSpent += cost;
    }

    // رندر
    const lines: string[] = [];
    if (preamble) lines.push(preamble, '');

    const reports: SectionReport[] = [];
    for (let i = 0; i < sections.length; i++) {
      const picks = chosen[i];
      const declaredOrder = new Map(sections[i].items.map((it, idx) => [it.id, idx]));
      picks.sort(
        (a, b) => (declaredOrder.get(a.item.id) ?? 0) - (declaredOrder.get(b.item.id) ?? 0)
      );

      if (picks.length > 0) {
        if (sections[i].header) lines.push(sections[i].header as string);
        for (const p of picks) lines.push(p.item.text);
        lines.push('');
      }

      reports.push({
        name: sections[i].name,
        kept: picks.length,
        dropped: sections[i].items.length - picks.length,
        tokens: picks.reduce((sum, p) => sum + p.tokens, 0),
        keptIds: picks.map(p => p.item.id),
      });
    }

    const droppedAny = reports.some(r => r.dropped > 0);

    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

    /*
    | نشانگر فقط اگر *واقعاً جا داشته باشد* چاپ می‌شود.
    |
    | رزروِ پاس دوم یک تخمین است، نه تضمین: پاس تضمین‌ها پیش از آن
    | اجرا شده و می‌تواند بودجه را تا ته مصرف کند. اگر نشانگر را
    | بی‌قید اضافه کنیم، همان سرریزی رخ می‌دهد که SE-AI-16 توصیفش
    | می‌کند — فقط این بار از سمت ما.
    */
    let text = lines.join('\n');
    if (droppedAny) {
      const withMarker = text ? `${text}\n${marker}` : marker;
      if (estimateTokens(withMarker) <= maxTokens) text = withMarker;
    }

    return {
      text,
      usedTokens: estimateTokens(text),
      maxTokens,
      sections: reports,
      truncated: droppedAny,
    };
  }
}
