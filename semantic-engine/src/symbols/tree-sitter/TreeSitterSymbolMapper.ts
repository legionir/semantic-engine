/**
 * TreeSitterSymbolMapper — تبدیل AST tree-sitter به SymbolEntry های project-index.
 *
 * - traversal بازگشتی روی AST
 * - استخراج nested symbols با parentId
 * - تشخیص visibility/modifiers از روی AST
 * - استخراج parameters، signature، return type
 * - پشتیبانی از TS/JS/TSX/JSX
 */

import { Node, Tree } from 'web-tree-sitter';
import { SymbolEntry, SymbolKind, Parameter } from '../../core/types/project-index.types';
import { makeConfidence, Confidence } from '../../core/types/common.types';
import { extractDocumentation, declarationSignature } from '../heuristic/SymbolExtractionHelpers';
import { SymbolIdAllocator, buildFullyQualifiedName } from '../../core/id/SymbolIdentity';
import { grammarFor, DEFAULT_NAME_NODES } from './languageGrammars';
import { extractParameters, extractReturnType, buildSignature } from './TreeSitterSignature';
import { extractModifiers, extractName, extractVisibility, isConstructorNode, isExported } from './treeSitterNodeHelpers';
import { extractGenerics, extractExtends, extractImplements } from './TreeSitterHeritage';

/** شکل‌هایی که یک `export default` بی‌نام می‌تواند بگیرد. */
const ANONYMOUS_DEFAULT_TYPES = [
  'function_expression',
  'arrow_function',
  'class',
  'generator_function',
];

const CONTAINER_KINDS: SymbolKind[] = [
  'class',
  'interface',
  'enum',
  'struct',
  'namespace',
  'module',
  'trait',
];

export class TreeSitterSymbolMapper {
  private readonly allocator = new SymbolIdAllocator();

  constructor(
    private readonly fileId: string,
    private readonly filePath: string,
    private readonly languageId: string,
    private readonly contentLines: string[]
  ) {
    this.grammar = grammarFor(languageId);
    /* AI-06 — زبان‌هایی مثل Kotlin نامِ تابع/متغیر را در گره‌ای به جز
    | identifier می‌گذارند (`simple_identifier`); گرامر آن‌ها این گره‌ها را
    | اعلام می‌کند و اینجا به فهرست نام اضافه می‌شوند. */
    this.nameNodeTypes = [...DEFAULT_NAME_NODES, ...(this.grammar?.nameNodes ?? [])];
  }

  /**
   * پیکربندی گرامرِ این زبان — GAP-11.
   *
   * تا فاز ۴۸ نگاشتِ نوعِ گره به نوعِ symbol یک `switch` هاردکدشده
   * روی گرامرِ TypeScript بود، پس Python و Go و Java و Rust همه به
   * مسیر heuristic می‌افتادند.
   */
  private readonly grammar: ReturnType<typeof grammarFor>;
  private readonly nameNodeTypes: string[];
  /** نمادهای منتشرشده، برای حل کردنِ مالکِ یک `impl`. */
  private readonly symbolsByName = new Map<string, SymbolEntry>();

  mapTree(tree: Tree): SymbolEntry[] {
    const result: SymbolEntry[] = [];
    this.walk(tree.rootNode, null, '', result);
    return result;
  }

  private walk(
    node: Node,
    parentId: string | null,
    parentFqName: string,
    result: SymbolEntry[],
    context?: 'member'
  ): void {
    // multi-declarator variable/const statements: هر declarator یک symbol مجزا
    if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
      const isConst = node.children.some(c => c.type === 'const');
      const kind: SymbolKind = node.type === 'lexical_declaration' && isConst ? 'constant' : 'variable';
      for (const child of node.namedChildren) {
        if (child.type === 'variable_declarator') {
          const symbol = this.buildSymbolEntry(child, kind, parentId, parentFqName);
          if (!symbol) continue;
          result.push(symbol);

          /*
          | بدنهٔ مقدار هم پیمایش می‌شود و به همین symbol تعلق دارد.
          | بدون این، هرچه داخل `const f = () => { … }` تعریف شود
          | اصلاً استخراج نمی‌شد (SE-SYM-31).
          */
          const fqName = symbol.fullyQualifiedName
            ?? buildFullyQualifiedName(this.filePath, null, symbol.name);
          for (const grandChild of child.namedChildren) {
            this.walk(grandChild, symbol.id, fqName, result);
          }
        }
      }
      return;
    }

