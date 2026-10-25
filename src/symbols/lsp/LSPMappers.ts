/**
 * تبدیل symbolهای یک زبان‌سرور به تایپ‌های schema.
 *
 * این فایل قبلاً `vscode.DocumentSymbol` می‌گرفت و جدول `SymbolKind`اش
 * صفرمبنا بود. حالا روی `DocumentSymbolLike` کار می‌کند و شماره‌گذاری
 * را از فراخوان می‌پرسد — چون همان عدد در دو دنیا دو معنی دارد و
 * اشتباهش هیچ خطایی تولید نمی‌کند. توضیح کامل در `../types.ts`.
 */

import {
  SymbolEntry,
  SymbolKind,
  SymbolVisibility,
  Parameter,
} from '../../core/types/project-index.types';
import { makeConfidence, Confidence } from '../../core/types/common.types';
import { SymbolIdAllocator } from '../../core/id/SymbolIdentity';
import { LanguageRegistry } from '../../language/LanguageRegistry';
import {
  DocumentSymbolLike,
  LspSymbolKind,
  VsCodeSymbolKind,
  SymbolTagLike,
  lspKindFromVsCode,
} from '../types';
import { declarationSignature } from '../heuristic/SymbolExtractionHelpers';

/**
 * LSP → schema.
 *
 * پروتکل ۲۶ نوع دارد و schema ما ۱۴ تا؛ موارد بدون معادل به نزدیک‌ترین
 * نوع می‌روند.
 */
export function mapLspSymbolKind(kind: LspSymbolKind | number): SymbolKind {
  switch (kind) {
    case LspSymbolKind.Class:
      return 'class';
    case LspSymbolKind.Interface:
      return 'interface';
    case LspSymbolKind.Enum:
      return 'enum';
    case LspSymbolKind.Struct:
      return 'struct';
    case LspSymbolKind.Function:
      return 'function';
    case LspSymbolKind.Method:
    case LspSymbolKind.Constructor:
      return 'method';
    case LspSymbolKind.Variable:
      return 'variable';
    case LspSymbolKind.Constant:
      return 'constant';
    case LspSymbolKind.Namespace:
      return 'namespace';
    case LspSymbolKind.Module:
    case LspSymbolKind.Package:
    case LspSymbolKind.File:
      return 'module';
    case LspSymbolKind.Property:
    case LspSymbolKind.Field:
    case LspSymbolKind.Event:
      return 'property';
    case LspSymbolKind.TypeParameter:
      return 'type-alias';
    case LspSymbolKind.EnumMember:
      return 'constant';
    case LspSymbolKind.Operator:
      return 'function';
    case LspSymbolKind.Array:
    case LspSymbolKind.Object:
    case LspSymbolKind.Key:
    case LspSymbolKind.Null:
    case LspSymbolKind.Number:
    case LspSymbolKind.String:
    case LspSymbolKind.Boolean:
      return 'variable';
    default:
      /*
      | عمداً پرتاب می‌کند و به `variable` نمی‌افتد: یک عدد خارج از
      | بازه یعنی طرف مقابل جدول دیگری دارد، و بلعیدنش همان اشتباهی
      | است که این فاز برای رفعش هست.
      */
      throw new RangeError(`Not an LSP SymbolKind: ${kind} (expected 1…26)`);
  }
}

/** VS Code → schema، همیشه از مسیر تبدیل صریح شماره‌گذاری. */
export function mapVSCodeSymbolKind(kind: VsCodeSymbolKind | number): SymbolKind {
  return mapLspSymbolKind(lspKindFromVsCode(kind));
}

export interface FlattenOptions {
  readonly fileId: string;
  readonly filePath: string;
  /**
   * از کدام جدول آمده است. اجباری است تا کسی نتواند بی‌فکر عبور کند —
   * اشتباه اینجا خاموش است و کل ایندکس را یک رده می‌لغزاند.
   */
  readonly kindNumbering: 'lsp' | 'vscode';
  /** برای `inferVisibility`؛ اگر داده نشود از پسوند فایل حدس زده می‌شود. */
  readonly language?: string;
  readonly parentId?: string | null;
  readonly parentFqName?: string;
}

