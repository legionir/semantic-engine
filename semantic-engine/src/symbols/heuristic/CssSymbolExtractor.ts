/**
 * CssSymbolExtractor — استخراج symbol از فایل‌های CSS / SCSS / Less.
 *
 * - selector های class (`.btn`) و id (`#header`) و tag (`body`) به‌عنوان property symbol.
 * - `@media`, `@keyframes`, `@supports`, `@import` به‌عنوان module symbol.
 * - SCSS/Less nested selectors را فعلاً flatten می‌کنیم (هر selector یک symbol مجزا).
 *
 * ── SE-SYM-30 ─────────────────────────────────────────────────────
 *
 * دو نقص که با هم یک باگ می‌ساختند:
 *
 *   ۱. `extractPrimarySelector` از `.panel > h2` فقط `.panel` را
 *      برمی‌گرداند — «اولین class» به‌جای selector.
 *   ۲. dedupe بر پایهٔ `نام + نوع` بود، پس آن `.panel`ِ ساختگی با
 *      قاعدهٔ `.panel` واقعی تصادم می‌کرد و **بی‌صدا حذف** می‌شد.
 *
 * روی یک فایل با چهار قاعده (`.panel`, `.panel > h2`, `.panel .body`,
 * و دوباره `.panel`)، خروجی **یک** symbol بود.
 *
 * ── تصمیم: هر قاعده یک symbol ─────────────────────────────────────
 *
 * برنامه صریحاً می‌پرسید: سه قاعده برای `.panel` سه symbol‌اند یا یکی
 * با سه بازه؟ جواب: سه تا.
 *
 * یک قاعدهٔ CSS واحدی با مکان و اعلان‌های خودش است، و مصرف‌کننده‌ای
 * که می‌پرسد «`.panel` کجا تعریف شده؟» انتظار همهٔ مکان‌ها را دارد.
 * جایگزینش — یک symbol با آرایه‌ای از بازه‌ها — تغییر قرارداد
 * می‌خواهد (`SymbolEntry` یک `line` و یک `endLine` دارد) و همان
 * اطلاعات را گران‌تر می‌دهد.
 *
 * `SymbolIdAllocator` (فاز ۱۵) دقیقاً برای این ساخته شده: عضو اول
 * نام خالص را نگه می‌دارد و بقیه ordinal می‌گیرند.
 */

import { ISymbolExtractor, SymbolExtractionResult } from '../ISymbolExtractor';
import { SymbolEntry, SymbolKind } from '../../core/types/project-index.types';
import { ExtractionSource, Result, ok, makeConfidence } from '../../core/types/common.types';
import { getLineNumber } from '../../core/utils/lineNumber';
import { findMatchingDelimiter } from './BlockRange';
import { SymbolIdAllocator } from '../../core/id/SymbolIdentity';

export class CssSymbolExtractor implements ISymbolExtractor {
  readonly name: ExtractionSource = 'heuristic';
  readonly priority = 10;

  async isAvailable(languageId: string): Promise<boolean> {
    return languageId === 'css' || languageId === 'scss' || languageId === 'less';
  }