    /*
    | عضو enum دو شکل دارد و فقط یکی‌شان گرهٔ مخصوص خودش را دارد:
    |   enum E { A = 1 }  → enum_assignment
    |   enum E { A }      → property_identifier خام
    | دومی را نمی‌شود در جدول عمومی گذاشت، چون `property_identifier`
    | همه‌جای AST هست؛ فقط داخل `enum_body` معنای «عضو» می‌دهد.
    */
    /*
    | SE-SYM-32 — `export default` بی‌نام.
    |
    | گرامر برای این‌ها گرهٔ *اعلان* نمی‌سازد؛ یک عبارت زیر
    | `export_statement` می‌گذارد:
    |
    |   export default function () {}  → export_statement > function_expression
    |   export default class {}        → export_statement > class
    |   export default () => 1         → export_statement > arrow_function
    |
    | هیچ‌کدام نام ندارند، پس هیچ symbolی تولید نمی‌شد — و این شکل،
    | نقطهٔ ورود خیلی از ماژول‌هاست. نامشان همان چیزی است که
    | واردکننده با آن صدایشان می‌زند: `default`.
    */
    if (node.type === 'export_statement') {
      /*
      | تشخیص «بی‌نام» با فیلد `name` خودِ گرامر انجام می‌شود، نه با
      | نگاه کردن به فرزندان. اولین نسخه فرزندان را می‌گشت و روی
      | `export default (a) => a` شکست: بدنهٔ arrow یک identifier
      | ساده است و به‌اشتباه «نام» شمرده می‌شد.
      */
      const anonymous = node.namedChildren.find(child =>
        ANONYMOUS_DEFAULT_TYPES.includes(child.type) &&
        child.childForFieldName('name') === null
      );

      if (anonymous) {
        const kindForDefault: SymbolKind =
          anonymous.type === 'class' ? 'class' : 'function';
        const symbol = this.buildSymbolEntry(anonymous, kindForDefault, parentId, parentFqName, 'default');

        if (symbol) {
          result.push(symbol);
          const fqName = symbol.fullyQualifiedName
            ?? buildFullyQualifiedName(this.filePath, null, 'default');
          for (const child of anonymous.namedChildren) {
            this.walk(child, symbol.id, fqName, result);
          }
          return;
        }
      }
    }

    if (node.type === 'enum_body') {
      for (const child of node.namedChildren) {
        if (child.type === 'property_identifier') {
          const member = this.buildSymbolEntry(child, 'constant', parentId, parentFqName);
          if (member) result.push(member);
        } else {
          this.walk(child, parentId, parentFqName, result);
        }
      }
      return;
    }

    /*
    | GAP-11 — گره‌ای که اعضایش را به یک نمادِ *دیگر* می‌چسباند.
    |
    | `impl UserService { ... }` در Rust خودش نمادی نیست، ولی
    | متدهای داخلش متعلق به `UserService`اند. بدون این، اجرای واقعی
    | نشان داد `find` با `parentId: null` ثبت می‌شود — یعنی به‌عنوان
    | یک تابعِ سطحِ فایل، نه متدِ آن struct.
    */
    const attachTo = this.grammar?.attachesTo?.[node.type];
    if (attachTo) {
      const ownerName = node.childForFieldName?.(attachTo)?.text;
      const owner = ownerName ? this.symbolsByName.get(ownerName) : undefined;
      const nextParent = owner?.id ?? parentId;
      const nextFq = owner?.fullyQualifiedName ?? parentFqName;
      for (const child of node.namedChildren) {
        this.walk(child, nextParent, nextFq, result, owner ? 'member' : undefined);
      }
      return;
    }

    let kind = this.mapNodeTypeToKind(node.type);

