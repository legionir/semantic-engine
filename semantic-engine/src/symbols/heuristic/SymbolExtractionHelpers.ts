/**
 * Helper utilities برای heuristic symbol extractors:
 * - استخراج documentation (comment / docstring)
 * - تشخیص visibility
 * - استخراج parameters و signature
 * - پیدا کردن parent symbol بر اساس indentation
 */

import { SymbolKind, SymbolVisibility, Parameter } from '../../core/types/project-index.types';

export interface PendingSymbol {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly line: number;
  readonly indent: number;
  readonly definitionLine: string;
  /**
   * متن امضا، که می‌تواند چند خط باشد. `definitionLine` تک‌خطی می‌ماند
   * چون تشخیص visibility و فراخوانی‌بودن، معنای «همان خط» دارند.
   */
  readonly signatureText?: string;
}

/**
 * متن امضا از خط تعریف تا جایی که پرانتزها متوازن شوند — SE-SYM-19.
 *
 * امضای چندخطی در Java و Python و Go قاعده است، نه استثنا. بدون این،
 * هر پارامتری که در خط دوم به بعد باشد از دست می‌رود.
 */
export function readSignatureText(
  lines: readonly string[],
  startLineIndex: number,
  maxLines = 20
): string {
  let depth = 0;
  let seenOpen = false;
  const parts: string[] = [];

  for (let index = startLineIndex; index < lines.length && index < startLineIndex + maxLines; index++) {
    const line = lines[index] ?? '';
    parts.push(line);

    for (const char of line) {
      if (char === '(') { depth++; seenOpen = true; }
      else if (char === ')') depth--;
    }

    if (seenOpen && depth <= 0) break;
    if (!seenOpen && index > startLineIndex) break;   // اصلاً پرانتزی ندارد
  }

  return parts.join('\n');
}

/**
 * استخراج documentation از خطوط قبل یا بعد از تعریف symbol.
 *
 * - Python: docstring (triple-quote) در خطوط بلافاصله بعد یا hash comments قبل
 * - Java/PHP/C#/C++/Kotlin/Swift: Javadoc-style block comment یا line comment قبل
 * - Go: line comment قبل
 * - Rust: doc comment (///) یا line comment قبل
 * - Ruby: hash comment قبل
 */
export function extractDocumentation(
  lines: string[],
  symbolLine: number,
  languageId: string
): string | null {
  const before = extractLeadingComments(lines, symbolLine, languageId);
  if (before) return before;

  if (languageId === 'python') {
    return extractPythonDocstring(lines, symbolLine);
  }

  return null;
}

function extractLeadingComments(
  lines: string[],
  symbolLine: number,
  languageId: string
): string | null {
  const comments: string[] = [];
  let insideBlockComment = false;

  for (let i = symbolLine - 2; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.trim() === '') {
      if (insideBlockComment) {
        // خط خالی داخل block comment
        comments.unshift('');
        continue;
      }
      // برای Javadoc یک خط خالی قبل مجاز است؛ برای // پایان comment block
      if (comments.length > 0 && !isLineCommentLanguage(languageId)) {
        break;
      }
      continue;
    }

    const trimmed = line.trim();

    if (insideBlockComment) {
      if (trimmed.startsWith('/*')) {
        insideBlockComment = false;
        let text = trimmed.slice(trimmed.startsWith('/**') ? 3 : 2);
        text = text.replace(/^\s*\*\s?/g, '').trim();
        if (text) comments.unshift(text);
      } else {
        comments.unshift(trimmed.replace(/^\s*\*\s?/g, '').trim());
      }
      continue;
    }

    // خط قبل symbol می‌تواند پایان block comment باشد
    if (trimmed.endsWith('*/')) {
      insideBlockComment = true;
      const text = trimmed.slice(0, -2).replace(/^\s*\*\s?/g, '').trim();
      if (text) comments.unshift(text);
      continue;
    }

    const comment = extractLineCommentText(trimmed);
    if (comment !== null) {
      comments.unshift(comment);
    } else {
      break;
    }
  }

  if (comments.length === 0) return null;
  return comments.join('\n').trim() || null;
}

function isLineCommentLanguage(languageId: string): boolean {
  return ['go', 'rust', 'swift', 'kotlin', 'java', 'php', 'csharp', 'cpp', 'c'].includes(languageId);
}

function extractLineCommentText(trimmed: string): string | null {
  // Javadoc / Rust doc / C# XML doc: /// ...
  if (trimmed.startsWith('///') || trimmed.startsWith('//!')) {
    return trimmed.slice(3).trim();
  }
  if (trimmed.startsWith('//')) {
    return trimmed.slice(2).trim();
  }

  // Python / Ruby / Bash / PHP # comment
  if (trimmed.startsWith('#') && !trimmed.startsWith('#!')) {
    return trimmed.slice(1).trim();
  }

  return null;
}



