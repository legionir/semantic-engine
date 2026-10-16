/**
 * Type-hierarchy extraction for the tree-sitter mapper: generics, `extends`
 * and `implements` names of a class/interface node. Grammar-specific field and
 * child-type tables come from `languageGrammars`; with no table for a language
 * the TypeScript node shapes are used.
 */

import { Node } from 'web-tree-sitter';
import { grammarFor } from './languageGrammars';

type Grammar = ReturnType<typeof grammarFor>;

/** Node types that name a type inside a parameter or a heritage clause. */
export const PARAM_TYPE_NODES: ReadonlySet<string> = new Set([
  'type', 'primitive_type', 'predefined_type', 'array_type', 'generic_type',
  'scoped_type_identifier', 'reference_type', 'optional_type', 'nullable_type',
  'union_type', 'tuple_type', 'integral_type', 'floating_point_type',
  'boolean_type', 'string_type', 'void_type', 'object', 'defined_type',
  'qualified_identifier', 'implicit_type',
  // انواعِ اولیه در گرامر جاوا نامِ اختصاصی دارند (`int x` روی `int_type`)
  'int_type', 'long_type', 'short_type', 'byte_type', 'char_type',
  'float_type', 'double_type', 'boolean_primitive_type',
]);

export function extractGenerics(node: Node): string[] {
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
export function extractExtends(grammar: Grammar, node: Node): string[] {
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
  const fromConfig = collectFromClauses(node, grammar?.extendsFields, grammar?.extendsChildTypes);
  if (fromConfig.length > 0) return fromConfig;
  if (grammar && (grammar.extendsFields?.length || grammar.extendsChildTypes?.length)) return [];

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

export function extractImplements(grammar: Grammar, node: Node): string[] {
  const fromConfig = collectFromClauses(node, grammar?.implementsFields, grammar?.implementsChildTypes);
  if (fromConfig.length > 0) return fromConfig;
  if (grammar && (grammar.implementsFields?.length || grammar.implementsChildTypes?.length)) return [];

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
function collectFromClauses(
  node: Node,
  fields: readonly string[] | undefined,
  childTypes: readonly string[] | undefined
): string[] {
  const sink: string[] = [];

  for (const field of fields ?? []) {
    const clause = node.childForFieldName?.(field);
    if (clause) collectTypeNames(clause, sink);
  }

  for (const type of childTypes ?? []) {
    const clause = node.namedChildren.find(c => c.type === type);
    if (clause) collectTypeNames(clause, sink);
  }

  return [...new Set(sink)];
}

/** گره‌هایی که «بدنه‌اند» و هرگز به‌عنوانِ نامِ والد خوانده نمی‌شوند. */
const BODY_NODE_TYPES = new Set([
  'class_body', 'interface_body', 'declaration_list', 'enum_body', 'block',
  'body_statement', 'compound_statement', 'statements', 'function_body', 'field_initializer',
]);

function collectTypeNames(node: Node, sink: string[], depth = 0): void {
  if (depth > 3) return;

  for (const child of node.namedChildren) {
    if (BODY_NODE_TYPES.has(child.type)) continue;

    if (PARAM_TYPE_NODES.has(child.type) ||
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

    collectTypeNames(child, sink, depth + 1);
  }
}