    /*
    | AI-06 — تفکیک بر اساس کلیدواژه. Kotlin و Swift هم `class` و هم
    | `interface`/`enum`/`struct`/`object` را در یک گرهٔ `class_declaration`
    | می‌ریزند و نوعِ واقعی فقط در کلیدواژهٔ بیرون‌آمدنِ اولِ گره است.
    | حدس نزدن بهتر از برچسبِ غلط است؛ اینجا حدس لازم نیست — گرامر
    | کلیدواژه را صریح می‌دهد. پیمایش فقط تا پیش از اولین گرهٔ نام‌دار
    | (نامِ اعلان) می‌رود، پس کلیدواژهٔ بدنه هرگز خوانده نمی‌شود.
    */
    const byKeyword = this.grammar?.kindFromKeyword?.[node.type];
    if (byKeyword && kind) {
      let matched = false;
      for (const child of node.children) {
        /* `abstract class …` در Kotlin یک گرهٔ modifiers نام‌دار *پیش از*
        | کلیدواژه می‌گذارد؛ آن رد می‌شود ولی هر نام‌دار دیگری (نامِ
        | اعلان) یعنی سرِ اعلان تمام شده است. */
        if (child.isNamed && child.type === 'modifiers') continue;
        if (child.isNamed) break;
        const mapped = byKeyword[child.type];
        if (mapped) {
          kind = mapped;
          matched = true;
          break;
        }
      }
      if (!matched && byKeyword.default) {
        kind = byKeyword.default;
      }
    }

    /*
    | نوع از فرزند، وقتی گرامر یک گره برای چند چیز دارد. در Go هم
    | `type X struct{}` و هم `type X interface{}` یک `type_spec`
    | هستند.
    */
    const fromChild = this.grammar?.kindFromChild?.[node.type];
    if (fromChild) {
      for (const child of node.namedChildren) {
        const mapped = fromChild[child.type];
        if (mapped) {
          kind = mapped;
          break;
        }
      }
    }

    /*
    | یک تابع داخل یک container، متد است. Python و Rust برای تابع و
    | متد یک گره دارند، پس تفکیک از روی *جایگاه* می‌آید.
    */
    if (
      kind === 'function' &&
      context === 'member' &&
      this.grammar?.functionsInContainersAreMethods
    ) {
      kind = 'method';
    }

    if (kind) {
      const symbol = this.buildSymbolEntry(node, kind, parentId, parentFqName);
      if (symbol) {
        result.push(symbol);
        if (!this.symbolsByName.has(symbol.name)) this.symbolsByName.set(symbol.name, symbol);

        /*
        | SE-SYM-31 — هر symbol دامنهٔ زیردرخت خودش است.
        |
        | قبلاً فقط «container»ها (کلاس، interface، namespace…) والد
        | فرزندانشان می‌شدند و بقیه با والد *بیرونی* پیمایش می‌شدند.
        | نتیجه نه «والد گمشده» بلکه **والد غلط** بود: یک متغیر محلی
        | داخل متد `A.run()` به‌عنوان عضو کلاس `A` ثبت می‌شد. هر
        | مصرف‌کننده‌ای که بپرسد «اعضای A چیست» یک متغیر محلی تحویل
        | می‌گرفت.
        */
        const fqName = symbol.fullyQualifiedName
          ?? buildFullyQualifiedName(this.filePath, null, symbol.name);
        // فرزندانِ یک container در جایگاهِ «عضو» پیمایش می‌شوند.
        const childContext = CONTAINER_KINDS.includes(kind) ? 'member' : context;
        for (const child of node.namedChildren) {
          this.walk(child, symbol.id, fqName, result, childContext);
        }
        return;
      }
    }

