/**
 * HeuristicDependencyExtractor — استخراج imports/exports با regex برای زبان‌هایی
 * که extractor اختصاصی ندارند.
 *
 * پشتیبانی‌شده (دقیقاً کلیدهای LANGUAGE_PATTERNS — تست
 * DependencyExtractorManager.test.ts این فهرست را با map واقعی مقایسه می‌کند):
 * - python: import x, from x import y
 * - go: import "x", import ( "x" )
 * - php: use XY; require/include (+ export: class/interface/trait/enum/function)
 * - shellscript: source x.sh
 * - java: import a.b.C;
 * - rust: use / mod / extern crate
 * - csharp: using X;
 * - c, cpp: #include "x" / <x>
 * - ruby: require / require_relative
 * - swift: import X
 * - kotlin: import a.b.C
 *
 * قرارداد resolution (تصمیم D-11): extractor فقط استخراج خام می‌کند.
 * filePath روی خروجی اثر ندارد و resolvedFileId همیشه null برمی‌گردد؛
 * resolve کردن importهای local کار مرحلهٔ pipeline است (resolveImport در IndexPipeline).
 */

import { IDependencyExtractor, DependencyExtractionResult } from '../IDependencyExtractor';
import { ImportEntry, ExportEntry, ImportSpecifier } from '../../core/types/project-index.types';
import { ExtractionSource, Result, ok } from '../../core/types/common.types';

interface ExtractorPatterns {
  readonly importRegex: RegExp[];
  readonly exportRegex?: RegExp[];
}

const LANGUAGE_PATTERNS: Readonly<Record<string, ExtractorPatterns>> = {
  python: {
    importRegex: [
      /^\s*import\s+([\w.]+)(?:\s+as\s+\w+)?/gm,
      /^\s*from\s+([\w.]+)\s+import\s+(.+)/gm,
    ],
  },
  go: {
    importRegex: [
      /^\s*import\s+\(\s*([\s\S]*?)\)/gm,
      /^\s*import\s+"([^"]+)"/gm,
    ],
  },
  php: {
    importRegex: [
      /^\s*use\s+((?:\\?\w+)+)(?:\s*;|\s+as)/gim,
      /^\s*(?:require|require_once|include|include_once)\s*['"]([^'"]+)['"]/gim,
    ],
    /*
    | SE-DEP-09 — الگوی قبلی `(?:public\s+|function\s+)(\w+)` روی
    | `public $items = [];` هم می‌افتاد و یک *پراپرتی* را صادرات ثبت
    | می‌کرد. در PHP صادرات یعنی چیزی که از بیرون قابل ارجاع است:
    | کلاس، interface، trait، enum، و تابع سطح‌بالا.
    */
    exportRegex: [
      /^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait|enum)\s+(\w+)/gim,
      /^\s*function\s+(\w+)\s*\(/gim,
    ],
  },
  shellscript: {
    importRegex: [
      /^\s*(?:source|\.)\s+['"]?([^\s'"]+)['"]?/gm,
    ],
  },
  java: {
    importRegex: [
      /^\s*import\s+(?:static\s+)?([\w.]+);/gm,
    ],
  },
  rust: {
    importRegex: [
      /^\s*use\s+([\w:{},\s]+);/gm,
      /^\s*mod\s+(\w+);/gm,
      /^\s*extern\s+crate\s+(\w+);/gm,
    ],
  },
  csharp: {
    importRegex: [
      /^\s*using\s+([\w.]+);/gm,
    ],
  },
  c: {
    importRegex: [
      /^\s*#include\s+"([^"]+)"/gm,
      /^\s*#include\s+<([^>]+)>/gm,
    ],
  },
  cpp: {
    importRegex: [
      /^\s*#include\s+"([^"]+)"/gm,
      /^\s*#include\s+<([^>]+)>/gm,
    ],
  },
  ruby: {
    importRegex: [
      /^\s*require\s+['"]([^'"]+)['"]/gm,
      /^\s*require_relative\s+['"]([^'"]+)['"]/gm,
    ],
  },
  swift: {
    importRegex: [
      /^\s*import\s+(\w+)/gm,
    ],
  },
  kotlin: {
    importRegex: [
      /^\s*import\s+([\w.]+)/gm,
    ],
  },
};

export class HeuristicDependencyExtractor implements IDependencyExtractor {
  readonly name: ExtractionSource = 'heuristic';
  readonly priority = 10;

