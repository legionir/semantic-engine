/**
 * محاسبهٔ متریک‌های سطح symbol: complexity و cross-file referenceCount.
 *
 * - complexity فقط برای function/method/getter/setter/constructor محاسبه می‌شود.
 * - referenceCount از روی callGraph استخراج می‌شود (تعداد caller های cross-file).
 *
 * ── SE-METRIC-01 ─────────────────────────────────────────────────────
 *
 * برای زبان‌های الگومحور، این کلاس *کل فایل* را به محاسبه‌گر می‌داد و
 * عدد حاصل را به **هر** symbol آن فایل نسبت می‌داد:
 *
 * ```ts
 * const content = this.readFileContent(workspaceRoot, file);  // کل فایل
 * return calculator.calculate(content);                       // یک عدد
 * ```
 *
 * یعنی یک `def add(a, b): return a + b` دو خطی، همان پیچیدگی تابع
 * ۲۰۰ خطی کنارش را می‌گرفت. اندازه‌گیری‌شده روی یک فایل دو تابعی:
 * هر دو عدد `7`.
 *
 * فاز ۱۴ به هر symbol یک `endLine` واقعی داد، پس حالا می‌شود بدنه را
 * برید. بازه‌های symbolهای *تودرتو* هم از بدنه پاک می‌شوند تا معنای
 * «تصمیم‌های تابع تودرتو مال خودش است» — که مسیر TS/JS از اول داشت —
 * برای الگومحورها هم برقرار باشد.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { SymbolEntry, FileEntry, CallEdge } from '../types/project-index.types';
import { calculateComplexity } from './CyclomaticComplexityCalculator';
import { createPythonComplexityCalculator } from './PythonComplexityCalculator';
import { createGoComplexityCalculator } from './GoComplexityCalculator';
import { createPhpComplexityCalculator } from './PhpComplexityCalculator';
import { createBashComplexityCalculator } from './BashComplexityCalculator';
import { createJavaComplexityCalculator } from './JavaComplexityCalculator';
import { createRustComplexityCalculator } from './RustComplexityCalculator';
import { createCSharpComplexityCalculator } from './CSharpComplexityCalculator';
import { createCppComplexityCalculator } from './CppComplexityCalculator';
import { createRubyComplexityCalculator } from './RubyComplexityCalculator';
import { createSwiftComplexityCalculator } from './SwiftComplexityCalculator';
import { createKotlinComplexityCalculator } from './KotlinComplexityCalculator';
import { PatternComplexityCalculator } from './PatternComplexityCalculator';
import { sliceSymbolBody } from './sliceSymbolBody';

export interface SymbolMetricsInput {
  readonly workspaceRoot: string;
  readonly files: readonly FileEntry[];
  readonly symbols: readonly SymbolEntry[];
  readonly callGraph: readonly CallEdge[];
  /** دامنه — فقط این فایل‌ها دوباره محاسبه شوند. */
  readonly changedFileIds?: ReadonlySet<string>;
}

export interface SymbolMetricsOptions {
  readonly maxCachedFiles?: number;
}

/** آنچه به ازای هر فایل کش می‌شود. */
interface FileCacheEntry {
  content: string | null;
  ast?: ts.SourceFile;
}

export class SymbolMetricsCalculator {
  /*
  | SE-METRIC-04: قبلاً دو `Map` جدا بودند که هرگز پاک نمی‌شدند و
  | `dispose` هم نداشتند. روی مخزن بزرگ یعنی نگه داشتن متن *و* AST
  | هر فایل تا پایان فرایند — و در حالت incremental، یک نمونهٔ تازه
  | به ازای هر batch که همان کار را از نو می‌کرد (SE-INC-03).
  |
  | حالا یک کش با کلید مسیر است، هم متن هم AST را کنار هم نگه می‌دارد
  | (که به‌هرحال با هم استفاده می‌شوند) و سقف LRU دارد. ترتیب درج در
  | `Map` حفظ می‌شود، پس قدیمی‌ترین کلید همان اولین کلید است.
  */
  private readonly fileCache = new Map<string, FileCacheEntry>();
  private readonly maxCachedFiles: number;

  constructor(options: SymbolMetricsOptions = {}) {
    this.maxCachedFiles = Math.max(1, options.maxCachedFiles ?? 512);
  }