    // برای node های غیر-symbol container، با همان parent ادامه می‌دهیم
    for (const child of node.namedChildren) {
      this.walk(child, parentId, parentFqName, result, context);
    }
  }

  private buildSymbolEntry(
    node: Node,
    kind: SymbolKind,
    parentId: string | null,
    parentFqName: string,
    nameOverride?: string
  ): SymbolEntry | null {
    const name = nameOverride ?? extractName(node, this.nameNodeTypes);
    if (!name) return null;

    const allocated = this.allocator.allocate({
      filePath: this.filePath,
      parentFqName,
      name,
      kind,
    });
    const fqName = allocated.fullyQualifiedName;
    const id = allocated.id;

    const parameters = this.extractParameters(node);
    /*
    | F-0037 — سازنده نوعِ بازگشتی ندارد. در C#/Java گرهٔ
    | `constructor_declaration` یک گرهٔ نوع (همان نامِ کلاس) قبل از نام
    | می‌گذارد و `returnTypeChildTypes` آن را برمی‌داشت، پس امضا
    | `WeatherController(...): WeatherController` می‌شد — ادعایی که هیچ
    | زبانی نمی‌کند و برای agent نویزِ گمراه‌کننده است.
    */
    const returnType = isConstructorNode(node, name) ? null : this.extractReturnType(node, kind);
    /*
    | برای kindهای اعلانی، «امضا» همان سرِ اعلان است — نه `Name()`.
    | (SE-SYM-19)
    */
    const signature =
      declarationSignature(kind, name, {
        definitionLine: this.contentLines[node.startPosition.row],
        generics: this.extractGenerics(node),
        extendsTypes: this.extractExtends(node),
        implementsTypes: this.extractImplements(node),
      }) ?? this.fallbackSignature(kind, name, parameters, returnType, node);
    const modifiers = extractModifiers(node);

    return {
      id,
      fileId: this.fileId,
      parentId,
      kind,
      name,
      fullyQualifiedName: fqName,
      signature,
      visibility: extractVisibility(node, this.nameNodeTypes),
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      documentation: extractDocumentation(this.contentLines, node.startPosition.row + 1, this.languageId),
      deprecated: false,
      exported: isExported(node),
      source: 'tree-sitter',
      confidence: this.computeConfidence(node),
      async: modifiers.async,
      generator: modifiers.generator,
      abstract: modifiers.abstract,
      static: modifiers.static,
      readonly: modifiers.readonly,
      parameters,
      returnType,
      generics: this.extractGenerics(node),
      extends: this.extractExtends(node),
      implements: this.extractImplements(node),
      complexity: null,
      referenceCount: null,
      calls: [],
      calledBy: [],
    };
  }

  /**
   * نوع گره → نوع symbol.
   *
   * نام گره‌ها با probe روی گرامر واقعی TypeScript بیرون کشیده شد، نه
   * از روی حدس. سه ردیف قبلی اصلاً در گرامر وجود نداشتند
   * (`namespace_declaration`، `module_declaration`) و سه ردیفِ واقعی
   * غایب بودند — که یعنی `abstract class X {}` کاملاً از ایندکس
   * می‌افتاد (SE-SYM-11).
   */
  private mapNodeTypeToKind(nodeType: string): SymbolKind | null {
    return this.grammar?.kinds[nodeType] ?? null;
  }

  private extractParameters(node: Node): Parameter[] {
    return extractParameters(this.grammar, node);
  }

  private extractReturnType(node: Node, kind: SymbolKind): string | null {
    return extractReturnType(this.grammar, node, kind);
  }

  /*
  | Only callables get `name(params)`. A constant, variable or property used to be reported as
  | `DEFAULT_TIMEOUT_MS()`, which tells a reader (or a model) it is a function. For those, the
  | declaration line itself is the useful signature (`const DEFAULT_TIMEOUT_MS = 15_000`).
  */
  private fallbackSignature(
    kind: SymbolKind,
    name: string,
    parameters: Parameter[],
    returnType: string | null,
    node: Node
  ): string {
    if (kind === 'function' || kind === 'method' || kind === 'decorator') {
      return this.buildSignature(name, parameters, returnType);
    }
    const line = (this.contentLines[node.startPosition.row] ?? '').trim().replace(/[;{,]\s*$/, '').trim();
    return line.length > 0 && line.length <= 160 ? line : name;
  }

  private buildSignature(name: string, parameters: Parameter[], returnType: string | null): string {
    return buildSignature(name, parameters, returnType);
  }

  private extractGenerics(node: Node): string[] {
    return extractGenerics(node);
  }

  private extractExtends(node: Node): string[] {
    return extractExtends(this.grammar, node);
  }

  private extractImplements(node: Node): string[] {
    return extractImplements(this.grammar, node);
  }

  private computeConfidence(node: Node): Confidence {
    let score = 85;
    if (isExported(node)) score += 5;
    if (node.hasError) score -= 20;
    return makeConfidence(Math.max(50, Math.min(98, score)));
  }
}
