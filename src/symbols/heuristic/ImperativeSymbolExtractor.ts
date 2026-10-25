/**
 * ImperativeSymbolExtractor — استخراج symbol با regex برای زبان‌های imperative.
 *
 * پشتیبانی‌شده:
 * - Java, Rust, C#, C / C++, Ruby, Swift, Kotlin
 *
 * بهبودهای گام ۴:
 * - nested symbols با parentId (بر اساس indentation)
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

interface SymbolPattern {
  readonly regex: RegExp;
  readonly kind: SymbolKind;
  readonly nameGroup: number;
  readonly filter?: (name: string) => boolean;
}

interface LanguageConfig {
  readonly patterns: SymbolPattern[];
}

const LANGUAGE_CONFIGS: Readonly<Record<string, LanguageConfig>> = {
  java: {
    patterns: [
      {
        regex: /^\s*(?:public|protected|private|static|abstract|final|sealed|strictfp|@)?\s*(?:class|interface|enum|@interface)\s+(\w+)/gim,
        kind: 'class',
        nameGroup: 1,
      },
      {
        regex: /^\s*(?:public|protected|private)?\s*(?:[\w<>[\]\s]+)\s+(\w+)\s*\(/gim,
        kind: 'method',
        nameGroup: 1,
        filter: name => !/^(if|while|for|switch|catch|synchronized)$/.test(name),
      },
    ],
  },
  rust: {
    patterns: [
      { regex: /^\s*(?:pub\s+)?struct\s+(\w+)/gm, kind: 'struct', nameGroup: 1 },
      { regex: /^\s*(?:pub\s+)?enum\s+(\w+)/gm, kind: 'enum', nameGroup: 1 },
      { regex: /^\s*(?:pub\s+)?trait\s+(\w+)/gm, kind: 'interface', nameGroup: 1 },
      { regex: /^\s*(?:pub\s+)?impl(?:\s+<[^>]+>)?(?:\s+\w+)?\s+for\s+(\w+)/gm, kind: 'class', nameGroup: 1 },
      { regex: /^\s*(?:pub\s+)?impl\s+(\w+)/gm, kind: 'class', nameGroup: 1 },
      { regex: /^\s*(?:pub\s+)?mod\s+(\w+)/gm, kind: 'module', nameGroup: 1 },
      { regex: /^\s*(?:pub\s+)?fn\s+(\w+)\s*\(/gm, kind: 'function', nameGroup: 1 },
    ],
  },
  csharp: {
    patterns: [
      {
        regex: /^\s*(?:public|protected|private|internal|static|abstract|sealed|partial)?\s*(?:class|interface|struct|enum|record)\s+(\w+)/gim,
        kind: 'class',
        nameGroup: 1,
      },
      {
        regex: /^\s*(?:public|protected|private|internal|static|abstract|sealed|override|virtual|extern)?\s*(?:[\w<>[\]?\s]+)\s+(\w+)\s*\(/gim,
        kind: 'method',
        nameGroup: 1,
        filter: name => !/^(if|while|for|switch|catch|foreach)$/.test(name),
      },
    ],
  },
  c: {
    patterns: [
      { regex: /^\s*struct\s+(\w+)\s*\{/gm, kind: 'struct', nameGroup: 1 },
      { regex: /^\s*typedef\s+struct\s+(\w+)/gm, kind: 'struct', nameGroup: 1 },
      { regex: /^\s*enum\s+(\w+)\s*\{/gm, kind: 'enum', nameGroup: 1 },
      { regex: /^\s*static\s+(?:[\w[\]*\s]+)\s+(\w+)\s*\(/gm, kind: 'function', nameGroup: 1 },
      { regex: /^(?!\s*#)\s*(?:[\w[\]*\s]+)\s+(\w+)\s*\(/gm, kind: 'function', nameGroup: 1 },
    ],
  },
  cpp: {
    patterns: [
      { regex: /^\s*(?:class|struct)\s+(\w+)(?:\s*:\s*(?:public|protected|private)\s+\w+)?/gm, kind: 'class', nameGroup: 1 },
      { regex: /^\s*namespace\s+(\w+)/gm, kind: 'namespace', nameGroup: 1 },
      { regex: /^\s*enum\s+(?:class\s+)?(\w+)/gm, kind: 'enum', nameGroup: 1 },
      { regex: /^\s*(?:[\w:~<>[\]*&\s]+)\s+(\w+)\s*\(/gm, kind: 'function', nameGroup: 1, filter: name => !/^(if|while|for|switch|catch)$/.test(name) },
    ],
  },
  ruby: {
    patterns: [
      { regex: /^\s*class\s+(\w+)/gm, kind: 'class', nameGroup: 1 },
      { regex: /^\s*module\s+(\w+)/gm, kind: 'module', nameGroup: 1 },
      { regex: /^\s*def\s+(?:self\.)?(\w+)/gm, kind: 'method', nameGroup: 1 },
    ],
  },
  swift: {
    patterns: [
      { regex: /^\s*(?:public|internal|private|fileprivate|open)?\s*(?:final)?\s*class\s+(\w+)/gm, kind: 'class', nameGroup: 1 },
      { regex: /^\s*(?:public|internal|private|fileprivate)?\s*struct\s+(\w+)/gm, kind: 'struct', nameGroup: 1 },
      { regex: /^\s*(?:public|internal|private|fileprivate)?\s*enum\s+(\w+)/gm, kind: 'enum', nameGroup: 1 },
      { regex: /^\s*(?:public|internal|private|fileprivate)?\s*protocol\s+(\w+)/gm, kind: 'interface', nameGroup: 1 },
      { regex: /^\s*(?:public|internal|private|fileprivate)?\s*extension\s+(\w+)/gm, kind: 'class', nameGroup: 1 },
      { regex: /^\s*(?:public|internal|private|fileprivate)?\s*func\s+(\w+)\s*\(/gm, kind: 'function', nameGroup: 1 },
    ],
  },
  kotlin: {
    patterns: [
      { regex: /^\s*(?:public|internal|private|protected|sealed|data|abstract|open)?\s*class\s+(\w+)/gm, kind: 'class', nameGroup: 1 },
      { regex: /^\s*(?:public|internal|private|protected)?\s*interface\s+(\w+)/gm, kind: 'interface', nameGroup: 1 },
      { regex: /^\s*(?:public|internal|private|protected)?\s*object\s+(\w+)/gm, kind: 'class', nameGroup: 1 },
      { regex: /^\s*(?:public|internal|private|protected)?\s*fun\s+(\w+)\s*\(/gm, kind: 'function', nameGroup: 1 },
    ],
  },
};

const METHOD_PARENT_KINDS: SymbolKind[] = ['class', 'interface', 'struct', 'enum', 'namespace', 'module'];

export class ImperativeSymbolExtractor implements ISymbolExtractor {
  readonly name: ExtractionSource = 'heuristic';
  readonly priority = 10;

  async isAvailable(languageId: string): Promise<boolean> {
    return languageId in LANGUAGE_CONFIGS;
  }

  async extract(
    fileId: string,
    filePath: string,
    content: string,
    languageId: string
  ): Promise<Result<SymbolExtractionResult>> {
    const config = LANGUAGE_CONFIGS[languageId];
    if (!config) {
      return ok({
        symbols: [],
        source: 'heuristic',
        partial: false,
        warnings: [`No imperative patterns for language: ${languageId}`],
      });
    }

    const lines = content.split('\n');

    // SE-SYM-20 — همان دلیل HeuristicSymbolExtractor؛ توضیح آنجاست.
    const masked = maskLiteralsAndComments(content, languageId);
    const pending: PendingSymbol[] = [];

    for (const pattern of config.patterns) {
      pattern.regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.regex.exec(masked)) !== null) {
        const name = match[pattern.nameGroup]?.trim();
        if (!name) continue;
        if (pattern.filter && !pattern.filter(name)) continue;

        // line number را بر اساس موقعیت نام symbol محاسبه می‌کنیم
        const nameIndex = masked.indexOf(name, match.index);
        const line = this.getLineNumber(content, nameIndex);
        const definitionLine = lines[line - 1] ?? '';

        /*
        | SE-SYM-20 / SE-SYM-28 — `return foo(x);` تعریف نیست، و خودِ
        | `for` و `if` هم تابع نیستند. پیکربندی C برخلاف C++ هیچ
        | فیلتری نداشت.
        */
        if (isKeywordCallSite(definitionLine, name)) continue;
        const indent = getIndent(definitionLine);
        pending.push({
          name,
          kind: pattern.kind,
          line,
          indent,
          definitionLine,
          signatureText: readSignatureText(lines, line - 1),
        });
      }
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

    const symbols: SymbolEntry[] = [];
    const idByPending = new Map<PendingSymbol, string>();
    const fqNameByPending = new Map<PendingSymbol, string>();
    const allocator = new SymbolIdAllocator();

    for (const sym of pending) {
      // تشخیص method در صورت قرارگیری داخل container
      let kind = sym.kind;
      if (sym.kind === 'function') {
        const parent = findParentByIndentation(pending, sym.indent, sym.line);
        if (parent && METHOD_PARENT_KINDS.includes(parent.kind)) {
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