  /** تعداد فایل‌های کش‌شده — برای تست و لاگ. */
  cacheSize(): number {
    return this.fileCache.size;
  }

  dispose(): void {
    this.fileCache.clear();
  }

  private cacheEntry(filePath: string): FileCacheEntry | undefined {
    const entry = this.fileCache.get(filePath);
    if (!entry) return undefined;
    // «تازه استفاده شد» — حذف و درج دوباره، تا انتهای ترتیب برود.
    this.fileCache.delete(filePath);
    this.fileCache.set(filePath, entry);
    return entry;
  }

  private storeEntry(filePath: string, entry: FileCacheEntry): void {
    this.fileCache.delete(filePath);
    this.fileCache.set(filePath, entry);
    while (this.fileCache.size > this.maxCachedFiles) {
      const oldest = this.fileCache.keys().next();
      if (oldest.done) break;
      this.fileCache.delete(oldest.value);
    }
  }

  private readonly patternCalculators = new Map<string, PatternComplexityCalculator>([
    ['python', createPythonComplexityCalculator()],
    ['go', createGoComplexityCalculator()],
    ['php', createPhpComplexityCalculator()],
    ['shellscript', createBashComplexityCalculator()],
    ['java', createJavaComplexityCalculator()],
    ['rust', createRustComplexityCalculator()],
    ['csharp', createCSharpComplexityCalculator()],
    ['c', createCppComplexityCalculator()],
    ['cpp', createCppComplexityCalculator()],
    ['ruby', createRubyComplexityCalculator()],
    ['swift', createSwiftComplexityCalculator()],
    ['kotlin', createKotlinComplexityCalculator()],
  ]);

  compute(input: SymbolMetricsInput): SymbolEntry[] {
    const fileById = new Map(input.files.map(f => [f.id, f]));
    const symbolById = new Map(input.symbols.map(s => [s.id, s]));

    /*
    | برای پاک کردن بدنهٔ توابع تودرتو، به همهٔ symbolهای هم‌فایل نیاز
    | است. یک بار گروه می‌شوند، نه به ازای هر symbol.
    */
    const symbolsByFile = new Map<string, SymbolEntry[]>();
    for (const sym of input.symbols) {
      const list = symbolsByFile.get(sym.fileId);
      if (list) list.push(sym);
      else symbolsByFile.set(sym.fileId, [sym]);
    }

    /*
    | SE-INC-02: دامنه.
    |
    | محاسبهٔ complexity برای هر symbol، فایلش را از دیسک می‌خواند و
    | parse می‌کند. در مسیر incremental این یعنی هر ذخیره، کل پروژه را
    | دوباره می‌خواند. اندازه‌گیری روی مخزن ۱۰۰۰ فایلی: **۷۵٪ زمان یک
    | ذخیره** همین‌جا می‌رفت.
    |
    | وقتی `changedFileIds` داده شود، symbolهای بقیهٔ فایل‌ها عدد
    | موجودشان را نگه می‌دارند — چون هیچ‌چیزِ ورودیِ آن محاسبه عوض
    | نشده. `referenceCount` استثناست: از callGraph می‌آید که سراسری
    | است، ولی محاسبه‌اش فقط یک پیمایش روی یال‌هاست و I/O ندارد.
    */
    const scope = input.changedFileIds;

    // ۱. complexity
    const symbolsWithComplexity = input.symbols.map(sym => {
      if (!this.isComplexityCandidate(sym)) {
        return { ...sym, complexity: sym.complexity ?? null };
      }

      if (scope && !scope.has(sym.fileId)) {
        return { ...sym, complexity: sym.complexity ?? null };
      }

      const file = fileById.get(sym.fileId);
      if (!file || file.binary || !this.isComplexitySupported(file.language)) {
        return { ...sym, complexity: sym.complexity ?? null };
      }

      const complexity = this.computeComplexityForSymbol(
        input.workspaceRoot,
        file,
        sym,
        symbolsByFile.get(sym.fileId) ?? []
      );
      if (complexity === null) {
        return { ...sym, complexity: sym.complexity ?? null };
      }

      return { ...sym, complexity };
    });

    // ۲. referenceCount (cross-file callers)
    const crossFileRefs = this.computeCrossFileReferenceCounts(
      symbolsWithComplexity,
      input.callGraph,
      symbolById
    );

    return symbolsWithComplexity.map(sym => {
      const refCount = crossFileRefs.get(sym.id);
      if (refCount === undefined) return sym;
      return { ...sym, referenceCount: refCount };
    });
  }