  async isAvailable(languageId: string): Promise<boolean> {
    return languageId in LANGUAGE_PATTERNS;
  }

  async extractDependencies(
    _fileId: string,
    _filePath: string,
    content: string,
    languageId: string
  ): Promise<Result<DependencyExtractionResult>> {
    const patterns = LANGUAGE_PATTERNS[languageId];
    if (!patterns) {
      return ok({ imports: [], exports: [], partial: false });
    }

    const imports: ImportEntry[] = [];
    const exports: ExportEntry[] = [];

    for (const regex of patterns.importRegex) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(content)) !== null) {
        imports.push(...this.parseImport(match, languageId));
      }
    }

    if (patterns.exportRegex) {
      for (const regex of patterns.exportRegex) {
        regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(content)) !== null) {
          const name = match[1]?.trim();
          if (name) {
            exports.push({ name, kind: 'named' });
          }
        }
      }
    }

    return ok({ imports, exports, partial: false });
  }

  /**
   * یک تطبیق → صفر یا **چند** import.
   *
   * امضای قبلی `ImportEntry | null` بود، و همان شکل بود که SE-DEP-02
   * را ناگزیر می‌کرد: یک بلوک `import ( … )` در Go چند وابستگی است و
   * در یک مقدار جا نمی‌شود، پس کد فقط اولی را برمی‌داشت. همین برای
   * `use a::{b, c}` در Rust صادق بود.
   */
  private parseImport(
    match: RegExpExecArray,
    languageId: string
  ): ImportEntry[] {
    if (languageId === 'python') {
      if (match[0].trim().startsWith('from')) {
        const from = match[1]!;
        const specifiersText = match[2]!;
        const specifiers: ImportSpecifier[] = specifiersText
          .split(',')
          .map(s => s.trim())
          .filter(s => s.length > 0 && s !== '*')
          .map(s => {
            const parts = s.split(/\s+as\s+/);
            return { imported: parts[0]!, local: parts[1] };
          });
        return [{
          from,
          type: this.classifyPythonImport(from),
          resolvedFileId: null,
          specifiers: specifiers.length > 0 ? specifiers : undefined,
        }];
      }
      const from = match[1]!;
      return [{ from, type: this.classifyPythonImport(from), resolvedFileId: null }];
    }

    if (languageId === 'go') {
      return this.parseGoImports(match);
    }

    if (languageId === 'php') {
      const from = match[1]!;
      const isRequire = match[0].trim().startsWith('require') || match[0].trim().startsWith('include');
      if (isRequire) {
        return [{ from, type: from.startsWith('.') ? 'local' : 'package', resolvedFileId: null }];
      }
      return [{ from, type: 'package', resolvedFileId: null }];
    }

    if (languageId === 'shellscript') {
      const from = match[1]!;
      return [{ from, type: from.startsWith('.') ? 'local' : 'package', resolvedFileId: null }];
    }

    if (languageId === 'java') {
      const from = match[1]!;
      return [{ from, type: this.classifyJavaImport(from), resolvedFileId: null }];
    }

    if (languageId === 'rust') {
      const raw = match[1]!;
      if (match[0].trim().startsWith('mod')) {
        return [{ from: raw, type: 'local', resolvedFileId: null }];
      }
      if (match[0].trim().startsWith('extern crate')) {
        return [{ from: raw, type: 'package', resolvedFileId: null }];
      }
      return this.expandRustUse(raw);
    }

    if (languageId === 'csharp') {
      return [{ from: match[1]!, type: 'package', resolvedFileId: null }];
    }

    if (languageId === 'c' || languageId === 'cpp') {
      const from = match[1]!;
      const isQuoted = match[0].includes('"');
      return [{ from, type: isQuoted ? 'local' : 'builtin', resolvedFileId: null }];
    }

    if (languageId === 'ruby') {
      const from = match[1]!;
      const isRelative = match[0].trim().startsWith('require_relative');
      return [{ from, type: isRelative ? 'local' : 'package', resolvedFileId: null }];
    }

    if (languageId === 'swift') {
      return [{ from: match[1]!, type: 'package', resolvedFileId: null }];
    }

    if (languageId === 'kotlin') {
      const from = match[1]!;
      return [{ from, type: this.classifyKotlinImport(from), resolvedFileId: null }];
    }

    return [];
  }

  /**
   * Go — هم `import "x"` و هم بلوک `import ( … )`.
   *
   * SE-DEP-02: کد قبلی روی بلوک چندخطی فقط `block.match(/"([^"]+)"/)`
   * می‌زد، یعنی اولین رشته و بس. بلوک چندخطی شکل *استاندارد* Go است،
   * نه استثنا؛ پس گراف وابستگی Go عملاً بی‌اعتبار بود.
   */
  private parseGoImports(match: RegExpExecArray): ImportEntry[] {
    const captured = match[1] ?? '';

    // شکل تک‌خطی: خودِ مسیر گرفته شده است
    if (!match[0].includes('(')) {
      return [{
        from: captured,
        type: this.classifyGoImport(captured),
        resolvedFileId: null,
      }];
    }

    const entries: ImportEntry[] = [];

    for (const rawLine of captured.split('\n')) {
      // کامنت انتهایی و خطی کنار می‌رود؛ نام مستعار (`json "encoding/json"`)
      // و `_` هم اهمیتی برای گراف ندارند — مسیر ماژول همان رشته است.
      const line = rawLine.replace(/\/\/.*$/, '').trim();
      if (line === '' || line.startsWith('//')) continue;

      const quoted = line.match(/"([^"]+)"/);
      if (!quoted) continue;

      const from = quoted[1]!;
      entries.push({ from, type: this.classifyGoImport(from), resolvedFileId: null });
    }

    return entries;
  }

  /**
   * Rust — باز کردن گروه براکتی.
   *
   * `use std::collections::{HashMap, HashSet};` سه چیز است: یک پیشوند
   * و دو مسیر. ثبتش به‌صورت یک رشتهٔ خام نه مسیر معتبری است و نه قابل
   * resolve (SE-DEP-09).
   */
  private expandRustUse(raw: string): ImportEntry[] {
    const text = raw.replace(/\s+/g, '');
    const open = text.indexOf('{');

    if (open === -1) {
      return [{ from: text, type: this.classifyRustImport(text), resolvedFileId: null }];
    }

    const close = text.lastIndexOf('}');
    if (close === -1) {
      return [{ from: text, type: this.classifyRustImport(text), resolvedFileId: null }];
    }

    const prefix = text.slice(0, open).replace(/::$/, '');
    const items = text.slice(open + 1, close).split(',').map(item => item.trim()).filter(Boolean);

    return items.map(item => {
      // `self` یعنی خودِ ماژول والد
      const from = item === 'self' ? prefix : `${prefix}::${item}`;
      return { from, type: this.classifyRustImport(from), resolvedFileId: null };
    });
  }

  private classifyPythonImport(modulePath: string): 'package' | 'local' | 'builtin' {
    if (modulePath.startsWith('.')) return 'local';
    const builtins = new Set([
      'os', 'sys', 'json', 're', 'math', 'random', 'datetime', 'collections',
      'itertools', 'functools', 'typing', 'pathlib', 'subprocess', 'logging',
    ]);
    if (builtins.has(modulePath.split('.')[0]!)) return 'builtin';
    return 'package';
  }

  private classifyGoImport(modulePath: string): 'package' | 'local' | 'builtin' {
    if (modulePath.startsWith('.')) return 'local';
    if (!modulePath.includes('.')) return 'builtin';
    return 'package';
  }

  private classifyJavaImport(modulePath: string): 'package' | 'builtin' {
    const javaLang = new Set([
      'java.lang', 'java.util', 'java.io', 'java.nio', 'java.net', 'java.math',
      'java.time', 'java.sql', 'java.text', 'java.security', 'java.util.concurrent',
    ]);
    const prefix = modulePath.split('.').slice(0, 2).join('.');
    if (javaLang.has(prefix) || prefix === 'javax' || prefix === 'java') return 'builtin';
    return 'package';
  }

  private classifyRustImport(modulePath: string): 'package' | 'local' | 'builtin' {
    if (modulePath.startsWith("crate::") || modulePath.startsWith("self::") || modulePath.startsWith("super::")) {
      return 'local';
    }
    const builtins = new Set(['std', 'core', 'alloc']);
    const first = modulePath.split('::')[0]!;
    if (builtins.has(first)) return 'builtin';
    return 'package';
  }

  private classifyKotlinImport(modulePath: string): 'package' | 'builtin' {
    const builtins = new Set([
      'kotlin', 'java.lang', 'java.util', 'kotlinx', 'android',
    ]);
    const prefix = modulePath.split('.')[0]!;
    if (builtins.has(prefix)) return 'builtin';
    return 'package';
  }

  async dispose(): Promise<void> {}
}
