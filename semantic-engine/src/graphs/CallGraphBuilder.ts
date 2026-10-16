/**
 * ساخت CallGraph مرکزی از روی AST فایل‌های TypeScript/JavaScript.
 *
 * نسخه‌ی بهبود‌یافتهٔ فاز ۴:
 * - از import های هر فایل برای رزولوشن cross-file استفاده می‌کند
 * - method calls روی instance‌های import‌شده (مثل service.getUsers()) را پشتیبانی می‌کند
 * - kind هر edge (direct / conditional / async / external / recursive) را تشخیص می‌دهد
 * - فقط calls داخل فایل‌های شناخته‌شده را link می‌کند
 * - calls به توابع anonymous یا external library ها به‌صورت external ثبت می‌شوند
 */

import * as ts from 'typescript';
import * as path from 'path';
import { CallEdge, SymbolEntry, FileEntry } from '../core/types/project-index.types';
import { SymbolIndex } from './SymbolIndex';
import { ImportIndex, ImportBinding } from './ImportIndex';
import { makeEdgeId, provenanceFor, EdgeBasis } from './EdgeProvenance';

export interface CallGraphBuilderOptions {
  readonly workspaceRoot: string;
  readonly files: readonly FileEntry[];
  readonly symbols: readonly SymbolEntry[];
}

interface PropertyChain {
  readonly root: string;
  readonly properties: readonly string[];
  readonly rootExpression: ts.Expression;
  readonly fullName: string;
}

interface CalleeResolution {
  readonly symbolId?: string;
  readonly externalName: string;
  /**
   * چطور مقصد پیدا شد. بدون این، یالی که از «اولین symbol هم‌نام در
   * کل پروژه» ساخته شده از یالی که از AST همان فایل آمده قابل تشخیص
   * نیست (SE-GRAPH-03، پیش‌نیاز بلوک F).
   */
  readonly basis?: EdgeBasis;
}

export class CallGraphBuilder {
  private readonly symbolIndex: SymbolIndex;
  private readonly importIndex: ImportIndex;
  private readonly exportIndex: ExportIndex;
  private readonly fileByPath = new Map<string, FileEntry>();
  private readonly edges: CallEdge[] = [];
  /** کلید یال → چند بار دیده شده. جای شمارندهٔ ترتیبی قبلی. */
  private readonly edgeOccurrences = new Map<string, number>();

  constructor(private readonly options: CallGraphBuilderOptions) {
    this.symbolIndex = new SymbolIndex(options.symbols);
    this.importIndex = new ImportIndex(options.files);
    this.exportIndex = new ExportIndex(options.files, this.symbolIndex);
    for (const file of options.files) {
      this.fileByPath.set(normalizePath(file.path), file);
    }
  }

  build(): readonly CallEdge[] {
    return this.buildForFiles(new Set(this.options.files.map(f => f.id)));
  }

  /**
   * Build call graph for a subset of files (incremental update support).
   * Only reads and analyzes files whose ids are in the provided set.
   */
  buildForFiles(fileIds: ReadonlySet<string>): readonly CallEdge[] {
    this.edges.length = 0;
    this.edgeOccurrences.clear();

    for (const file of this.options.files) {
      this.analyzeOne(file, fileIds);
    }

    return [...this.edges];
  }