  private isComplexityCandidate(sym: SymbolEntry): boolean {
    return sym.kind === 'function' ||
      sym.kind === 'method' ||
      sym.kind === 'property'; // getter/setter ممکن است property باشند
  }

  private isTsJs(language: string | null): boolean {
    return language === 'typescript' ||
      language === 'javascript' ||
      language === 'typescriptreact' ||
      language === 'javascriptreact';
  }

  private isComplexitySupported(language: string | null): boolean {
    return this.isTsJs(language) ||
      language === 'python' ||
      language === 'go' ||
      language === 'php' ||
      language === 'shellscript' ||
      language === 'java' ||
      language === 'rust' ||
      language === 'csharp' ||
      language === 'c' ||
      language === 'cpp' ||
      language === 'ruby' ||
      language === 'swift' ||
      language === 'kotlin';
  }

  private computeComplexityForSymbol(
    workspaceRoot: string,
    file: FileEntry,
    sym: SymbolEntry,
    siblings: readonly SymbolEntry[]
  ): number | null {
    if (this.isTsJs(file.language)) {
      const sourceFile = this.getSourceFile(workspaceRoot, file);
      if (!sourceFile) return null;

      const functionNode = this.findFunctionNode(sourceFile, sym);
      if (!functionNode) return null;

      return calculateComplexity(sourceFile, functionNode);
    }

    const calculator = file.language ? this.patternCalculators.get(file.language) : undefined;
    if (calculator) {
      const content = this.readFileContent(workspaceRoot, file);
      if (content === null) return null;
      return calculator.calculate(sliceSymbolBody(content, sym, siblings));
    }

    return null;
  }

  private readFileContent(workspaceRoot: string, file: FileEntry): string | null {
    const cached = this.cacheEntry(file.path);
    if (cached) return cached.content;

    const absolutePath = path.join(workspaceRoot, file.path);
    let content: string | null;
    try {
      content = fs.readFileSync(absolutePath, 'utf8');
    } catch {
      content = null;
    }

    this.storeEntry(file.path, { content });
    return content;
  }

  private getSourceFile(workspaceRoot: string, file: FileEntry): ts.SourceFile | null {
    const cached = this.cacheEntry(file.path);
    if (cached?.ast) return cached.ast;
    if (cached && cached.content === null) return null;

    const content = cached?.content ?? this.readFileContent(workspaceRoot, file);
    if (content === null) return null;

    const scriptKind = this.getScriptKind(file.language, file.path);
    const sourceFile = ts.createSourceFile(
      file.path,
      content,
      ts.ScriptTarget.Latest,
      true,
      scriptKind
    );

    this.storeEntry(file.path, { content, ast: sourceFile });
    return sourceFile;
  }

