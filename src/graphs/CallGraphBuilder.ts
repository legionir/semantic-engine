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
import { extractPropertyChain, expressionToString } from './callGraphAst';
import { ExportIndex, normalizePath } from './ExportIndex';
import { callableKindPriority, weaker, findFieldNewInstanceClass, inferEdgeKind, isTsJs, getScriptKind, fileExists, readFile } from './callGraphUtil';
import { CalleeResolution, CallGraphMemberLookup } from './CallGraphMemberLookup';
import { makeEdgeId, provenanceFor, EdgeBasis } from './EdgeProvenance';

export interface CallGraphBuilderOptions {
  readonly workspaceRoot: string;
  readonly files: readonly FileEntry[];
  readonly symbols: readonly SymbolEntry[];
}


export class CallGraphBuilder {
  private readonly symbolIndex: SymbolIndex;
  private readonly importIndex: ImportIndex;
  private readonly exportIndex: ExportIndex;
  private readonly members: CallGraphMemberLookup;
  private readonly fileByPath = new Map<string, FileEntry>();
  private readonly edges: CallEdge[] = [];
  /** کلید یال → چند بار دیده شده. جای شمارندهٔ ترتیبی قبلی. */
  private readonly edgeOccurrences = new Map<string, number>();

  constructor(private readonly options: CallGraphBuilderOptions) {
    this.symbolIndex = new SymbolIndex(options.symbols);
    this.importIndex = new ImportIndex(options.files);
    this.exportIndex = new ExportIndex(options.files, this.symbolIndex);
    this.members = new CallGraphMemberLookup(this.symbolIndex, this.exportIndex);
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
    if (!isTsJs(file.language)) return;

    const filePath = path.join(this.options.workspaceRoot, file.path);
    if (!fileExists(filePath)) return;

    const content = readFile(filePath);
    const sourceFile = ts.createSourceFile(
      file.path,
      content,
      ts.ScriptTarget.Latest,
      true,
      getScriptKind(file.language, file.path)
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
    const kind = inferEdgeKind(node, calleeSymbolId, isRecursive);

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
      return callableKindPriority(b.kind) - callableKindPriority(a.kind);
    });
    return candidates[0];
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
    const chain = extractPropertyChain(expr);
    if (!chain) {
      return { externalName: expressionToString(expr) };
    }

    const methodName = chain.properties[chain.properties.length - 1]!;

    // ۱. root یک imported binding است
    const binding = chain.root ? this.importIndex.getBinding(file.id, chain.root) : undefined;
    if (binding) {
      return this.members.resolveImportedMember(binding, methodName, chain.fullName);
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
          const fieldClass = findFieldNewInstanceClass(
            expr.getSourceFile(),
            enclosingType.name,
            chain.properties[0]!
          );
          if (fieldClass) {
            const classSymbol = this.resolveIdentifierCallee(file, fieldClass);
            if (classSymbol.symbolId) {
              const member = this.members.findMemberSymbolById(classSymbol.symbolId, [methodName]);
              if (member) {
                return {
                  symbolId: member.symbol.id,
                  externalName: chain.fullName,
                  basis: weaker(classSymbol.basis ?? 'ast', member.basis),
                };
              }
            }
          }
        }

        const member = this.members.findMemberSymbol(enclosingType, [methodName]);
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
        const member = this.members.findMemberSymbol(rootSymbol, chain.properties);
        if (member) {
          return {
            symbolId: member.symbol.id,
            externalName: chain.fullName,
            basis: weaker(localRoot ? 'ast' : 'name-match', member.basis),
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
          const member = this.members.findMemberSymbolById(classSymbol.symbolId, [methodName]);
          if (member) {
            return {
              symbolId: member.symbol.id,
              externalName: chain.fullName,
              basis: weaker(classSymbol.basis ?? 'ast', member.basis),
            };
          }
        }
      }
      return { externalName: chain.fullName };
    }

    return { externalName: chain.fullName };
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

}
