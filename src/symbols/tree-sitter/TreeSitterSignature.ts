/**
 * Parameter, return-type and signature extraction for the tree-sitter mapper.
 * Pure functions over a node and the language's grammar table.
 */

import { Node } from 'web-tree-sitter';
import { Parameter, SymbolKind } from '../../core/types/project-index.types';
import { grammarFor } from './languageGrammars';
import { PARAM_TYPE_NODES } from './TreeSitterHeritage';

type Grammar = ReturnType<typeof grammarFor>;

/** `const f = () => {}` — the function value behind a variable declarator. */
export function functionValueOf(node: Node): Node | null {
  if (node.type !== 'variable_declarator') return null;

  return node.namedChildren.find(child =>
    child.type === 'arrow_function' ||
    child.type === 'function_expression' ||
    child.type === 'function' ||
    child.type === 'generator_function'
  ) ?? null;
}

export function extractParameters(grammar: Grammar, node: Node): Parameter[] {
  const source = functionValueOf(node) ?? node;
  /*
  | SE-SYM-20 — نامِ گرهٔ لیستِ پارامتر گرامر‌به‌گرامر فرق دارد
  | (پایتون `parameters`، C#/Go `parameter_list`، روبی
  | `method_parameters`، راست `parameters`). پیش‌فرض همان
  | `formal_parameters` می‌ماند تا مسیر TS/JS تکان نخورد.
  */
  const declared = grammar?.paramListNodeTypes;
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
    .map(p => (useStructural ? parseStructuralParameter(p) : parseParameter(p)))
    .filter((p): p is Parameter => p !== null);
}

/** گره‌هایی که «نام» پارامترند، در گرامرهایِ غیر از TS. */
const PARAM_NAME_NODES = new Set([
  'identifier', 'variable_name', 'name', 'field_identifier', 'this', 'type_identifier',
]);

/** فیلدهایی که در بیشتر گرامرها «نامِ پارامتر» را می‌دهند. */
const PARAM_NAME_FIELDS = ['name', 'pattern'] as const;
/** فیلدهایی که «نوعِ پارامتر» را می‌دهند. */
const PARAM_TYPE_FIELDS = ['type', 'type_hint'] as const;

function parseStructuralParameter(param: Node): Parameter | null {
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
  const typeField = fieldRead(PARAM_TYPE_FIELDS);
  const nameField = fieldRead(PARAM_NAME_FIELDS);

  const typeChild = typeField
    ?? named.find(c => PARAM_TYPE_NODES.has(c.type))
    ?? null;
  const nameChild = nameField
    ?? named.find(c => c !== typeChild && PARAM_NAME_NODES.has(c.type))
    ?? null;

  // مقدارِ پیش‌فرض: گرهٔ مقدار در `default_parameter`/`optional_parameter`
  const valueChild = named.find(c =>
    c !== typeChild && c !== nameChild &&
    !PARAM_TYPE_NODES.has(c.type) &&
    PARAM_NAME_NODES.has(c.type) === false
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

function parseParameter(param: Node): Parameter | null {
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
export function extractReturnType(grammar: Grammar, node: Node, kind: SymbolKind): string | null {
  if (node.type === 'variable_declarator') {
    // فقط اگر مقدارش واقعاً یک تابع باشد، آن هم از annotation خودِ تابع
    const fn = functionValueOf(node);
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

  const field = grammar?.returnTypeField;
  if (field) {
    const child = node.childForFieldName?.(field);
    return child ? child.text.trim().replace(/^:\s*/, '') : null;
  }

  const childTypes = grammar?.returnTypeChildTypes;
  if (childTypes && childTypes.length > 0) {
    const nameNode = node.childForFieldName?.('name');
    const hit = node.namedChildren.find(c => childTypes.includes(c.type) && c !== nameNode);
    return hit ? hit.text.trim() : null;
  }

  if (grammar?.paramListNodeTypes || grammar?.returnTypeChildTypes) return null;

  const typeAnnotation = node.namedChildren.find(c => c.type === 'type_annotation');
  return typeAnnotation ? typeAnnotation.text.replace(/^:\s*/, '') : null;
}

export function buildSignature(name: string, parameters: Parameter[], returnType: string | null): string {
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