const languageRegistry = new LanguageRegistry();

/**
 * `DocumentSymbol` درختی → `SymbolEntry[]` تخت، با حفظ `parentId`.
 *
 * تضمین‌ها: هیچ id تکراری، و ترتیب ظاهر شدن حفظ می‌شود.
 */
export function flattenDocumentSymbols(
  symbols: readonly DocumentSymbolLike[],
  options: FlattenOptions
): SymbolEntry[] {
  const language = options.language ?? detectLanguage(options.filePath);
  const toSchemaKind = options.kindNumbering === 'lsp' ? mapLspSymbolKind : mapVSCodeSymbolKind;

  return flattenWithGenerator(
    symbols,
    options,
    language,
    toSchemaKind,
    options.parentId ?? null,
    options.parentFqName ?? '',
    new SymbolIdAllocator()
  );
}

function flattenWithGenerator(
  symbols: readonly DocumentSymbolLike[],
  options: FlattenOptions,
  language: string | undefined,
  toSchemaKind: (kind: number) => SymbolKind,
  parentId: string | null,
  parentFqName: string,
  allocator: SymbolIdAllocator
): SymbolEntry[] {
  const result: SymbolEntry[] = [];

  for (const sym of symbols) {
    const kind = toSchemaKind(sym.kind);

    /*
    | تصادم با شمارندهٔ ترتیبی حل می‌شود، نه با خط و ستون. پسوند
    | مکانیِ قبلی یعنی افزودن یک خط خالی بالای فایل شناسهٔ هر symbol
    | هم‌نامی را عوض می‌کرد (SE-DATA-06).
    */
    const allocated = allocator.allocate({
      filePath: options.filePath,
      parentFqName: parentFqName || null,
      name: sym.name,
      kind,
    });
    const fqName = allocated.fullyQualifiedName;
    const id = allocated.id;

    const entry: SymbolEntry = {
      id,
      fileId: options.fileId,
      parentId,
      kind,
      name: sym.name,
      fullyQualifiedName: fqName,
      signature: buildSignature(sym, kind),
      visibility: inferVisibility(sym.name, language),
      line: sym.range.start.line + 1,        // LSP صفرمبنا → schema یک‌مبنا
      endLine: sym.range.end.line + 1,
      /*
      | SE-SYM-09 — `detail` مستندسازی نیست؛ همان چیزی است که
      | `signature` از آن ساخته شد. تکرارش فقط حجم ایندکس را بالا
      | می‌برد و خواننده را گمراه می‌کند. مستندسازی واقعی از hover
      | می‌آید (بلوک E).
      */
      documentation: null,
      deprecated: isDeprecated(sym),
      exported: false,    // LSP این را مستقیم نمی‌گوید — فاز ۴
      source: 'lsp',
      confidence: computeLSPConfidence(sym),

      async: false,
      generator: false,
      abstract: false,
      static: false,
      readonly: false,
      parameters: parseParametersFromDetail(sym.detail),
      returnType: parseReturnTypeFromDetail(sym.detail),
      generics: [],
      extends: [],
      implements: [],
      complexity: null,
      referenceCount: null,
      calls: [],
      calledBy: [],
    };

    result.push(entry);

    if (sym.children && sym.children.length > 0) {
      result.push(...flattenWithGenerator(
        sym.children,
        options,
        language,
        toSchemaKind,
        id,
        fqName,
        allocator
      ));
    }
  }

  return result;
}

function detectLanguage(filePath: string): string | undefined {
  return languageRegistry.detect(filePath)?.id;
}

function buildSignature(sym: DocumentSymbolLike, kind?: string): string {
  if (sym.detail) {
    return `${sym.name}${sym.detail.startsWith('(') ? '' : ': '}${sym.detail}`;
  }
  /*
  | زبان‌سرور برای یک کلاس معمولاً `detail` خالی می‌دهد؛ بیرون‌ازِ آن
  | `FrameMeter` تنها چیزی بود که مصرف‌کننده می‌دید، بدون اینکه بفهمد
  | کلاس است یا متغیر (SE-SYM-19).
  */
  if (kind) {
    const declaration = declarationSignature(kind, sym.name);
    if (declaration) return declaration;
  }
  return sym.name;
}