  /**
   * همان کار، ولی با ییلد به event loop — SE-PERF-01.
   *
   * ── چرا لازم شد ───────────────────────────────────────────────────
   *
   * این متد هر فایل را دوباره از دیسک می‌خواند و با کامپایلر
   * TypeScript پارس می‌کند. کاملاً همگام است، پس روی ۴۰۰ فایل
   * event loop را برای یک بازهٔ پیوسته قفل می‌کند. اندازه‌گیری‌شده:
   *
   *     WORST LAG: 4996ms during phase: "Building graphs"
   *
   * یعنی حتی `/health` هم در آن پنج ثانیه جواب نمی‌داد. نسخهٔ
   * همگام برای مسیرهای incremental و تست‌ها می‌ماند؛ خط لولهٔ اصلی
   * این یکی را صدا می‌زند.
   */
  async buildForFilesAsync(
    fileIds: ReadonlySet<string>,
    yieldEvery = 25
  ): Promise<readonly CallEdge[]> {
    this.edges.length = 0;
    this.edgeOccurrences.clear();

    let seen = 0;

    for (const file of this.options.files) {
      this.analyzeOne(file, fileIds);

      seen += 1;
      if (seen % yieldEvery === 0) {
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    }

    return [...this.edges];
  }

  /** تحلیل یک فایل — مشترک بین مسیر همگام و ناهمگام. */
  private analyzeOne(file: FileEntry, fileIds: ReadonlySet<string>): void {
    if (!fileIds.has(file.id)) return;
    if (file.binary) return;
    if (!this.isTsJs(file.language)) return;

    const filePath = path.join(this.options.workspaceRoot, file.path);
    if (!this.fileExists(filePath)) return;

    const content = this.readFile(filePath);
    const sourceFile = ts.createSourceFile(
      file.path,
      content,
      ts.ScriptTarget.Latest,
      true,
      this.getScriptKind(file.language, file.path)
    );

    this.analyzeFile(file, sourceFile);
  }

  /** نسخهٔ ناهمگامِ `build()`. */
  async buildAsync(): Promise<readonly CallEdge[]> {
    return this.buildForFilesAsync(new Set(this.options.files.map(f => f.id)));
  }

  private analyzeFile(file: FileEntry, sourceFile: ts.SourceFile): void {
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        this.processCallExpression(file, sourceFile, node);
      } else if (ts.isNewExpression(node)) {
        /*
        | SE-GRAPH-13 — `new Foo()` یک CallExpression نیست، پس هرگز
        | به‌عنوان محلِ فراخوان دیده نمی‌شد. نتیجه: کلاسی که فقط با
        | new مصرف می‌شود هیچ caller نداشت و `simulate_mutation` یک
        | rename را «safe» می‌گفت درحالی‌که سازنده‌اش در چند فایل هست.
        */
        this.processNewExpression(file, sourceFile, node);
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  private processCallExpression(
    file: FileEntry,
    sourceFile: ts.SourceFile,
    node: ts.CallExpression
  ): void {
    const caller = this.findCallerSymbol(file, sourceFile, node);
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;

    const resolution = this.resolveCallee(file, node);
    if (!resolution.symbolId && !resolution.externalName) return;

    const calleeSymbolId = resolution.symbolId;
    const isRecursive = calleeSymbolId !== undefined && caller?.id === calleeSymbolId;
    const kind = this.inferEdgeKind(node, calleeSymbolId, isRecursive);

    const from = caller?.id ?? file.id;
    const to = calleeSymbolId ?? resolution.externalName;

    /*
    | مقصدی که به symbol resolve نشده، فقط یک نام است. یال همچنان
    | ارزش دارد (فراخوانی واقعاً اتفاق می‌افتد) ولی نباید هم‌رده با
    | یالی باشد که هر دو سرش شناخته‌شده است.
    */
    const basis: EdgeBasis = calleeSymbolId
      ? (resolution.basis ?? 'ast')
      : 'unresolved';

    const identity = { from, to, kind, line };
    const edge: CallEdge = {
      id: makeEdgeId({ ...identity, occurrence: this.occurrenceOf(identity) }),
      caller: from,
      /*
      | SE-GRAPH-02: فراخوانی در سطح ماژول — داخل یک callback بی‌نام،
      | یا در بدنهٔ فایل — داخل هیچ symbolای نمی‌افتد. تا فاز ۳۷
      | همان fileId در فیلدی نوشته می‌شد که قرارداد می‌گفت symbolId
      | است، و پایین‌دست بی‌صدا دورش می‌ریخت.
      */
      callerKind: caller ? 'symbol' : 'file',
      callee: to,
      kind,
      line,
      provenance: provenanceFor(basis, 'typescript-api', { file: file.path, line }),
    };

    this.edges.push(edge);
  }

  private findCallerSymbol(
    file: FileEntry,
    sourceFile: ts.SourceFile,
    node: ts.Node
  ): SymbolEntry | undefined {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    const candidates = this.symbolIndex.findSymbolsAtLine(file.id, line);
    if (candidates.length === 0) return undefined;

    // انتخاب دقیق‌ترین symbol:
    // ۱. کوچک‌ترین range
    // ۲. در صورت tie، function/method نسبت به class/interface ترجیح دارد
    candidates.sort((a, b) => {
      const rangeDiff = (a.endLine - a.line) - (b.endLine - b.line);
      if (rangeDiff !== 0) return rangeDiff;
      return this.callableKindPriority(b.kind) - this.callableKindPriority(a.kind);
    });
    return candidates[0];
  }

  private callableKindPriority(kind: SymbolEntry['kind']): number {
    if (kind === 'function' || kind === 'method') return 2;
    if (kind === 'class' || kind === 'interface') return 1;
    return 0;
  }

  private resolveCallee(file: FileEntry, node: ts.CallExpression): CalleeResolution {
    return this.resolveCalleeExpr(file, node.expression);
  }

  /**
   * SE-GRAPH-13 — مشترک بین `f()` و `new F()`؛ مقصد از خودِ عبارت
   * خوانده می‌شود، نه از نوع گره.
   */
  private resolveCalleeExpr(file: FileEntry, expr: ts.Expression): CalleeResolution {
    if (ts.isIdentifier(expr)) {
      return this.resolveIdentifierCallee(file, expr.text);
    }

    if (ts.isPropertyAccessExpression(expr)) {
      return this.resolvePropertyAccessCallee(file, expr);
    }

    return { externalName: '' };
  }

  /** `new Foo(...)` — یک ارجاعِ سازنده به سمبلِ کلاس، اگر resolve شد. */
  private processNewExpression(
    file: FileEntry,
    sourceFile: ts.SourceFile,
    node: ts.NewExpression
  ): void {
    const resolution = this.resolveCalleeExpr(file, node.expression);
    /*
    | سازنده‌ای که به سمبل resolve نمی‌شود (کلاس خارجی/ناشناخته) فقط یک
    | نام است؛ یالِ بی‌سمبل برای «چه می‌شکند» ارزشی ندارد و نویز می‌آورد.
    */
    if (!resolution.symbolId) return;

    const caller = this.findCallerSymbol(file, sourceFile, node);
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    const from = caller?.id ?? file.id;
    const identity = { from, to: resolution.symbolId, kind: 'direct', line };

    const edge: CallEdge = {
      id: makeEdgeId({ ...identity, occurrence: this.occurrenceOf(identity) }),
      caller: from,
      callerKind: caller ? 'symbol' : 'file',
      callee: resolution.symbolId,
      kind: 'direct',
      line,
      provenance: provenanceFor(resolution.basis ?? 'ast', 'typescript-api', { file: file.path, line }),
    };

    this.edges.push(edge);
  }

  private resolveIdentifierCallee(file: FileEntry, name: string): CalleeResolution {
    // ۱. ابتدا در همین فایل
    const localSymbol = this.symbolIndex.findByNameAndFile(file.id, name);
    if (localSymbol) {
      return { symbolId: localSymbol.id, externalName: name, basis: 'ast' };
    }

    // ۲. بررسی binding import‌شده
    const binding = this.importIndex.getBinding(file.id, name);
    if (binding) {
      return this.resolveImportedIdentifier(binding, name);
    }

    // ۳. fallback به جستجوی global در کل پروژه
    /*
    | آخرین تلاش: «اولین symbol با این نام در کل پروژه». در هر مخزنی
    | که دو `run` یا دو `handle` داشته باشد، این حدس است — پس یالش
    | با `name-match` علامت می‌خورد و اعتمادش زیر آستانه می‌ماند.
    */
    const globalSymbol = this.symbolIndex.findByName(name);
    if (globalSymbol) {
      return { symbolId: globalSymbol.id, externalName: name, basis: 'name-match' };
    }

    return { externalName: name };
  }

  private resolveImportedIdentifier(binding: ImportBinding, localName: string): CalleeResolution {
    if (!binding.resolvedFileId) {
      return { externalName: localName };
    }

    if (binding.isNamespace) {
      // صدا زدن یک namespace به‌عنوان تابع رایج نیست
      return { externalName: localName };
    }

    if (binding.isDefault) {
      const defaultSymbolId = this.exportIndex.resolveDefault(binding.resolvedFileId);
      if (defaultSymbolId) {
        return { symbolId: defaultSymbolId, externalName: localName, basis: 'import-resolved' };
      }
      // fallback: اگر نام local با یک symbol در فایل مقصد یکی باشد
      const fallback = this.symbolIndex.findByNameAndFile(binding.resolvedFileId, localName);
      if (fallback) {
        return { symbolId: fallback.id, externalName: localName, basis: 'import-resolved' };
      }
      return { externalName: localName };
    }

    const exportedSymbolId = this.exportIndex.resolve(binding.resolvedFileId, binding.importedName);
    if (exportedSymbolId) {
      return { symbolId: exportedSymbolId, externalName: localName, basis: 'import-resolved' };
    }

    return { externalName: localName };
  }

  private resolvePropertyAccessCallee(file: FileEntry, expr: ts.PropertyAccessExpression): CalleeResolution {
    const chain = this.extractPropertyChain(expr);
    if (!chain) {
      return { externalName: this.expressionToString(expr) };
    }

    const methodName = chain.properties[chain.properties.length - 1]!;

    // ۱. root یک imported binding است
    const binding = chain.root ? this.importIndex.getBinding(file.id, chain.root) : undefined;
    if (binding) {
      return this.resolveImportedMember(binding, methodName, chain.fullName);
    }

    // ۲. root این: یا متد کلاس جاری، یا فیلدی که کلاسی در آن `new` شده
    if (chain.root === 'this') {
      const caller = this.findCallerSymbolByFileLine(file, expr);
      const enclosingType = caller ? this.symbolIndex.findEnclosingTypeSymbol(caller) : undefined;
      if (enclosingType) {
        /*
        | SE-GRAPH-14 — `this.field.method()` همان `this.method()` نیست.
        |
        | شکل قبلی فقط نامِ آخرِ زنجیره را داخل کلاس جاری می‌گشت، پس
        | `this.ranker.rank(...)` یا به هیچ‌جا نمی‌رسید یا بدتر: با
        | fallbackِ «همین فایل» به یک سمبل بی‌ربطِ هم‌نام وصل می‌شد و
        | یالِ **غلط** با مبنای `ast` می‌ساخت. نتیجه‌اش در impact_analysis
        | و simulate_mutation شد: کم‌گزارشِ callers واقعیِ یک متد، که برای
        | agent تصمیم‌گیرندهٔ ویرایش خطرناک‌ترین خطاست.
        |
        | اینجا نوعِ فیلد از initializerِ `new X()` خوانده می‌شود و متد روی
        | همان کلاس جستجو می‌شود. اگر فیلد به شکل دیگری مقدار بگیرد
        | (factory، وراثت) undefined برمی‌گردد و رفتار قبلی دست‌نخورده
        | می‌ماند — یعنی حدسِ تازه‌ای ساخته نمی‌شود.
        */
        if (chain.properties.length > 1) {
          const fieldClass = this.findFieldNewInstanceClass(
            expr.getSourceFile(),
            enclosingType.name,
            chain.properties[0]!
          );
          if (fieldClass) {
            const classSymbol = this.resolveIdentifierCallee(file, fieldClass);
            if (classSymbol.symbolId) {
              const member = this.findMemberSymbolById(classSymbol.symbolId, [methodName]);
              if (member) {
                return {
                  symbolId: member.symbol.id,
                  externalName: chain.fullName,
                  basis: this.weaker(classSymbol.basis ?? 'ast', member.basis),
                };
              }
            }
          }
        }

        const member = this.findMemberSymbol(enclosingType, [methodName]);
        if (member) {
          return { symbolId: member.symbol.id, externalName: chain.fullName, basis: member.basis };
        }
      }
      return { externalName: chain.fullName };
    }

    // ۳. root یک local symbol است (مثل کلاس یا namespace داخلی)
    if (chain.root) {
      /*
      | ریشه ممکن است در همین فایل باشد (قابل اتکا) یا از تطبیق نام
      | سراسری بیاید (حدس). مبنا از همان‌جا تعیین می‌شود.
      */
      const localRoot = this.symbolIndex.findByNameAndFile(file.id, chain.root);
      const rootSymbol = localRoot ?? this.symbolIndex.findByName(chain.root);
      if (rootSymbol) {
        const member = this.findMemberSymbol(rootSymbol, chain.properties);
        if (member) {
          return {
            symbolId: member.symbol.id,
            externalName: chain.fullName,
            basis: this.weaker(localRoot ? 'ast' : 'name-match', member.basis),
          };
        }
      }
    }

    // ۴. root یک new Expression است
    if (ts.isNewExpression(chain.rootExpression)) {
      const newExpr = chain.rootExpression;
      if (ts.isIdentifier(newExpr.expression)) {
        const className = newExpr.expression.text;
        const classSymbol = this.resolveIdentifierCallee(file, className);
        if (classSymbol.symbolId) {
          const member = this.findMemberSymbolById(classSymbol.symbolId, [methodName]);
          if (member) {
            return {
              symbolId: member.symbol.id,
              externalName: chain.fullName,
              basis: this.weaker(classSymbol.basis ?? 'ast', member.basis),
            };
          }
        }
      }
      return { externalName: chain.fullName };
    }

    return { externalName: chain.fullName };
  }

  private resolveImportedMember(binding: ImportBinding, methodName: string, fullName: string): CalleeResolution {
    if (!binding.resolvedFileId) {
      return { externalName: fullName };
    }

    if (binding.isNamespace) {
      // namespace import: utils.foo() → exported symbol foo در فایل مقصد
      const exportedSymbolId = this.exportIndex.resolve(binding.resolvedFileId, methodName);
      if (exportedSymbolId) {
        return { symbolId: exportedSymbolId, externalName: fullName, basis: 'import-resolved' };
      }
      const fallback = this.symbolIndex.findByNameAndFile(binding.resolvedFileId, methodName);
      if (fallback) {
        return { symbolId: fallback.id, externalName: fullName, basis: 'import-resolved' };
      }
      return { externalName: fullName };
    }

    // default / named import: service.getUsers() → کلاس UserService و متد getUsers
    const importedName = binding.isDefault ? binding.localName : binding.importedName;
    const classSymbolId = this.exportIndex.resolve(binding.resolvedFileId, importedName)
      ?? this.exportIndex.resolveDefault(binding.resolvedFileId)
      ?? this.symbolIndex.findByNameAndFile(binding.resolvedFileId, importedName)?.id;

    if (classSymbolId) {
      const member = this.findMemberSymbolById(classSymbolId, [methodName]);
      if (member) {
        return {
          symbolId: member.symbol.id,
          externalName: fullName,
          basis: member.basis === 'name-match' ? 'name-match' : 'import-resolved',
        };
      }
    }

    return { externalName: fullName };
  }

  /**
   * پیدا کردن عضو، **و اینکه چطور پیدا شد** — SE-GRAPH-05.
   *
   * تا فاز ۴۰، وقتی عضو در فرزندان ریشه نبود، این تابع به
   * `findByName(prop)` سراسری می‌افتاد — همان fallbackی که
   * SE-GRAPH-03 محکومش کرده بود — و فراخوان، یال را با
   * `basis: 'ast'` و اعتماد ۹۵ ثبت می‌کرد. یعنی حدس، «قطعی»
   * برچسب می‌خورد.
   *
   * روی ایندکس خودِ این مخزن، `lines.push(...)` داخل `runDoctor`
   * به symbolای به نام `push` در یک فایل تستِ بی‌ربط وصل شده بود،
   * با اعتماد ۹۵. هر مصرف‌کننده‌ای که روی آستانهٔ ۷۰ فیلتر کند —
   * از جمله `GraphQueryEngine` فاز ۳۹ — آن را قابل اتکا می‌بیند.
   *
   * حالا خودِ روش پیدا شدن برمی‌گردد و فراخوان **ضعیف‌ترین** مبنا
   * را می‌گیرد.
   */
  private findMemberSymbol(
    rootSymbol: SymbolEntry,
    properties: readonly string[]
  ): { symbol: SymbolEntry; basis: EdgeBasis } | undefined {
    let current: SymbolEntry | undefined = rootSymbol;
    let basis: EdgeBasis = 'ast';

    for (const prop of properties) {
      if (!current) return undefined;
      const children = this.symbolIndex.findChildren(current.id);
      const child = children.find(c => c.name === prop);
      if (child) {
        current = child;
        continue;
      }

      /*
      | همان فایل: هنوز یک حدس است ولی حدسی محدود به یک فایل.
      | سراسری: «اولین symbol هم‌نام در کل پروژه» — همان چیزی که
      | باید `name-match` بماند.
      */
      const sameFile = this.symbolIndex.findByNameAndFile(rootSymbol.fileId, prop);
      if (sameFile) {
        current = sameFile;
        continue;
      }

      current = this.symbolIndex.findByName(prop);
      if (current) basis = 'name-match';
    }

    return current ? { symbol: current, basis } : undefined;
  }

  private findMemberSymbolById(
    rootSymbolId: string,
    properties: readonly string[]
  ): { symbol: SymbolEntry; basis: EdgeBasis } | undefined {
    const root = this.symbolIndex.getById(rootSymbolId);
    if (!root) return undefined;
    return this.findMemberSymbol(root, properties);
  }

  /** ضعیف‌ترین مبنا برنده است — یک زنجیره از حدس هم حدس است. */
  private weaker(left: EdgeBasis, right: EdgeBasis): EdgeBasis {
    return left === 'name-match' || right === 'name-match' ? 'name-match' : left;
  }

  /**
   * نوعِ فیلدی که با `new X()` مقدار گرفته — SE-GRAPH-14.
   *
   * فقط initializerِ مستقیمِ `new Identifier()` داخل همان کلاس خوانده می‌شود
   * (نه factory، نه وراثت، نه تزریقِ constructor) و اگر شکلِ دیگری باشد
   * `undefined` برمی‌گردد تا فراخوان مثل прежде رفتار کند.
   */
  private findFieldNewInstanceClass(
    sourceFile: ts.SourceFile,
    className: string,
    fieldName: string
  ): string | undefined {
    let found: string | undefined;

    const visit = (node: ts.Node): void => {
      if (found !== undefined) return;
      if (ts.isClassDeclaration(node) && node.name?.text === className) {
        for (const member of node.members) {
          if (
            !ts.isPropertyDeclaration(member) ||
            !ts.isIdentifier(member.name) ||
            member.name.text !== fieldName
          ) {
            continue;
          }
          const initializer = member.initializer;
          if (initializer && ts.isNewExpression(initializer) && ts.isIdentifier(initializer.expression)) {
            found = initializer.expression.text;
          }
          return;
        }
        return;
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return found;
  }

  private extractPropertyChain(expr: ts.PropertyAccessExpression): PropertyChain | null {
    const properties: string[] = [];
    let current: ts.Expression = expr;

    while (ts.isPropertyAccessExpression(current)) {
      properties.unshift(current.name.text);
      current = current.expression;
    }

    let root = '';
    if (ts.isIdentifier(current)) {
      root = current.text;
    } else if (current.kind === ts.SyntaxKind.ThisKeyword) {
      root = 'this';
    }

    return {
      root,
      properties,
      rootExpression: current,
      fullName: this.expressionToString(expr),
    };
  }

  private expressionToString(expr: ts.Expression): string {
    if (ts.isIdentifier(expr)) return expr.text;
    if (ts.isPropertyAccessExpression(expr)) {
      return `${this.expressionToString(expr.expression)}.${expr.name.text}`;
    }
    if (ts.isCallExpression(expr)) {
      return `${this.expressionToString(expr.expression)}()`;
    }
    if (ts.isNewExpression(expr)) {
      return `new ${this.expressionToString(expr.expression)}()`;
    }
    return '';
  }

  private inferEdgeKind(
    node: ts.CallExpression,
    calleeSymbolId: string | undefined,
    isRecursive: boolean
  ): CallEdge['kind'] {
    if (isRecursive) return 'recursive';
    if (calleeSymbolId === undefined) return 'external';
    if (this.isAwaited(node)) return 'async';
    if (this.isConditional(node)) return 'conditional';
    return 'direct';
  }

  private isAwaited(node: ts.CallExpression): boolean {
    let current: ts.Node = node;
    while (current.parent) {
      if (current.parent.kind === ts.SyntaxKind.AwaitExpression) return true;
      if (!ts.isParenthesizedExpression(current.parent)) break;
      current = current.parent;
    }
    return false;
  }

  /**
   * آیا این فراخوانی شرطی است؟
   *
   * SE-GRAPH-06 — نسخهٔ قبلی تا ریشهٔ فایل بالا می‌رفت و در مرز تابع
   * نمی‌ایستاد. یعنی هر فراخوانی داخل تابعی که *خودش* داخل یک `if`
   * تعریف شده بود، «شرطی» علامت می‌خورد — حتی اگر در بدنهٔ آن تابع
   * بی‌قید و شرط اجرا شود. شرطی بودن، خاصیتِ مسیر اجرا *درون همان
   * تابع* است، نه جای تعریف تابع.
   */
  private isConditional(node: ts.CallExpression): boolean {
    let current: ts.Node = node;
    while (current.parent) {
      const parent = current.parent;

      // مرز تابع: فراتر از این، جای *تعریف* است نه مسیر اجرا
      if (
        ts.isFunctionDeclaration(parent) ||
        ts.isFunctionExpression(parent) ||
        ts.isArrowFunction(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isConstructorDeclaration(parent) ||
        ts.isGetAccessor(parent) ||
        ts.isSetAccessor(parent)
      ) {
        return false;
      }

      switch (parent.kind) {
        case ts.SyntaxKind.IfStatement:
        case ts.SyntaxKind.WhileStatement:
        case ts.SyntaxKind.DoStatement:
        case ts.SyntaxKind.ForStatement:
        case ts.SyntaxKind.ForInStatement:
        case ts.SyntaxKind.ForOfStatement:
        case ts.SyntaxKind.ConditionalExpression:
        case ts.SyntaxKind.SwitchStatement:
        case ts.SyntaxKind.CaseClause:
        case ts.SyntaxKind.CatchClause:
          return true;
        case ts.SyntaxKind.BinaryExpression:
          if (ts.isBinaryExpression(parent)) {
            const op = parent.operatorToken.kind;
            if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
              return true;
            }
          }
          break;
      }
      current = parent;
    }
    return false;
  }

  private findCallerSymbolByFileLine(file: FileEntry, node: ts.Node): SymbolEntry | undefined {
    const sourceFile = node.getSourceFile();
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    const candidates = this.symbolIndex.findSymbolsAtLine(file.id, line);
    if (candidates.length === 0) return undefined;
    candidates.sort((a, b) => (a.endLine - a.line) - (b.endLine - b.line));
    return candidates[0];
  }

  /**
   * چندمین یالِ کاملاً یکسان است.
   *
   * `f(g(), g())` دو یال با همان مبدأ، مقصد، نوع و خط تولید می‌کند.
   * بدون تفکیک، هر دو یک شناسه می‌گیرند.
   */
  private occurrenceOf(identity: { from: string; to: string; kind: string; line: number }): number {
    const key = `${identity.from}\u0000${identity.to}\u0000${identity.kind}\u0000${identity.line}`;
    const seen = this.edgeOccurrences.get(key) ?? 0;
    this.edgeOccurrences.set(key, seen + 1);
    return seen;
  }

  private isTsJs(language: string | null): boolean {
    return language === 'typescript' || language === 'javascript' ||
      language === 'typescriptreact' || language === 'javascriptreact';
  }

  private getScriptKind(language: string | null, filePath: string): ts.ScriptKind {
    if (language === 'typescript' || filePath.endsWith('.ts')) return ts.ScriptKind.TS;
    if (language === 'typescriptreact' || filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
    if (language === 'javascriptreact' || filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
    return ts.ScriptKind.JS;
  }

  private fileExists(filePath: string): boolean {
    try {
      const stat = require('fs').statSync(filePath);
      return stat.isFile();
    } catch {
      return false;
    }
  }

  private readFile(filePath: string): string {
    return require('fs').readFileSync(filePath, 'utf8');
  }
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

/**
 * Index سریع برای export های هر فایل → symbol id.
 * برای رزولوشن cross-file call مورد نیاز است.
 */
class ExportIndex {
  private readonly byFile = new Map<string, Map<string, string>>();
  private readonly defaultByFile = new Map<string, string>();

  constructor(files: readonly FileEntry[], private readonly symbolIndex: SymbolIndex) {
    for (const file of files) {
      if (!file.exports || file.exports.length === 0) continue;

      const map = new Map<string, string>();
      for (const exp of file.exports) {
        if (exp.kind === 're-export' || exp.kind === 'namespace') {
          // re-export از فایل دیگری است؛ اینجا فقط local exports را نگه می‌داریم
          continue;
        }

        // SE-DATA-02 — هر entry یک نام دارد؛ توضیح در ReExportResolver.
        const name = exp.name.trim();
        if (name) {
          const sym = this.symbolIndex.findByNameAndFile(file.id, name);
          if (sym) {
            map.set(name, sym.id);
            if (exp.kind === 'default') {
              this.defaultByFile.set(file.id, sym.id);
            }
          }
        }
      }

      if (map.size > 0) {
        this.byFile.set(file.id, map);
      }
    }
  }

  resolve(fileId: string, name: string): string | undefined {
    return this.byFile.get(fileId)?.get(name);
  }

  resolveDefault(fileId: string): string | undefined {
    return this.defaultByFile.get(fileId);
  }
}