  async extract(
    fileId: string,
    filePath: string,
    content: string,
    _languageId: string
  ): Promise<Result<SymbolExtractionResult>> {
    const symbols: SymbolEntry[] = [];
    const allocator = new SymbolIdAllocator();

    const endLineOfBlock = (openBraceIndex: number, line: number): number => {
      if (openBraceIndex < 0) return line;
      const close = findMatchingDelimiter(content, openBraceIndex);
      return close === -1 ? line : getLineNumber(content, close);
    };

    const addSymbol = (name: string, kind: SymbolKind, line: number, endLine = line) => {
      const allocated = allocator.allocate({ filePath, parentFqName: null, name, kind });

      symbols.push({
        id: allocated.id,
        fileId,
        parentId: null,
        kind,
        name,
        fullyQualifiedName: allocated.fullyQualifiedName,
        line,
        endLine,
        source: 'heuristic',
        confidence: makeConfidence(65),
      });
    };

    // At-rules: @media, @keyframes, @supports, @import
    const atRuleRegex = /@(media|keyframes|supports|import|font-face|charset|namespace)\b/gi;
    let match: RegExpExecArray | null;
    while ((match = atRuleRegex.exec(content)) !== null) {
      const atName = match[1]!;
      const line = getLineNumber(content, match.index);

      /*
      | at-rule یا بلوک دارد (`@media { … }`) یا با `;` تمام می‌شود
      | (`@import url(…);`). هرکدام زودتر بیاید، پایان همان است.
      */
      const brace = content.indexOf('{', match.index);
      const semicolon = content.indexOf(';', match.index);
      const hasBlock = brace !== -1 && (semicolon === -1 || brace < semicolon);

      addSymbol(
        `@${atName}`,
        'module',
        line,
        hasBlock
          ? endLineOfBlock(brace, line)
          : (semicolon === -1 ? line : getLineNumber(content, semicolon))
      );
    }

    // Selectors: تا قبل از { یا , یا ; یا newline
    // سعی می‌کنیم block های CSS را پیدا کنیم و selector هایشان را استخراج کنیم.
    const blockRegex = /([^{]+)\{/g;
    while ((match = blockRegex.exec(content)) !== null) {
      const raw = match[1]!;

      /*
      | SE-SYM-24 — گروه `[^{]+` از درست بعد از `{` قبلی شروع می‌شود،
      | پس اعلان‌ها، `}`های بسته و خطوط خالیِ بین دو قاعده را هم در بر
      | می‌گیرد. گرفتن شماره خط از `match.index` یعنی هر selector شماره
      | خط *قاعدهٔ قبلی* را می‌گرفت — روی یک media query تودرتو،
      | `.card` خط ۱ و `.plain` خط ۲ ثبت می‌شدند، به‌جای ۲ و ۶.
      |
      | selector واقعی چیزی است که بعد از آخرین `}` یا `;` می‌آید.
      */
      const lastBoundary = Math.max(raw.lastIndexOf('}'), raw.lastIndexOf(';'));
      const selectorStart = lastBoundary + 1;
      const selectorRaw = raw.slice(selectorStart);
      const leadingSpace = selectorRaw.length - selectorRaw.trimStart().length;

      const selectorGroup = selectorRaw.trim();
      if (!selectorGroup) continue;

      const line = getLineNumber(content, match.index + selectorStart + leadingSpace);
      // ایندکس خودِ `{` — انتهای چیزی که regex گرفته است
      const braceIndex = match.index + match[0].length - 1;
      const blockEnd = endLineOfBlock(braceIndex, line);
      const selectors = selectorGroup.split(',').map(s => s.trim()).filter(Boolean);

      for (const selector of selectors) {
        // نادیده گرفتن nested SCSS rule هایی که با & شروع می‌شوند یا pseudo
        if (selector.startsWith('&') || selector.startsWith(':')) continue;

        /*
        | مقدمهٔ at-rule، selector نیست. `extractPrimarySelector` قبلی
        | برای `@media (max-width: 600px)` مقدار `null` می‌داد و
        | اتفاقاً ردش می‌کرد؛ حالا که نام کاملِ selector برداشته
        | می‌شود، باید صریح رد شود — وگرنه همان at-rule دو بار ثبت
        | می‌شود: یک بار `module` و یک بار `property`.
        */
        if (selector.startsWith('@')) continue;

        /*
        | نام symbol، **کل selector نرمال‌شده** است نه اولین class آن.
        | `.panel > h2` یک قاعدهٔ متفاوت از `.panel` است و ادغامشان
        | یعنی یکی از دو تعریف را دور بریزیم.
        */
        const normalized = normalizeSelector(selector);
        if (normalized) {
          addSymbol(normalized, 'property', line, blockEnd);
        }
      }
    }

    return ok({
      symbols,
      source: 'heuristic',
      partial: false,
      warnings: [],
    });
  }

  async dispose(): Promise<void> {}
}

/**
 * یک شکل قطعی برای هر selector.
 *
 * فاصله‌های اضافی جمع می‌شوند و ترکیب‌گرها (`>`, `+`, `~`) دقیقاً یک
 * فاصله در دو طرف می‌گیرند، پس `.a    >     .b` و `.a>.b` یک نام
 * می‌دهند. بدون این، دو نوشتار از یک قاعده دو symbol می‌شدند.
 */
export function normalizeSelector(selector: string): string | null {
  const collapsed = selector
    .replace(/\s+/g, ' ')
    .replace(/\s*([>+~])\s*/g, ' $1 ')
    .trim();
  return collapsed.length > 0 ? collapsed : null;
}
