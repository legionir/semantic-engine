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
import {
  SymbolEntry,
  SymbolKind,
  SymbolVisibility,
  Parameter,
} from '../../core/types/project-index.types';
import { makeConfidence, Confidence } from '../../core/types/common.types';
import { extractDocumentation, declarationSignature } from '../heuristic/SymbolExtractionHelpers';
import { SymbolIdAllocator, buildFullyQualifiedName } from '../../core/id/SymbolIdentity';
import { grammarFor, DEFAULT_NAME_NODES } from './languageGrammars';

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
    const name = nameOverride ?? this.extractName(node);
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
    const returnType = this.isConstructorNode(node, name) ? null : this.extractReturnType(node, kind);
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
      }) ?? this.buildSignature(name, parameters, returnType);
    const modifiers = this.extractModifiers(node);

    return {
      id,
      fileId: this.fileId,
      parentId,
      kind,
      name,
      fullyQualifiedName: fqName,
      signature,
      visibility: this.extractVisibility(node),
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      documentation: extractDocumentation(this.contentLines, node.startPosition.row + 1, this.languageId),
      deprecated: false,
      exported: this.isExported(node),
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


  private extractName(node: Node): string | null {
    if (node.type === 'constructor_definition') {
      return 'constructor';
    }

    /*
    | GAP-11 — اول فیلدِ `name` خودِ گرامر.
    |
    | جست‌وجوی «اولین فرزندی که شبیه شناسه است» یک قاعدهٔ
    | **TypeScript‌محور** است: آن‌جا نام پیش از نوع می‌آید. در Java
    | نوع اول است، پس `public String find(String id)` نامش
    | «String» می‌شد — یعنی هر متد و هر فیلدِ Java نامِ نوعش را
    | می‌گرفت. اجرای واقعی پیش از رفع:
    |
    |   class     UserService
    |   property  String        ← باید repo باشد
    |   method    String        ← باید find باشد
    |
    | گرامرها خودشان فیلدِ `name` را اعلام می‌کنند؛ پرسیدن از
    | گرامر به‌جای حدس زدنِ ترتیب، همان درسِ SE-SYM-11 است.
    */
    const named = node.childForFieldName?.('name');
    if (named && named.text.length > 0) {
      return named.text.replace(/^['"`]|['"`]$/g, '');
    }


    /*
    | نام یک ambient module یک رشته است: `declare module "legacy"`.
    | نقل‌قول‌ها بخشی از نام نیستند.
    */
    if (node.type === 'module') {
      const stringName = node.namedChildren.find(c => c.type === 'string');
      if (stringName) return stringName.text.replace(/^['"`]|['"`]$/g, '');
    }

    /*
    | گاهی گرهٔ symbol *خودش* شناسه است و فرزندی ندارد — عضو enum
    | بدون مقدار (`enum E { Up }`) دقیقاً همین است. جست‌وجو در
    | فرزندان روی چنین گرهی چیزی پیدا نمی‌کند و symbol بی‌صدا حذف
    | می‌شود.
    */
    if (node.namedChildCount === 0 && this.nameNodeTypes.includes(node.type)) {
      return node.text;
    }

    // برای variable_declarator نام می‌تواند identifier، array_pattern یا object_pattern باشد
    const nameNode = node.namedChildren.find(c => this.nameNodeTypes.includes(c.type));

    return nameNode?.text ?? null;
  }

  /**
   * گرهٔ تابعیِ نهفته در یک declarator.
   *
   * `const f = () => {}` گرهٔ symbol را از `variable_declarator`
   * می‌گیرد، ولی پارامترها و نوع بازگشتی یک سطح پایین‌تر زیر
   * `arrow_function` نشسته‌اند. بدون این، هر تابع arrow-style — یعنی
   * بیشتر کد مدرن TS/JS — بدون پارامتر و بدون امضا ایندکس می‌شد
   * (SE-SYM-10).
   */
  private functionValueOf(node: Node): Node | null {
    if (node.type !== 'variable_declarator') return null;

    return node.namedChildren.find(child =>
      child.type === 'arrow_function' ||
      child.type === 'function_expression' ||
      child.type === 'function' ||
      child.type === 'generator_function'
    ) ?? null;
  }

  /**
   * آیا این گره سازنده است؟ F-0037.
   *
   * از دو نشانه خوانده می‌شود چون گرامرها یکسان نیستند: نامِ گرهٔ اعلان
   * (`constructor_declaration` در C#/Java، `constructor_definition` در TS)
   * و نامِ رویه‌ای پایتون. `fn new()` راست عمداً اینجا نیست — آن یک متد
   * استاتیک معمولی است، نه سازندهٔ گرامری.
   */
  private isConstructorNode(node: Node, name: string): boolean {
    if (/constructor/i.test(node.type)) return true;
    return name === '__init__' || name === 'constructor';
  }

  private extractParameters(node: Node): Parameter[] {
    const source = this.functionValueOf(node) ?? node;
    /*
    | SE-SYM-20 — نامِ گرهٔ لیستِ پارامتر گرامر‌به‌گرامر فرق دارد
    | (پایتون `parameters`، C#/Go `parameter_list`، روبی
    | `method_parameters`، راست `parameters`). پیش‌فرض همان
    | `formal_parameters` می‌ماند تا مسیر TS/JS تکان نخورد.
    */
    const declared = this.grammar?.paramListNodeTypes;
    const candidates = declared && declared.length > 0 ? declared : ['formal_parameters'];
    /*
    | اول فیلدِ `parameters` خودِ گرامر. لازم است چون Go در
    | `method_declaration` **دو** `parameter_list` دارد: اولی receiver
    | `(s *UserService)` و دومی پارامترهای واقعی؛ جست‌وجوی ترتیبیِ
    | فرزندها receiver را به‌عنوانِ پارامترها ثبت می‌کرد.
    */
    const byField = node.childForFieldName?.('parameters') ?? null;
    const paramsNode = (byField && candidates.includes(byField.type) ? byField : null)
      ?? source.namedChildren.find(c => candidates.includes(c.type));
    if (!paramsNode) return [];

    /*
    | زبانی که configِ پارامتر دارد از مسیرِ ساختاریِ نو می‌رود: نام و نوع
    | در گره‌هایِ جدا هستند (`formal_parameter` جاوا `int x` است، نه
    | `x: int`)؛ مسیرِ متنیِ TS روی آن‌ها نام را «int x» می‌گرفت.
    */
    const useStructural = declared !== undefined && declared.length > 0;

    return paramsNode.namedChildren
      .map(p => (useStructural ? this.parseStructuralParameter(p) : this.parseParameter(p)))
      .filter((p): p is Parameter => p !== null);
  }

  /** گره‌هایی که «نام» پارامترند، در گرامرهایِ غیر از TS. */
  private static readonly PARAM_NAME_NODES = new Set([
    'identifier', 'variable_name', 'name', 'field_identifier', 'this', 'type_identifier',
  ]);

  /** گره‌هایی که «نوع» پارامتر/بازگشت‌اند، در گرامرهایِ غیر از TS. */
  private static readonly PARAM_TYPE_NODES = new Set([
    'type', 'primitive_type', 'predefined_type', 'array_type', 'generic_type',
    'scoped_type_identifier', 'reference_type', 'optional_type', 'nullable_type',
    'union_type', 'tuple_type', 'integral_type', 'floating_point_type',
    'boolean_type', 'string_type', 'void_type', 'object', 'defined_type',
    'qualified_identifier', 'implicit_type',
    // انواعِ اولیه در گرامر جاوا نامِ اختصاصی دارند (`int x` روی `int_type`)
    'int_type', 'long_type', 'short_type', 'byte_type', 'char_type',
    'float_type', 'double_type', 'boolean_primitive_type',
  ]);

  /** فیلدهایی که در بیشتر گرامرها «نامِ پارامتر» را می‌دهند. */
  private static readonly PARAM_NAME_FIELDS = ['name', 'pattern'] as const;
  /** فیلدهایی که «نوعِ پارامتر» را می‌دهند. */
  private static readonly PARAM_TYPE_FIELDS = ['type', 'type_hint'] as const;

  private parseStructuralParameter(param: Node): Parameter | null {
    const named = param.namedChildren;
    /*
    | اول فیلدها. در جاوا `String b` هر دو فرزندش `identifier`اند (نامِ نوع
    | و نامِ پارامتر یکی است)، پس دسته‌بندیِ بر پایهٔ نوعِ گره آن‌ها را
    | قاطی می‌کند؛ خودِ گرامر می‌داند کدام `type` و کدام `name` است.
    */
    const fieldRead = (fields: readonly string[]): Node | null => {
      for (const f of fields) {
        const hit = param.childForFieldName?.(f);
        if (hit) return hit;
      }
      return null;
    };
    const typeField = fieldRead(TreeSitterSymbolMapper.PARAM_TYPE_FIELDS);
    const nameField = fieldRead(TreeSitterSymbolMapper.PARAM_NAME_FIELDS);

    const typeChild = typeField
      ?? named.find(c => TreeSitterSymbolMapper.PARAM_TYPE_NODES.has(c.type))
      ?? null;
    const nameChild = nameField
      ?? named.find(c => c !== typeChild && TreeSitterSymbolMapper.PARAM_NAME_NODES.has(c.type))
      ?? null;

    // مقدارِ پیش‌فرض: گرهٔ مقدار در `default_parameter`/`optional_parameter`
    const valueChild = named.find(c =>
      c !== typeChild && c !== nameChild &&
      !TreeSitterSymbolMapper.PARAM_TYPE_NODES.has(c.type) &&
      TreeSitterSymbolMapper.PARAM_NAME_NODES.has(c.type) === false
    ) ?? null;

    const text = param.text.trim();
    if (!text) return null;

    const name = nameChild?.text.trim() ?? (typeChild ? '' : text.replace(/^[*&]+\s*/, '')) ?? '';
    if (!name) return null;

    return {
      name,
      type: typeChild?.text.trim() ?? null,
      optional: param.type === 'optional_parameter' || param.type === 'default_parameter' ||
        param.type === 'typed_default_parameter' || text.includes('='),
      defaultValue: valueChild?.text.trim(),
      rest:
        param.type === 'rest_parameter' ||
        param.type === 'list_splat_pattern' ||
        param.type === 'dictionary_splat_pattern' ||
        text.startsWith('...') || text.startsWith('*'),
    };
  }

  private parseParameter(param: Node): Parameter | null {
    const text = param.text.trim();
    if (!text) return null;

    const typeAnnotation = param.namedChildren.find(c => c.type === 'type_annotation');
    const type = typeAnnotation ? typeAnnotation.text.replace(/^:\s*/, '') : null;

    const rest =
      param.type === 'rest_parameter' ||
      param.type === 'rest_pattern' ||
      text.startsWith('...');

    const optional =
      param.type === 'optional_parameter' ||
      param.type === 'assignment_pattern' ||
      text.includes('?') ||
      text.includes('=');

    let name = text;
    if (type && typeAnnotation) {
      name = name.replace(typeAnnotation.text, '').trim();
    }
    if (name.includes('=')) {
      name = name.split('=')[0]!.trim();
    }
    if (name.endsWith('?')) {
      name = name.slice(0, -1).trim();
    }
    if (name.startsWith('...')) {
      name = name.slice(3).trim();
    }

    let defaultValue: string | undefined;
    if (text.includes('=')) {
      defaultValue = text.split('=').slice(1).join('=').trim();
      if (type && typeAnnotation) {
        defaultValue = defaultValue.replace(typeAnnotation.text, '').trim();
      }
    }

    return {
      name,
      type,
      optional,
      defaultValue,
      rest,
    };
  }

  /**
   * نوع بازگشتی — و نه نوع متغیر.
   *
   * SE-SYM-13: نسخهٔ قبلی اولین `type_annotation` را برمی‌داشت. روی
   * `const config: Settings = …` آن annotation نوعِ *متغیر* است و
   * ثبتش به‌عنوان نوع بازگشتی یعنی ایندکس ادعا می‌کند یک ثابت،
   * تابعی است که `Settings` برمی‌گرداند.
   */
  private extractReturnType(node: Node, kind: SymbolKind): string | null {
    if (node.type === 'variable_declarator') {
      // فقط اگر مقدارش واقعاً یک تابع باشد، آن هم از annotation خودِ تابع
      const fn = this.functionValueOf(node);
      if (!fn) return null;

      const own = fn.namedChildren.find(c => c.type === 'type_annotation');
      return own ? own.text.replace(/^:\s*/, '') : null;
    }

    /*
    | SE-SYM-20 — نوعِ بازگشتی در بیشتر گرامرها یک **فیلد** است
    | (پایتون/راست `return_type`، جاوا `type`، پی‌اچ‌پی `return_type`،
    | Go `result`)، و در C# یک گرهٔ هم‌سطح (`predefined_type`). زبان
    | config‌دار که هیچ‌کدامشان نبود عمداً null برمی‌گرداند — بازگشت به
    | جست‌وجوی `type_annotation` یعنی قاطی‌کردنِ نوعِ زبان‌های دیگر.
    |
    | F-0037 — این مسیر فقط برای سمبلِ **تابع‌مانند** خوانده می‌شود.
    | در C# نامِ کلاس هم یک گرهٔ `identifier` هم‌سطح است، پس بدون این
    | شرط خودِ `class Weather` هم «نوعِ بازگشتی: Weather» می‌گرفت.
    */
    const functionLike = kind === 'function' || kind === 'method';
    if (!functionLike) return null;

    const field = this.grammar?.returnTypeField;
    if (field) {
      const child = node.childForFieldName?.(field);
      return child ? child.text.trim().replace(/^:\s*/, '') : null;
    }

    const childTypes = this.grammar?.returnTypeChildTypes;
    if (childTypes && childTypes.length > 0) {
      const nameNode = node.childForFieldName?.('name');
      const hit = node.namedChildren.find(c => childTypes.includes(c.type) && c !== nameNode);
      return hit ? hit.text.trim() : null;
    }

    if (this.grammar?.paramListNodeTypes || this.grammar?.returnTypeChildTypes) return null;

    const typeAnnotation = node.namedChildren.find(c => c.type === 'type_annotation');
    return typeAnnotation ? typeAnnotation.text.replace(/^:\s*/, '') : null;
  }

  private buildSignature(name: string, parameters: Parameter[], returnType: string | null): string {
    const params = parameters.map(p => {
      let paramName = p.name;
      if (p.optional && !p.defaultValue && !paramName.endsWith('?')) {
        paramName += '?';
      }
      let s = paramName;
      if (p.type) {
        s += `: ${p.type.replace(/\?$/, '')}`;
      }
      if (p.defaultValue) {
        s += ` = ${p.defaultValue}`;
      }
      if (p.rest) {
        s = `...${p.name}${p.type ? `: ${p.type.replace(/\?$/, '')}` : ''}`;
      }
      return s;
    }).join(', ');

    let signature = `${name}(${params})`;
    if (returnType) {
      signature += `: ${returnType}`;
    }
    return signature;
  }

  private extractVisibility(node: Node): SymbolVisibility {
    const accessibility = node.children.find(c => c.type === 'accessibility_modifier');
    if (accessibility) {
      const text = accessibility.text;
      if (text === 'private') return 'private';
      if (text === 'protected') return 'protected';
      if (text === 'public') return 'public';
    }

    const name = this.extractName(node);
    if (name?.startsWith('#')) return 'private';

    return 'public';
  }

  private extractModifiers(node: Node): {
    async: boolean;
    generator: boolean;
    abstract: boolean;
    static: boolean;
    readonly: boolean;
  } {
    const children = node.children;
    return {
      async: children.some(c => c.type === 'async'),
      generator:
        node.type.includes('generator') ||
        children.some(c => c.type === '*' || c.text === '*'),
      abstract: children.some(c => c.type === 'abstract'),
      static: children.some(c => c.type === 'static'),
      readonly: children.some(c => c.type === 'readonly'),
    };
  }

  private isExported(node: Node): boolean {
    let current: Node | null = node;
    while (current) {
      if (current.type === 'export_statement' || current.type === 'export_declaration') {
        return true;
      }
      current = current.parent;
    }
    return false;
  }

  private extractGenerics(node: Node): string[] {
    const typeParams = node.namedChildren.find(c => c.type === 'type_parameters');
    if (!typeParams) return [];
    return typeParams.namedChildren.map(c => c.text);
  }

  /**
   * والدهای یک کلاس یا interface.
   *
   * SE-SYM-12: فقط `class_heritage` بررسی می‌شد. ارث‌بری interface در
   * گرامر TS از `extends_type_clause` می‌آید — یک گرهٔ *هم‌سطح*، نه
   * زیرِ heritage — پس `interface A extends B` هرگز یال نمی‌ساخت و
   * TypeGraph بخش بزرگی از سلسله‌مراتب تایپ را از دست می‌داد.
   */
  private extractExtends(node: Node): string[] {
    /*
    | SE-SYM-20 — پدرها در هر گرامر جای دیگری‌اند:
    |   java   فیلد `superclass`   (گرهٔ `superclass` → `type_identifier`)
    |   ruby   فیلد `superclass`   (`< B`)
    |   python فرزندِ `argument_list` (`class A(B, C):` — فیلد ندارد)
    |   csharp فرزندِ `base_list`    (`: B, IC`)
    |   php    فرزندِ `base_clause`
    | اگر زبانِ config‌دار چیزی پیدا نکرد، [] برمی‌گردد و به نام‌هایِ TS
    | برنمی‌گردد — آن fallback یعنی حدس‌زدنِ ساختارِ یک گرامرِ دیگر.
    */
    const fromConfig = this.collectFromClauses(node, this.grammar?.extendsFields, this.grammar?.extendsChildTypes);
    if (fromConfig.length > 0) return fromConfig;
    if (this.grammar && (this.grammar.extendsFields?.length || this.grammar.extendsChildTypes?.length)) return [];

    const interfaceClause = node.namedChildren.find(c => c.type === 'extends_type_clause');
    if (interfaceClause) {
      return interfaceClause.namedChildren
        .map(c => c.text)
        .filter(t => t !== 'extends' && t.length > 0);
    }

    const heritage = node.namedChildren.find(c => c.type === 'class_heritage');
    if (!heritage) return [];
    const extendsClause = heritage.namedChildren.find(c => c.type === 'extends_clause');
    if (!extendsClause) return [];
    return extendsClause.namedChildren
      .map(c => c.text)
      .filter(t => t !== 'extends' && t.length > 0);
  }

  private extractImplements(node: Node): string[] {
    const fromConfig = this.collectFromClauses(node, this.grammar?.implementsFields, this.grammar?.implementsChildTypes);
    if (fromConfig.length > 0) return fromConfig;
    if (this.grammar && (this.grammar.implementsFields?.length || this.grammar.implementsChildTypes?.length)) return [];

    const heritage = node.namedChildren.find(c => c.type === 'class_heritage');
    if (!heritage) return [];
    const implementsClause = heritage.namedChildren.find(c => c.type === 'implements_clause');
    if (!implementsClause) return [];
    return implementsClause.namedChildren
      .map(c => c.text)
      .filter(t => t !== 'implements' && t.length > 0);
  }

  /**
   * نامِ type‌ها را از فیلدها/گره‌هایِ اعلام‌شده بیرون می‌کشد.
   *
   * عمق محدود است و از بدنه بیرون نمی‌ماند، تا یک `class_body` یا
   * `block` تصادفاً به‌عنوانِ والد ثبت نشود.
   */
  private collectFromClauses(
    node: Node,
    fields: readonly string[] | undefined,
    childTypes: readonly string[] | undefined
  ): string[] {
    const sink: string[] = [];

    for (const field of fields ?? []) {
      const clause = node.childForFieldName?.(field);
      if (clause) this.collectTypeNames(clause, sink);
    }

    for (const type of childTypes ?? []) {
      const clause = node.namedChildren.find(c => c.type === type);
      if (clause) this.collectTypeNames(clause, sink);
    }

    return [...new Set(sink)];
  }

  /** گره‌هایی که «بدنه‌اند» و هرگز به‌عنوانِ نامِ والد خوانده نمی‌شوند. */
  private static readonly BODY_NODE_TYPES = new Set([
    'class_body', 'interface_body', 'declaration_list', 'enum_body', 'block',
    'body_statement', 'compound_statement', 'statements', 'function_body', 'field_initializer',
  ]);

  private collectTypeNames(node: Node, sink: string[], depth = 0): void {
    if (depth > 3) return;

    for (const child of node.namedChildren) {
      if (TreeSitterSymbolMapper.BODY_NODE_TYPES.has(child.type)) continue;

      if (TreeSitterSymbolMapper.PARAM_TYPE_NODES.has(child.type) ||
        child.type === 'type_identifier' || child.type === 'generic_name' ||
        child.type === 'scoped_identifier' || child.type === 'identifier' ||
        child.type === 'constant' || child.type === 'attribute' ||
        child.type === 'member_expression' || child.type === 'name') {
        const raw = child.type === 'generic_name'
          ? (child.childForFieldName?.('name')?.text ?? child.text.split('<')[0] ?? '')
          : child.text;
        const name = raw.trim().replace(/\s+/g, ' ');
        if (name && name !== 'extends' && name !== 'implements') sink.push(name);
        continue;
      }

      this.collectTypeNames(child, sink, depth + 1);
    }
  }

  private computeConfidence(node: Node): Confidence {
    let score = 85;
    if (this.isExported(node)) score += 5;
    if (node.hasError) score -= 20;
    return makeConfidence(Math.max(50, Math.min(98, score)));
  }
}