/** زبان‌هایی که دسترسی را با کلیدواژه اعلام می‌کنند، نه با نام. */
const KEYWORD_VISIBILITY_LANGUAGES = new Set([
  'java', 'csharp', 'c#', 'kotlin', 'scala', 'swift', 'php', 'cpp', 'c++', 'dart',
]);

/**
 * حدس visibility از روی نام.
 *
 * SE-SYM-08: قاعدهٔ «زیرخط یعنی خصوصی» یک قرارداد Python/TypeScript است،
 * نه یک قانون جهانی. در Go قاعده بزرگی حرف اول است و زیرخط هیچ معنایی
 * ندارد؛ در Java و C# دسترسی با کلیدواژه می‌آید و از نام هیچ‌چیز
 * برنمی‌آید — آنجا حدس زدن یعنی ساختن داده.
 */
export function inferVisibility(name: string, language?: string): SymbolVisibility {
  // فیلد خصوصی JavaScript؛ نحو زبان است، نه قرارداد.
  if (name.startsWith('#')) return 'private';

  const normalized = language?.toLowerCase();

  if (normalized === 'go') {
    /*
    | در Go صادراتی بودن با بزرگی حرف اول تعیین می‌شود. هرچیز دیگر
    | package-private است — که `internal` است، نه `private`.
    */
    const first = name.replace(/^[^\p{L}]+/u, '').charAt(0);
    return first && first === first.toUpperCase() && first !== first.toLowerCase()
      ? 'public'
      : 'internal';
  }

  if (normalized && KEYWORD_VISIBILITY_LANGUAGES.has(normalized)) {
    // بدون modifier در دست، هر ادعایی ساختگی است.
    return 'public';
  }

  // Python dunder — نحو است و عمومی
  if (name.startsWith('__') && name.endsWith('__')) return 'public';
  if (name.startsWith('_')) return 'private';
  return 'public';
}

function isDeprecated(sym: DocumentSymbolLike): boolean {
  if (sym.deprecated === true) return true;
  return (sym.tags ?? []).includes(SymbolTagLike.Deprecated);
}

/**
 * امتیاز اطمینان از روی چیزی که واقعاً در دست است.
 *
 * SE-SYM-06: پارامتر `hasHover` همیشه `false` پاس داده می‌شد، پس آن
 * شاخه کد مرده بود. حذف شد تا امتیاز نماینده‌ی واقعیت باشد.
 */
function computeLSPConfidence(sym: DocumentSymbolLike): Confidence {
  let score = 80;

  if (sym.detail && sym.detail.length > 0) score += 5;
  if (sym.children && sym.children.length > 0) score -= 3;
  if (isDeprecated(sym)) score -= 5;

  return makeConfidence(Math.max(50, Math.min(98, score)));
}

/*
| حالت‌های ماشین کوچکِ تقسیم‌کنندهٔ کاما. جدا نگه داشتنشان از شمارندهٔ
| عمق لازم است: داخل یک رشته، پرانتز و کاما فقط کاراکترند.
*/
const QUOTES = new Set(['"', "'", '`']);

/**
 * تقسیم فهرست پارامترها با کاما، با آگاهی از تودرتویی.
 *
 * SE-SYM-04: نسخهٔ قبلی هر `>` را «بستن» می‌شمرد. در یک نوع تابعی،
 * `=>` عمق را منفی می‌کرد و از آن به بعد هیچ کامایی جدا نمی‌شد —
 * یعنی `cb: () => void, retries: number` یک پارامتر می‌شد. نوع تابعی
 * در TypeScript استثنا نیست، قاعده است.
 */
