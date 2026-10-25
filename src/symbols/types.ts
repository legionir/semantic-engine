/**
 * تایپ‌های symbol مستقل از ویرایشگر.
 *
 * `DocumentSymbolLike` عمداً همان شکل `vscode.DocumentSymbol` و
 * `DocumentSymbol` پروتکل LSP است — هر دو `range`ی صفرمبنا با
 * `line`/`character` دارند. تنها جایی که این دو دنیا واقعاً فرق
 * می‌کنند، شماره‌گذاری `SymbolKind` است، و همان‌جاست که تا امروز یک
 * باگ خاموش خوابیده بود:
 *
 *   VS Code : File = 0  … TypeParameter = 25
 *   LSP     : File = 1  … TypeParameter = 26
 *
 * چون هر دو «عدد» هستند، کامپایلر جابه‌جایی را نمی‌گیرد. نتیجهٔ وصل
 * کردن نگاشتِ صفرمبنا به یک زبان‌سرور واقعی این است که هر symbol یک
 * رده می‌لغزد — class به interface، method به property — بدون هیچ
 * خطایی. دو enum جدا و دو تابع تبدیل صریح، این را به خطای کامپایل
 * تبدیل می‌کنند.
 */

/** شماره‌گذاری خودِ پروتکل LSP (یک‌مبنا). مرجع: LSP 3.17. */
export enum LspSymbolKind {
  File = 1,
  Module = 2,
  Namespace = 3,
  Package = 4,
  Class = 5,
  Method = 6,
  Property = 7,
  Field = 8,
  Constructor = 9,
  Enum = 10,
  Interface = 11,
  Function = 12,
  Variable = 13,
  Constant = 14,
  String = 15,
  Number = 16,
  Boolean = 17,
  Array = 18,
  Object = 19,
  Key = 20,
  Null = 21,
  EnumMember = 22,
  Struct = 23,
  Event = 24,
  Operator = 25,
  TypeParameter = 26,
}

/** شماره‌گذاری VS Code (صفرمبنا). مرجع: vscode.d.ts. */
export enum VsCodeSymbolKind {
  File = 0,
  Module = 1,
  Namespace = 2,
  Package = 3,
  Class = 4,
  Method = 5,
  Property = 6,
  Field = 7,
  Constructor = 8,
  Enum = 9,
  Interface = 10,
  Function = 11,
  Variable = 12,
  Constant = 13,
  String = 14,
  Number = 15,
  Boolean = 16,
  Array = 17,
  Object = 18,
  Key = 19,
  Null = 20,
  EnumMember = 21,
  Struct = 22,
  Event = 23,
  Operator = 24,
  TypeParameter = 25,
}

/** نام هر مقدار LSP — برای پیام خطا و لاگ خوانا. */
export const LSP_SYMBOL_KIND_NAMES: Readonly<Record<LspSymbolKind, string>> = {
  [LspSymbolKind.File]: 'File',
  [LspSymbolKind.Module]: 'Module',
  [LspSymbolKind.Namespace]: 'Namespace',
  [LspSymbolKind.Package]: 'Package',
  [LspSymbolKind.Class]: 'Class',
  [LspSymbolKind.Method]: 'Method',
  [LspSymbolKind.Property]: 'Property',
  [LspSymbolKind.Field]: 'Field',
  [LspSymbolKind.Constructor]: 'Constructor',
  [LspSymbolKind.Enum]: 'Enum',
  [LspSymbolKind.Interface]: 'Interface',
  [LspSymbolKind.Function]: 'Function',
  [LspSymbolKind.Variable]: 'Variable',
  [LspSymbolKind.Constant]: 'Constant',
  [LspSymbolKind.String]: 'String',
  [LspSymbolKind.Number]: 'Number',
  [LspSymbolKind.Boolean]: 'Boolean',
  [LspSymbolKind.Array]: 'Array',
  [LspSymbolKind.Object]: 'Object',
  [LspSymbolKind.Key]: 'Key',
  [LspSymbolKind.Null]: 'Null',
  [LspSymbolKind.EnumMember]: 'EnumMember',
  [LspSymbolKind.Struct]: 'Struct',
  [LspSymbolKind.Event]: 'Event',
  [LspSymbolKind.Operator]: 'Operator',
  [LspSymbolKind.TypeParameter]: 'TypeParameter',
};

const LSP_MIN = LspSymbolKind.File;
const LSP_MAX = LspSymbolKind.TypeParameter;

/**
 * VS Code → LSP.
 *
 * ریاضی‌اش «+۱» است، ولی تابع بودنش عمدی است: نقطهٔ تبدیل باید در کد
 * *دیده* شود، وگرنه همان لغزش خاموش برمی‌گردد.
 */
export function lspKindFromVsCode(kind: VsCodeSymbolKind | number): LspSymbolKind {
  const converted = kind + 1;
  if (!Number.isInteger(kind) || converted < LSP_MIN || converted > LSP_MAX) {
    throw new RangeError(
      `Not a VS Code SymbolKind: ${kind} (expected 0…${VsCodeSymbolKind.TypeParameter})`
    );
  }
  return converted as LspSymbolKind;
}

/** LSP → VS Code. */
export function vsCodeKindFromLsp(kind: LspSymbolKind | number): VsCodeSymbolKind {
  if (!Number.isInteger(kind) || kind < LSP_MIN || kind > LSP_MAX) {
    throw new RangeError(`Not an LSP SymbolKind: ${kind} (expected ${LSP_MIN}…${LSP_MAX})`);
  }
  return (kind - 1) as VsCodeSymbolKind;
}

/** برچسب‌های symbol. در VS Code و LSP هر دو یک‌مبنا و یکسان‌اند. */
export enum SymbolTagLike {
  Deprecated = 1,
}

/** موقعیت صفرمبنا — در VS Code و LSP یکسان است. */
export interface PositionLike {
  readonly line: number;
  readonly character: number;
}

export interface RangeLike {
  readonly start: PositionLike;
  readonly end: PositionLike;
}

/**
 * شکل مشترک `DocumentSymbol` در VS Code و LSP.
 *
 * `kind` عمداً تایپ نشده به یکی از دو enum: صاحب داده باید بگوید عدد را
 * از کدام دنیا گرفته است. توابع نگاشت این را می‌خواهند.
 */
export interface DocumentSymbolLike {
  readonly name: string;
  readonly detail?: string;
  readonly kind: number;
  readonly range: RangeLike;
  readonly selectionRange: RangeLike;
  readonly children?: readonly DocumentSymbolLike[];
  readonly tags?: readonly number[];
  readonly deprecated?: boolean;
}
