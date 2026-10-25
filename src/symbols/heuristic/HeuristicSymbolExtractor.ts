/**
 * HeuristicSymbolExtractor — استخراج symbol با regex برای زبان‌هایی که LSP ندارند.
 *
 * پشتیبانی‌شده:
 * - Python: def, class, async def
 * - Go: func, method
 * - PHP: function, class, interface, trait
 * - Bash: function name() { ... }
 *
 * بهبودهای گام ۴:
 * - nested symbols با parentId صحیح (بر اساس indentation)
 * - documentation از comment / docstring
 * - parameters و signature
 * - visibility
 */

import { ISymbolExtractor, SymbolExtractionResult } from '../ISymbolExtractor';
import { SymbolEntry, SymbolKind } from '../../core/types/project-index.types';
import { ExtractionSource, Result, ok, makeConfidence } from '../../core/types/common.types';
import {
  PendingSymbol,
  extractDocumentation,
  extractVisibility,
  extractParameters,
  buildSignature,
  findParentByIndentation,
  getIndent,
  readSignatureText,
} from './SymbolExtractionHelpers';
import { findBlockEnd, blockStyleFor } from './BlockRange';
import { SymbolIdAllocator } from '../../core/id/SymbolIdentity';
import { maskLiteralsAndComments, isKeywordCallSite } from './LiteralMask';

interface LanguagePatterns {
  readonly functionRegex: RegExp;
  readonly classRegex?: RegExp;
  readonly methodRegex?: RegExp;
  readonly kinds: {
    readonly function: SymbolKind;
    readonly class: SymbolKind;
    readonly method: SymbolKind;
  };
}

/**
 * بررسی اینکه آیا یک خط احتمالاً داخل block interface قرار دارد.
 * ساده‌سازی: اگر یکی از خطوط قبلی با `type ... interface {` شروع شده باشد.
 */