export function smartSplitByComma(input: string): string[] {
  const result: string[] = [];
  let current = '';
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let index = 0; index < input.length; index++) {
    const char = input[index];

    if (quote) {
      current += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (QUOTES.has(char)) {
      quote = char;
      current += char;
      continue;
    }

    // `=>` یک فلش است، نه یک `>` بسته‌کننده.
    if (char === '=' && input[index + 1] === '>') {
      current += '=>';
      index++;
      continue;
    }

    if (char === '(' || char === '[' || char === '{' || char === '<') {
      depth++;
      current += char;
    } else if (char === ')' || char === ']' || char === '}' || char === '>') {
      /*
      | هرگز زیر صفر: یک `>` بی‌جفت (مقایسه، یا خطای تجزیه در سمت
      | زبان‌سرور) نباید بقیهٔ رشته را از کار بیندازد.
      */
      depth = Math.max(0, depth - 1);
      current += char;
    } else if (char === ',' && depth === 0) {
      if (current.trim() !== '') result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  if (current.trim() !== '') {
    result.push(current.trim());
  }

  return result;
}

/**
 * تجزیهٔ پارامترها از `detail`.
 * مثال: `"(name: string, age?: number)"` → دو پارامتر.
 */
function parseParametersFromDetail(detail: string | undefined): Parameter[] {
  if (!detail) return [];

  const inside = extractParameterList(detail);
  if (inside === null || inside.trim() === '') return [];

  return smartSplitByComma(inside).map(raw => {
    const trimmed = raw.trim();

    const isRest = trimmed.startsWith('...');
    const withoutRest = isRest ? trimmed.substring(3) : trimmed;

    const isOptional = withoutRest.includes('?');
    const withoutOptional = withoutRest.replace('?', '');

    const colonIndex = withoutOptional.indexOf(':');
    if (colonIndex === -1) {
      return {
        name: withoutOptional.trim(),
        type: null,
        optional: isOptional,
        rest: isRest,
      };
    }

    const afterColon = withoutOptional.substring(colonIndex + 1).trim();
    const equalsIndex = findDefaultValueSeparator(afterColon);
    let type: string;
    let defaultValue: string | null = null;

    if (equalsIndex !== -1) {
      type = afterColon.substring(0, equalsIndex).trim();
      defaultValue = afterColon.substring(equalsIndex + 1).trim();
    } else {
      type = afterColon;
    }

    return {
      name: withoutOptional.substring(0, colonIndex).trim(),
      type: type || null,
      optional: isOptional || defaultValue !== null,
      defaultValue,
      rest: isRest,
    };
  });
}

/**
 * محتوای اولین پرانتز، با شمارش تودرتویی.
 *
 * regex قبلی `^\(([^)]*)\)` بود که روی اولین `)` می‌ایستد — یعنی روی
 * `(cb: () => void)` فقط `cb: (` را می‌گرفت.
 */
function extractParameterList(detail: string): string | null {
  const open = detail.indexOf('(');
  if (open !== 0) return null;

  let depth = 0;
  for (let index = open; index < detail.length; index++) {
    const char = detail[index];
    if (char === '(') depth++;
    else if (char === ')') {
      depth--;
      if (depth === 0) return detail.slice(open + 1, index);
    }
  }
  return null;
}

/** `=` مقدار پیش‌فرض، نه `=` داخل یک `=>`. */
function findDefaultValueSeparator(text: string): number {
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '=') continue;
    if (text[index + 1] === '>') {
      index++;
      continue;
    }
    return index;
  }
  return -1;
}

/**
 * نوع بازگشتی از `detail`.
 * `"(name: string) => void"` → `"void"`؛ `": string[]"` → `"string[]"`.
 */
function parseReturnTypeFromDetail(detail: string | undefined): string | null {
  if (!detail) return null;

  const arrowMatch = detail.match(/\)\s*(?:=>|:)\s*(.+)$/);
  if (arrowMatch && arrowMatch[1]) {
    return arrowMatch[1].trim();
  }

  if (!detail.includes('(')) {
    const colonMatch = detail.match(/^:\s*(.+)$/);
    if (colonMatch && colonMatch[1]) {
      return colonMatch[1].trim();
    }
  }

  return null;
}
