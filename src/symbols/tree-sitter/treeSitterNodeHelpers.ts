/**
 * Pure node helpers of the tree-sitter symbol mapper
 * (split from TreeSitterSymbolMapper.ts, behavior unchanged).
 */

import type { Node } from 'web-tree-sitter';
import type { SymbolVisibility } from '../../core/types/project-index.types';

/**
 * آیا این گره سازنده است؟ F-0037.
 *
 * از دو نشانه خوانده می‌شود چون گرامرها یکسان نیستند: نامِ گرهٔ اعلان
 * (`constructor_declaration` در C#/Java، `constructor_definition` در TS)
 * و نامِ رویه‌ای پایتون. `fn new()` راست عمداً اینجا نیست — آن یک متد
 * استاتیک معمولی است، نه سازندهٔ گرامری.
 */
export function isConstructorNode(node: Node, name: string): boolean {
  if (/constructor/i.test(node.type)) return true;
  return name === '__init__' || name === 'constructor';
}

export function extractModifiers(node: Node): {
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

export function isExported(node: Node): boolean {
  let current: Node | null = node;
  while (current) {
    if (current.type === 'export_statement' || current.type === 'export_declaration') {
      return true;
    }
    current = current.parent;
  }
  return false;
}

export function extractName(node: Node, nameNodeTypes: readonly string[]): string | null {
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
  if (node.namedChildCount === 0 && nameNodeTypes.includes(node.type)) {
    return node.text;
  }

  // برای variable_declarator نام می‌تواند identifier، array_pattern یا object_pattern باشد
  const nameNode = node.namedChildren.find(c => nameNodeTypes.includes(c.type));

  return nameNode?.text ?? null;
}

export function extractVisibility(node: Node, nameNodeTypes: readonly string[]): SymbolVisibility {
  const accessibility = node.children.find(c => c.type === 'accessibility_modifier');
  if (accessibility) {
    const text = accessibility.text;
    if (text === 'private') return 'private';
    if (text === 'protected') return 'protected';
    if (text === 'public') return 'public';
  }

  const name = extractName(node, nameNodeTypes);
  if (name?.startsWith('#')) return 'private';

  return 'public';
}