function isInsideGoInterface(lines: string[], lineIndex: number): boolean {
  let insideInterface = false;
  for (let i = lineIndex - 1; i >= 0; i--) {
    const trimmed = lines[i]!.trim();
    if (trimmed === '') continue;
    if (/^type\s+\w+\s+interface\s*\{/.test(trimmed)) {
      insideInterface = true;
      break;
    }
    if (trimmed === '}' || /^type\s+/.test(trimmed)) {
      break;
    }
  }
  return insideInterface;
}

const LANGUAGE_PATTERNS: Readonly<Record<string, LanguagePatterns>> = {
  typescript: {
    functionRegex: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[<(]/gm,
    classRegex: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/gm,
    kinds: { function: 'function', class: 'class', method: 'method' },
  },
  typescriptreact: {
    functionRegex: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[<(]/gm,
    classRegex: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/gm,
    kinds: { function: 'function', class: 'class', method: 'method' },
  },
  javascript: {
    functionRegex: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[<(]/gm,
    classRegex: /^\s*(?:export\s+)?class\s+(\w+)/gm,
    kinds: { function: 'function', class: 'class', method: 'method' },
  },
  javascriptreact: {
    functionRegex: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[<(]/gm,
    classRegex: /^\s*(?:export\s+)?class\s+(\w+)/gm,
    kinds: { function: 'function', class: 'class', method: 'method' },
  },
  python: {
    functionRegex: /^\s*(?:async\s+)?def\s+(\w+)\s*\(/gm,
    classRegex: /^\s*class\s+(\w+)(?:\s*[(:])/gm,
    kinds: { function: 'function', class: 'class', method: 'method' },
  },
  go: {
    functionRegex: /^\s*func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(/gm,
    classRegex: /^\s*type\s+(\w+)\s+interface\s*\{/gm,
    methodRegex: /^\s*(\w+)\s*\([^)]*\)\s*\(/gm,
    kinds: { function: 'function', class: 'interface', method: 'method' },
  },
  php: {
    functionRegex: /^\s*(?:public|private|protected|static|\s)*function\s+(\w+)\s*\(/gim,
    classRegex: /^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait)\s+(\w+)/gim,
    kinds: { function: 'function', class: 'class', method: 'method' },
  },
  shellscript: {
    functionRegex: /^\s*(?:function\s+)?(\w+)\s*\(\s*\)\s*\{/gm,
    kinds: { function: 'function', class: 'class', method: 'method' },
  },
};

export class HeuristicSymbolExtractor implements ISymbolExtractor {
  readonly name: ExtractionSource = 'heuristic';
  readonly priority = 10;

  async isAvailable(languageId: string): Promise<boolean> {
    return languageId in LANGUAGE_PATTERNS;
  }

  async extract(
    fileId: string,
    filePath: string,
    content: string,
    languageId: string
  ): Promise<Result<SymbolExtractionResult>> {
    const patterns = LANGUAGE_PATTERNS[languageId];
    if (!patterns) {
      return ok({
        symbols: [],
        source: 'heuristic',
        partial: false,
        warnings: [`No heuristic patterns for language: ${languageId}`],
      });
    }

    const lines = content.split('\n');

    /*
    | SE-SYM-20 — الگوها روی متن *پوشانده‌شده* اجرا می‌شوند، نه خام.
    | یک نمونهٔ کد داخل کامنت یا یک قطعه داخل رشته، تعریف تابع نیست.
    | پوشاندن هم‌طول است، پس `match.index` و شماره خط دست‌نخورده
    | می‌مانند و متن اصلی برای امضا و مستندسازی استفاده می‌شود.
    */
    const masked = maskLiteralsAndComments(content, languageId);
    const pending: PendingSymbol[] = [];

    // تابع کمکی برای پیدا کردن نمادها
    const collectMatches = (
      regex: RegExp,
      kind: SymbolKind,
      contextFilter?: (lineIndex: number) => boolean
    ) => {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(masked)) !== null) {
        const name = match[1]!;
        // line number را بر اساس موقعیت نام symbol محاسبه می‌کنیم (نه ابتدای match)
        // تا leading whitespace/ newline در regex روی شماره خط تأثیر نگذارد.
        const nameIndex = masked.indexOf(name, match.index);
        const line = this.getLineNumber(content, nameIndex);
        const lineIndex = line - 1;
        if (contextFilter && !contextFilter(lineIndex)) continue;

        const definitionLine = lines[lineIndex] ?? '';
        if (isKeywordCallSite(definitionLine, name)) continue;

        const indent = getIndent(definitionLine);
        pending.push({
          name,
          kind,
          line,
          indent,
          definitionLine,
          signatureText: readSignatureText(lines, lineIndex),
        });
      }
    };

    collectMatches(patterns.functionRegex, patterns.kinds.function);
    if (patterns.classRegex) {
      collectMatches(patterns.classRegex, patterns.kinds.class);
    }
    /*
    | SE-SYM-25 — `methodRegex` فقط برای Go معنی دارد: متدهای interface
    | در Go کلمهٔ `func` ندارند. تعریفش در پیکربندی TS/JS پیکربندی
    | مرده و گمراه‌کننده بود و حذف شد.
    */
    if (patterns.methodRegex && languageId === 'go') {
      collectMatches(patterns.methodRegex, patterns.kinds.method, lineIndex => isInsideGoInterface(lines, lineIndex));
    }

    // مرتب‌سازی بر اساس خط
    pending.sort((a, b) => a.line - b.line);

    /*
    | کلید یکتایی: نام + نوع + **خط**.
    |
    | همان چیزی که SE-SYM-18 می‌خواست. دو تعریف هم‌نام در دو خط، دو
    | symbol‌اند؛ ولی یک تعریف که دو الگوی همپوشان هر دو بگیرندش —
    | مثلاً `static int f(` که هم الگوی `static` و هم الگوی عمومی C
    | آن را می‌گیرد — یک symbol است. تا پیش از فاز ۱۵ این را dedupe
    | بر اساس شناسه پنهان می‌کرد، که به قیمت حذف overloadهای واقعی
    | تمام می‌شد.
    */
    const uniquePending: PendingSymbol[] = [];
    const seenAt = new Set<string>();
    for (const candidate of pending) {
      const key = `${candidate.name}:${candidate.kind}:${candidate.line}`;
      if (seenAt.has(key)) continue;
      seenAt.add(key);
      uniquePending.push(candidate);
    }
    pending.length = 0;
    pending.push(...uniquePending);

    const blockStyle = blockStyleFor(languageId);

    // تبدیل pending → SymbolEntry
    const symbols: SymbolEntry[] = [];
    const idByPending = new Map<PendingSymbol, string>();
    const fqNameByPending = new Map<PendingSymbol, string>();
    const allocator = new SymbolIdAllocator();

    for (const sym of pending) {
      // برای Python متدهای داخل class باید kind = method باشند
      let kind = sym.kind;
      if (languageId === 'python' && sym.kind === 'function') {
        const parent = findParentByIndentation(pending, sym.indent, sym.line);
        if (parent && (parent.kind === 'class' || parent.kind === 'interface')) {
          kind = 'method';
        }
      }

      // برای Go متدهای داخل interface
      if (languageId === 'go' && sym.kind === 'function') {
        const parent = findParentByIndentation(pending, sym.indent, sym.line);
        if (parent && parent.kind === 'interface') {
          kind = 'method';
        }
      }

      // برای PHP متدهای داخل class/interface/trait
      if (languageId === 'php' && sym.kind === 'function') {
        const parent = findParentByIndentation(pending, sym.indent, sym.line);
        if (parent && parent.kind === 'class') {
          kind = 'method';
        }
      }

      /*
      | SE-SYM-18 — اینجا قبلاً `if (seenIds.has(id)) continue;` بود.
      | کلید فقط `مسیر + نام + نوع` بود، پس overloadهای هم‌نام،
      | متدهای هم‌نام دو کلاسِ یک فایل و توابع هم‌نام دو دامنه همگی
      | به یک رکورد فرو می‌ریختند و بقیه **بی‌صدا حذف** می‌شدند.
      | شمارندهٔ ترتیبی، همه را نگه می‌دارد بدون اینکه شناسه به شماره
      | خط وابسته شود.
      */
      const parentForId = findParentByIndentation(pending, sym.indent, sym.line);
      const allocated = allocator.allocate({
        filePath,
        parentFqName: parentForId ? fqNameByPending.get(parentForId) ?? null : null,
        name: sym.name,
        kind,
      });
      const id = allocated.id;
      idByPending.set(sym, id);
      fqNameByPending.set(sym, allocated.fullyQualifiedName);

      const parentId = parentForId ? idByPending.get(parentForId) ?? null : null;

      const parameters = extractParameters(sym.signatureText ?? sym.definitionLine, languageId);
      const signature = buildSignature(sym.name, parameters, languageId, kind, sym.definitionLine);
      const documentation = extractDocumentation(lines, sym.line, languageId);
      const visibility = extractVisibility(sym.definitionLine, languageId);

      symbols.push({
        id,
        fileId,
        parentId,
        kind,
        name: sym.name,
        /*
        | SE-DATA-12 — تا فاز ۱۵ هیچ symbol heuristicی نام کامل نداشت،
        | و چون مسیر heuristic تنها مسیر فعال برای بیشتر زبان‌هاست،
        | این فیلد در عمل همیشه خالی بود (۰ از ۸۵ در snapshot). حالا
        | که allocator نام کامل را می‌سازد، پر کردنش رایگان است.
        */
        fullyQualifiedName: allocated.fullyQualifiedName,
        line: sym.line,
        endLine: findBlockEnd(lines, sym.line, blockStyle),
        signature,
        visibility,
        documentation,
        source: 'heuristic',
        confidence: makeConfidence(65),
        parameters,
      });
    }

    return ok({
      symbols,
      source: 'heuristic',
      partial: false,
      warnings: [],
    });
  }

  private getLineNumber(content: string, index: number): number {
    return content.substring(0, index).split('\n').length;
  }

  async dispose(): Promise<void> {}
}