  /**
   * پیدا کردن گرهٔ تابعِ متناظر با یک symbol — SE-METRIC-05.
   *
   * نسخهٔ قبلی فقط `nodeLine === sym.line` را با `node.getStart()`
   * مقایسه می‌کرد و اولین تطبیق را برمی‌داشت. دو شکست اندازه‌گیری‌شده:
   *
   *   • `node.getStart()` برای گرهٔ دکوره‌شده روی *دکوراتور* می‌افتد،
   *     نه روی نام. یک متد با `@log()` بالای سرش هیچ‌وقت تطبیق
   *     نمی‌خورد و `complexity: null` می‌گرفت — یعنی در Angular و
   *     NestJS و TypeORM عملاً هیچ متدی عدد نمی‌گرفت.
   *   • دو تابع روی یک خط، هر دو عدد *اولی* را می‌گرفتند.
   *
   * حالا همهٔ گره‌های تابع‌مانند جمع می‌شوند و بهترین نامزد انتخاب
   * می‌شود: تطبیق نام + خطِ نام، بعد نام + بازه، بعد فقط خطِ نام،
   * و در آخر خطِ شروع (که دکوراتور را هم شامل می‌شود).
   */
  private findFunctionNode(sourceFile: ts.SourceFile, sym: SymbolEntry): ts.Node | null {
    const lineOf = (position: number): number =>
      sourceFile.getLineAndCharacterOfPosition(position).line + 1;

    let best: { node: ts.Node; score: number; distance: number } | null = null;

    const visit = (node: ts.Node): void => {
      if (this.isFunctionLike(node)) {
        /*
        | `getStart()` دکوراتورها و modifierها را هم می‌گیرد؛
        | `name.getStart()` دقیقاً روی شناسه است. اختلاف همین دو، کل
        | باگ دکوراتور بود.
        */
        const declarationLine = lineOf(node.getStart());
        const named = node as ts.NamedDeclaration;
        const nameNode = named.name;
        const nameLine = nameNode ? lineOf(nameNode.getStart()) : declarationLine;
        const nodeName = nameNode && ts.isIdentifier(nameNode) ? nameNode.text : null;
        const endLine = lineOf(node.getEnd());

        const nameMatches = nodeName !== null && nodeName === sym.name;
        const withinRange = sym.line >= declarationLine && sym.line <= endLine;

        let score = 0;
        if (nameMatches && nameLine === sym.line) score = 5;
        else if (nameMatches && withinRange) score = 4;
        else if (nameLine === sym.line) score = 3;
        else if (declarationLine === sym.line) score = 2;
        /*
        | آخرین چاره: نام می‌خورد ولی هیچ خطی نمی‌خورد. شماره خطِ
        | ذخیره‌شده می‌تواند یکی جابه‌جا باشد (کامنت، دکوراتور، خط
        | ادامه). بین چند هم‌نام — مثلاً overloadها — نزدیک‌ترین
        | برنده است.
        */
        else if (nameMatches) score = 1;

        const distance = Math.abs(nameLine - sym.line);
        const better =
          !best || score > best.score || (score === best.score && distance < best.distance);
        if (score > 0 && better) {
          best = { node, score, distance };
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return best ? (best as { node: ts.Node }).node : null;
  }

  private isFunctionLike(node: ts.Node): boolean {
    return ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node);
  }

  private getScriptKind(language: string | null, filePath: string): ts.ScriptKind {
    if (language === 'typescript' || filePath.endsWith('.ts')) return ts.ScriptKind.TS;
    if (language === 'typescriptreact' || filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
    if (language === 'javascriptreact' || filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
    return ts.ScriptKind.JS;
  }

  private computeCrossFileReferenceCounts(
    symbols: SymbolEntry[],
    callGraph: readonly CallEdge[],
    symbolById: Map<string, SymbolEntry>
  ): Map<string, number> {
    const counts = new Map<string, number>();

    /*
    | SE-GRAPH-02 — چرا این‌جا شمارش خراب بود.
    |
    | یالی که فراخوانی‌اش در سطح ماژول است (داخل یک callback بی‌نام،
    | یا در بدنهٔ فایل) `caller` را برابر **fileId** می‌گذارد.
    | `symbolById.get` برای آن `undefined` می‌داد و `continue`
    | می‌کرد. روی همین مخزن یعنی **۵۷٪** یال‌ها (۹٬۹۰۶ از ۱۷٬۴۸۵)
    | بی‌صدا دور ریخته می‌شدند، و نتیجه‌اش این بود:
    |
    |   referenceCount ناتهی: ۴۵۷ از ۷٬۲۹۱ symbol  (۶٪)
    |
    | برای «چند فایل دیگر این را صدا می‌زنند» فرقی نمی‌کند که
    | فراخوانی داخل یک تابع بوده یا در سطح ماژول — فایلِ مبدأ در هر
    | دو حالت معلوم است.
    */
    const fileIds = new Set(symbols.map(symbol => symbol.fileId));

    for (const edge of callGraph) {
      const callee = symbolById.get(edge.callee);
      if (!callee) continue;

      const callerSymbol = symbolById.get(edge.caller);
      const callerFileId = callerSymbol
        ? callerSymbol.fileId
        : fileIds.has(edge.caller)
          ? edge.caller
          : undefined;

      if (!callerFileId) continue;
      if (callee.fileId === callerFileId) continue;

      counts.set(callee.id, (counts.get(callee.id) ?? 0) + 1);
    }

    return counts;
  }
}