function extractPythonDocstring(lines: string[], symbolLine: number): string | null {
  // docstring در خطوط بلافاصله بعد از definition
  for (let i = symbolLine; i < Math.min(symbolLine + 3, lines.length); i++) {
    const line = lines[i];
    if (!line) continue;
    const trimmed = line.trim();
    if (trimmed === '') continue;

    const match = trimmed.match(/^(["']{3})([\s\S]*?)\1$/);
    if (match) {
      return match[2]!.trim();
    }

    // multi-line docstring start
    const startMatch = trimmed.match(/^(["']{3})([\s\S]*)$/);
    if (startMatch) {
      const quote = startMatch[1];
      const parts: string[] = [startMatch[2]!.trim()];
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j]!.trim();
        if (l.endsWith(quote)) {
          parts.push(l.slice(0, -quote.length).trim());
          return parts.join('\n').trim();
        }
        parts.push(l);
      }
    }

    break;
  }
  return null;
}

/**
 * تشخیص visibility از روی خط تعریف symbol.
 */
export function extractVisibility(line: string, languageId: string): SymbolVisibility {
  const trimmed = line.trim().toLowerCase();

  // Python naming convention
  if (languageId === 'python') {
    const nameMatch = line.match(/(?:async\s+)?def\s+(\w+)/);
    if (nameMatch) {
      const name = nameMatch[1]!;
      if (name.startsWith('__') && name.endsWith('__')) return 'public';
      if (name.startsWith('__')) return 'private';
      if (name.startsWith('_')) return 'private';
    }
    return 'public';
  }

  // Ruby
  if (languageId === 'ruby') {
    const match = line.match(/def\s+(?:self\.)?(\w+)/);
    if (match) {
      const name = match[1]!;
      if (name.startsWith('_')) return 'private';
    }
    return 'public';
  }

  // C-family explicit modifiers
  if (['java', 'php', 'csharp', 'cpp', 'c', 'kotlin', 'swift'].includes(languageId)) {
    if (/\bprivate\b/.test(trimmed)) return 'private';
    if (/\bprotected\b/.test(trimmed)) return 'protected';
    if (/\bpublic\b/.test(trimmed) || /\bopen\b/.test(trimmed) || /\binternal\b/.test(trimmed)) return 'public';

    // Swift: absence of modifier = internal (treat as public for heuristic)
    // Kotlin: absence = public
    // Java: package-private → treat as public
    return 'public';
  }

  // Rust
  if (languageId === 'rust') {
    return trimmed.startsWith('pub ') ? 'public' : 'private';
  }

  // Go
  if (languageId === 'go') {
    const nameMatch = line.match(/func\s+(?:\([^)]+\)\s+)?(\w+)/);
    if (nameMatch) {
      const firstChar = nameMatch[1]![0];
      return firstChar === firstChar.toUpperCase() ? 'public' : 'private';
    }
    return 'public';
  }

  return 'public';
}

/**
 * استخراج parameters از خط تعریف function/method.
 *
 * ساده‌سازی: فقط content داخل اولین پرانتز را parse می‌کند.
 */
/**
 * پارامترها از امضا.
 *
 * SE-SYM-19 — نسخهٔ قبلی `/\(([^)]*)\)/` بود: روی *اولین* پرانتز
 * بسته می‌ایستاد و فقط یک خط را می‌دید. امضای چندخطی — در Java و
 * Python و Go بسیار رایج — و هر نوعِ دارای پرانتز تودرتو، پارامتر
 * از دست می‌داد.
 *
 * `signature` می‌تواند چند خط باشد؛ فراخوان مسئول است متن کافی
 * بدهد.
 */
export function extractParameters(line: string, languageId: string): Parameter[] {
  const paramsStr = extractParameterList(line);
  if (paramsStr === null) return [];

  // حذف self/this
  const cleaned = paramsStr.replace(/\b(self|this|cls)\b/g, '').trim();
  if (cleaned === '') return [];

  const paramNames = smartSplitParams(cleaned);

  return paramNames.map(p => parseParameter(p, languageId)).filter((p): p is Parameter => p !== null);
}

/**
 * محتوای اولین پرانتز، تا پرانتز *متناظر*.
 *
 * شمارش عمق لازم است: `handle(cb: (x: int) => void)` با تطبیق ساده
 * روی `cb: (x: int` بریده می‌شود.
 */
function extractParameterList(text: string): string | null {
  const open = text.indexOf('(');
  if (open === -1) return null;

  let depth = 0;
  let quote: string | null = null;

  for (let index = open; index < text.length; index++) {
    const char = text[index]!;

    if (quote) {
      if (char === '\\') { index++; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }

    if (char === '(') depth++;
    else if (char === ')') {
      depth--;
      if (depth === 0) return text.slice(open + 1, index).trim();
    }
  }

  return null;
}

function smartSplitParams(input: string): string[] {
  const result: string[] = [];
  let current = '';
  let depth = 0;

  for (const char of input) {
    if (char === '(' || char === '[' || char === '<' || char === '{') {
      depth++;
      current += char;
    } else if (char === ')' || char === ']' || char === '>' || char === '}') {
      depth--;
      current += char;
    } else if (char === ',' && depth === 0) {
      result.push(current.trim());
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

function parseParameter(param: string, languageId: string): Parameter | null {
  const trimmed = param.trim();
  if (!trimmed) return null;

  // حذف annotations/attributes ساده
  const withoutAnnotations = trimmed.replace(/@\w+(?:\([^)]*\))?\s*/g, '').trim();
  if (!withoutAnnotations) return null;

  // Default value
  const equalsIndex = withoutAnnotations.indexOf('=');
  let beforeEquals = withoutAnnotations;
  let defaultValue: string | undefined;
  if (equalsIndex !== -1) {
    beforeEquals = withoutAnnotations.substring(0, equalsIndex).trim();
    defaultValue = withoutAnnotations.substring(equalsIndex + 1).trim();
  }

  // Optional marker
  const isOptional = beforeEquals.includes('?') || defaultValue !== undefined;
  const withoutOptional = beforeEquals.replace('?', '').trim();

  // Rest parameter (...args برای JS/TS/Go، *args / **kwargs برای Python)
  const isRest = withoutOptional.startsWith('...') || withoutOptional.startsWith('**') || withoutOptional.startsWith('*');
  const withoutRest = withoutOptional.startsWith('...')
    ? withoutOptional.substring(3)
    : withoutOptional.startsWith('**')
      ? withoutOptional.substring(2)
      : withoutOptional.startsWith('*')
        ? withoutOptional.substring(1)
        : withoutOptional;

  // Type separation
  const colonIndex = withoutRest.indexOf(':');
  const spaceIndex = withoutRest.lastIndexOf(' ');

  let name: string;
  let type: string | null = null;

  if (colonIndex !== -1 && languageId !== 'c' && languageId !== 'cpp') {
    // name: type (Python, TypeScript, Kotlin, Swift, Rust)
    name = withoutRest.substring(0, colonIndex).trim();
    type = withoutRest.substring(colonIndex + 1).trim() || null;
  } else if (languageId === 'go') {
    /*
    | SE-SYM-29 — Go برعکس Java است: `ctx context.Context` یعنی نام
    | *اول* می‌آید. کد قبلی Go را در دستهٔ «type name» گذاشته بود و
    | آخرین توکن را نام می‌گرفت، پس هر پارامتر Go وارونه ثبت می‌شد:
    | نام `context.Context` و نوع `ctx`.
    |
    | شکل `a, b int` هم وجود دارد؛ آنجا `a` نوعی ندارد و همان‌طور
    | ثبت می‌شود.
    */
    const parts = withoutRest.split(/\s+/).filter(Boolean);
    name = parts[0] ?? '';
    type = parts.slice(1).join(' ') || null;
  } else if (spaceIndex !== -1 && !['python', 'ruby', 'shellscript'].includes(languageId)) {
    // type name (Java, C#, C, C++)
    const parts = withoutRest.split(/\s+/);
    name = parts[parts.length - 1]!;
    type = parts.slice(0, -1).join(' ') || null;
  } else {
    name = withoutRest;
  }

  if (!name) return null;

  return {
    name,
    type,
    optional: isOptional,
    defaultValue,
    rest: isRest,
  };
}

/*
| ── SE-SYM-19 ──────────────────────────────────────────────────────────
|
| `FrameMeter()` امضای یک کلاس نیست؛ یک *سازنده* است که هیچ‌جا اعلام نشده.
| قرارداد داده می‌گوید `signature` یعنی «signature or compact declaration»
| — یعنی برای سمبل‌های اعلانی باید سرِ خودِ اعلان برگرردد. تا این اصلاح،
| هر چهار استخراج‌گر (heuristic، imperative، tree-sitter، LSP) برای همهٔ
| kindها یک الگو می‌زدند و نتیجه‌اش در `find_symbol` و `explain_symbol` به
| شکل `Name()` دیده می‌شد.
*/

/** سمبل‌هایی که فراخوانی‌شدنی نیستند؛ `name(params)` برایشان بی‌معناست. */
export const DECLARATION_KINDS: ReadonlySet<string> = new Set([
  'class',
  'interface',
  'enum',
  'struct',
  'trait',
  'namespace',
  'module',
  'type-alias',
]);

const DECLARATION_NOISE = /^\s*(export\s+default\s+|export\s+declare\s+|declare\s+|export\s+)/;
const TRAILING_PUNCT = /\s*[{;=]\s*$/;

/**
 * امضای اعلانیِ فشرده. `null` یعنی «این kind اعلانی نیست، همان امضای
 * تابعی را نگه دار».
 *
 * خطِ خودِ سورس اگر موجود و قابل‌استفاده باشد برتر است: همان چیزی است که
 * برنامه‌نویس نوشته، و شکلِ `pub struct Foo<T>` در Rust را هم درست نگه
 * می‌دارد. اگر نبود، از قطعه‌های ساختاریافته می‌سازیم.
 */
export function declarationSignature(
  kind: string,
  name: string,
  parts: {
    readonly definitionLine?: string;
    readonly generics?: readonly string[];
    readonly extendsTypes?: readonly string[];
    readonly implementsTypes?: readonly string[];
  } = {}
): string | null {
  if (!DECLARATION_KINDS.has(kind)) return null;

  const raw = (parts.definitionLine ?? '').trim();
  if (raw && raw.includes(name) && !raw.startsWith('@') && !raw.startsWith('//')) {
    const cleaned = raw.replace(DECLARATION_NOISE, '').replace(TRAILING_PUNCT, '').replace(/\s+/g, ' ').trim();
    if (cleaned.length > 0 && cleaned.length <= 120) return cleaned;
  }

  const generics = (parts.generics ?? []).filter(entry => entry.trim() !== '');
  const extendsTypes = (parts.extendsTypes ?? []).filter(entry => entry.trim() !== '');
  const implementsTypes = (parts.implementsTypes ?? []).filter(entry => entry.trim() !== '');

  const keyword = kind === 'type-alias' ? 'type' : kind;
  let signature = `${keyword} ${name}`;
  if (generics.length > 0) signature += `<${generics.join(', ')}>`;
  if (extendsTypes.length > 0) signature += ` extends ${extendsTypes.join(', ')}`;
  if (implementsTypes.length > 0) signature += ` implements ${implementsTypes.join(', ')}`;
  return signature;
}

/**
 * ساخت signature از name + parameters.
 */
export function buildSignature(
  name: string,
  parameters: Parameter[],
  languageId: string,
  kind?: string,
  definitionLine?: string
): string {
  if (kind) {
    const declaration = declarationSignature(kind, name, { definitionLine });
    if (declaration) return declaration;
  }
  const isJavaStyle = ['java', 'php', 'csharp', 'cpp', 'c'].includes(languageId);

  const params = parameters.map(p => {
    if (isJavaStyle) {
      let s = p.type ? `${p.type} ` : '';
      s += p.name;
      if (p.optional && !p.defaultValue) s += '?';
      if (p.defaultValue) s += ` = ${p.defaultValue}`;
      if (p.rest) s = p.type ? `${p.type}... ${p.name}` : `...${p.name}`;
      return s;
    }

    let s = p.name;
    if (p.type) s += `: ${p.type}`;
    if (p.optional && !p.defaultValue) s += '?';
    if (p.defaultValue) s += ` = ${p.defaultValue}`;
    if (p.rest) s = `...${s}`;
    return s;
  }).join(', ');

  return `${name}(${params})`;
}

/**
 * پیدا کردن parent symbol بر اساس indentation.
 * نزدیک‌ترین symbol قبلی با indent کمتر که kind آن container باشد.
 */
export function findParentByIndentation(
  symbols: PendingSymbol[],
  currentIndent: number,
  currentLine: number
): PendingSymbol | null {
  const containerKinds: SymbolKind[] = ['class', 'interface', 'struct', 'enum', 'module', 'namespace', 'property'];

  for (let i = symbols.length - 1; i >= 0; i--) {
    const sym = symbols[i]!;
    if (sym.line >= currentLine) continue;
    if (!containerKinds.includes(sym.kind)) continue;
    if (sym.indent < currentIndent) {
      return sym;
    }
  }

  return null;
}

/**
 * محاسبه indentation (تعداد space) یک خط.
 */
/**
 * عرض *بصری* تورفتگی.
 *
 * SE-SYM-23 — نسخهٔ قبلی طول خام رشته را برمی‌گرداند، یعنی یک tab را
 * با یک space برابر می‌گرفت. در فایلی که با tab تورفته، بدنه هم‌سطح
 * تعریف دیده می‌شد و `findParentByIndentation` والد را اشتباه پیدا
 * می‌کرد.
 */
export function getIndent(line: string, tabSize = 4): number {
  let width = 0;
  for (const char of line) {
    if (char === ' ') width++;
    else if (char === '\t') width += tabSize - (width % tabSize);
    else break;
  }
  return width;
}
