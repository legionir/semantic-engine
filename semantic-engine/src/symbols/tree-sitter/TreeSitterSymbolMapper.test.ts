/**
 * استخراج‌گر tree-sitter — فاز ۱۷.
 *
 * همهٔ ادعاهای اینجا اول روی AST واقعی بازتولید شدند، نه از روی حدس.
 * نوع گره‌ها با یک probe روی گرامر واقعی بیرون کشیده شد:
 *
 *   const f = () => {}      → variable_declarator > arrow_function > formal_parameters
 *   abstract class X {}     → abstract_class_declaration     (نه class_declaration)
 *   namespace N {}          → internal_module                (نه namespace_declaration)
 *   enum E { A = 1 }        → enum_body > enum_assignment
 *   interface A extends B   → extends_type_clause            (نه class_heritage)
 *   function f(): void;     → function_signature
 */

import * as path from 'path';
import { TreeSitterParserManager } from './TreeSitterParserManager';
import { TreeSitterSymbolExtractor } from './TreeSitterSymbolExtractor';
import { SymbolEntry } from '../../core/types/project-index.types';

const GRAMMARS = path.join(__dirname, '..', '..', '..', 'tree-sitter-grammars');

let parserManager: TreeSitterParserManager;
let extractor: TreeSitterSymbolExtractor;

beforeAll(() => {
  parserManager = new TreeSitterParserManager({ grammarDir: GRAMMARS });
  extractor = new TreeSitterSymbolExtractor({ parserManager });
});

afterAll(async () => {
  await parserManager.dispose();
});

async function extract(source: string, language = 'typescript'): Promise<readonly SymbolEntry[]> {
  const result = await extractor.extract('f1', 'src/a.ts', source, language);
  if (!result.ok) throw result.error;
  return result.value.symbols;
}

const byName = (symbols: readonly SymbolEntry[], name: string) => symbols.find(s => s.name === name);

describe('arrow functions (SE-SYM-10)', () => {

  /*
  | `extractParameters` دنبال یک `formal_parameters` *مستقیم* می‌گشت.
  | برای یک arrow، گرهٔ symbol از `variable_declarator` می‌آید و
  | پارامترها یک سطح پایین‌تر زیر `arrow_function` هستند. نتیجه: کل
  | API کامپوننت‌های React و هوک‌ها بدون پارامتر ایندکس می‌شد.
  */
  it('reads the parameters of an arrow function', async () => {
    const symbols = await extract('export const greet = (name: string, times: number) => {\n  return name;\n};\n');

    expect(byName(symbols, 'greet')?.parameters?.map(p => p.name)).toEqual(['name', 'times']);
  });

  it('reads the types of arrow parameters', async () => {
    const symbols = await extract('const greet = (name: string, times: number) => name;\n');

    expect(byName(symbols, 'greet')?.parameters).toEqual([
      expect.objectContaining({ name: 'name', type: 'string' }),
      expect.objectContaining({ name: 'times', type: 'number' }),
    ]);
  });

  it('reads the parameters of a destructuring react component', async () => {
    const symbols = await extract('export const Button = ({ label, onClick }: Props) => null;\n');

    expect(byName(symbols, 'Button')?.parameters).toHaveLength(1);
  });

  it('reads the parameters of an async arrow', async () => {
    const symbols = await extract('const load = async (url: string) => { return 1; };\n');

    expect(byName(symbols, 'load')?.parameters?.map(p => p.name)).toEqual(['url']);
  });

  it('reads the parameters of a function expression', async () => {
    const symbols = await extract('const f = function (a: number, b: number) { return a; };\n');

    expect(byName(symbols, 'f')?.parameters?.map(p => p.name)).toEqual(['a', 'b']);
  });

  it('builds a signature that shows the parameters', async () => {
    const symbols = await extract('const greet = (name: string) => name;\n');

    expect(byName(symbols, 'greet')?.signature).toContain('name');
  });

  it('takes the return type from the arrow, not the variable', async () => {
    const symbols = await extract('const run = (x: number): string => "a";\n');

    expect(byName(symbols, 'run')?.returnType).toBe('string');
  });

  it('leaves an ordinary variable without parameters', async () => {
    const symbols = await extract('const total = 42;\n');

    expect(byName(symbols, 'total')?.parameters).toEqual([]);
  });
});

describe('node types that were missing (SE-SYM-11)', () => {

  /*
  | `abstract_class_declaration` در جدول نبود، پس کل کلاس گم می‌شد —
  | نه فقط پرچم abstract. متدهایش هم بدون والد بیرون می‌آمدند.
  */
  it('finds an abstract class', async () => {
    const symbols = await extract('export abstract class Repo {\n  abstract find(id: string): void;\n}\n');

    expect(byName(symbols, 'Repo')).toMatchObject({ kind: 'class', abstract: true });
  });

  it('attaches the methods of an abstract class to it', async () => {
    const symbols = await extract('export abstract class Repo {\n  abstract find(id: string): void;\n}\n');

    expect(byName(symbols, 'find')?.parentId).toBe(byName(symbols, 'Repo')?.id);
  });

  it('finds a namespace, whose real node type is internal_module', async () => {
    const symbols = await extract('export namespace Utils {\n  export const x = 1;\n}\n');

    expect(byName(symbols, 'Utils')).toMatchObject({ kind: 'namespace' });
    expect(byName(symbols, 'x')?.parentId).toBe(byName(symbols, 'Utils')?.id);
  });

  it('finds an overload signature', async () => {
    const symbols = await extract(`export function parse(v: string): number;
export function parse(v: number): number;
export function parse(v: unknown): number { return 1; }
`);

    expect(symbols.filter(s => s.name === 'parse')).toHaveLength(3);
  });

  it('finds enum members with values', async () => {
    const symbols = await extract('export enum Color {\n  Red = "red",\n  Blue = "blue",\n}\n');

    expect(symbols.map(s => s.name)).toEqual(expect.arrayContaining(['Color', 'Red', 'Blue']));
    expect(byName(symbols, 'Red')?.parentId).toBe(byName(symbols, 'Color')?.id);
  });

  it('finds enum members without values', async () => {
    const symbols = await extract('enum Direction {\n  Up,\n  Down,\n}\n');

    expect(symbols.map(s => s.name)).toEqual(expect.arrayContaining(['Direction', 'Up', 'Down']));
  });

  it('gives enum members a sensible kind', async () => {
    const symbols = await extract('enum Color {\n  Red = "red",\n}\n');

    expect(byName(symbols, 'Red')?.kind).toBe('constant');
  });

  it('finds an ambient module declaration', async () => {
    const symbols = await extract('declare module "legacy" {\n  export const version: string;\n}\n');

    expect(symbols.some(s => s.kind === 'module' || s.kind === 'namespace')).toBe(true);
  });
});

describe('interface inheritance (SE-SYM-12)', () => {

  /*
  | `extractExtends` فقط `class_heritage` را می‌شناخت. ارث‌بری
  | interface از `extends_type_clause` می‌آید، پس TypeGraph بخش
  | بزرگی از سلسله‌مراتب تایپ را از دست می‌داد.
  */
  it('reads what an interface extends', async () => {
    const symbols = await extract('export interface A extends B {\n  x: number;\n}\n');

    expect(byName(symbols, 'A')?.extends).toEqual(['B']);
  });

  it('reads multiple interface parents', async () => {
    const symbols = await extract('interface A extends B, C {\n  x: number;\n}\n');

    expect(byName(symbols, 'A')?.extends).toEqual(['B', 'C']);
  });

  it('still reads what a class extends', async () => {
    const symbols = await extract('class A extends Base {\n  m() {}\n}\n');

    expect(byName(symbols, 'A')?.extends).toEqual(['Base']);
  });

  it('still reads what a class implements', async () => {
    const symbols = await extract('class A implements Contract {\n  m() {}\n}\n');

    expect(byName(symbols, 'A')?.implements).toEqual(['Contract']);
  });

  it('reads a generic parent', async () => {
    const symbols = await extract('interface A extends Base<string> {\n  x: number;\n}\n');

    expect(byName(symbols, 'A')?.extends).toEqual(['Base<string>']);
  });
});

describe('return types (SE-SYM-13)', () => {

  /*
  | `extractReturnType` اولین `type_annotation` را برمی‌داشت. روی
  | `const x: Foo = …` آن annotation نوعِ *متغیر* است، نه نوع بازگشتی.
  */
  it('does not call a variable type annotation a return type', async () => {
    const symbols = await extract('export const config: Settings = { a: 1 };\n');

    expect(byName(symbols, 'config')?.returnType).toBeNull();
  });

  it('reads the return type of a function', async () => {
    const symbols = await extract('function parse(v: string): number { return 1; }\n');

    expect(byName(symbols, 'parse')?.returnType).toBe('number');
  });

  it('reads the return type of a method', async () => {
    const symbols = await extract('class A {\n  run(): Promise<void> { return Promise.resolve(); }\n}\n');

    expect(byName(symbols, 'run')?.returnType).toBe('Promise<void>');
  });

  it('prefers the arrow return type over the variable annotation', async () => {
    const symbols = await extract('const run: Handler = (x: number): string => "a";\n');

    expect(byName(symbols, 'run')?.returnType).toBe('string');
  });
});

describe('scope and anonymous exports (found during phase 17)', () => {

  /*
  | SE-SYM-31 — مسئله «والد گمشده» نبود، **والد غلط** بود. فقط
  | containerها والد فرزندانشان می‌شدند، پس یک متغیر محلی داخل
  | `A.run()` به‌عنوان عضو کلاس `A` ثبت می‌شد. هر مصرف‌کننده‌ای که
  | بپرسد «اعضای A چیست» یک متغیر محلی تحویل می‌گرفت.
  */
  it('attaches a local of a method to the method, not to the class', async () => {
    const symbols = await extract(`class A {
  run() {
    const helper = (x: number) => x;
    return helper;
  }
}
`);

    expect(byName(symbols, 'helper')?.parentId).toBe(byName(symbols, 'run')?.id);
    expect(byName(symbols, 'helper')?.parentId).not.toBe(byName(symbols, 'A')?.id);
  });

  it('attaches a nested function to its enclosing function', async () => {
    const symbols = await extract('function outer() {\n  function inner() {}\n  return inner;\n}\n');

    expect(byName(symbols, 'inner')?.parentId).toBe(byName(symbols, 'outer')?.id);
  });

  it('reflects the nesting in the qualified name', async () => {
    const symbols = await extract('class A {\n  run() {\n    const helper = 1;\n  }\n}\n');

    expect(byName(symbols, 'helper')?.fullyQualifiedName).toBe('src/a.ts::A.run.helper');
  });

  it('finds symbols inside an arrow-valued constant', async () => {
    const symbols = await extract('const outer = () => {\n  function inner() {}\n  return inner;\n};\n');

    expect(byName(symbols, 'inner')?.parentId).toBe(byName(symbols, 'outer')?.id);
  });

  /*
  | SE-SYM-32 — گرامر برای `export default function () {}` گرهٔ اعلان
  | نمی‌سازد، یک عبارت بی‌نام زیر `export_statement` می‌گذارد. نتیجه
  | اینکه ماژول‌هایی که تنها صادراتشان همین است، در ایندکس **هیچ API
  | نداشتند**.
  */
  it('names an anonymous default-exported function', async () => {
    const symbols = await extract('export default function () { return 1; }\n');

    expect(byName(symbols, 'default')).toMatchObject({ kind: 'function' });
  });

  it('names an anonymous default-exported class', async () => {
    const symbols = await extract('export default class {\n  run() {}\n}\n');

    expect(byName(symbols, 'default')).toMatchObject({ kind: 'class' });
    expect(byName(symbols, 'run')?.parentId).toBe(byName(symbols, 'default')?.id);
  });

  it('names an anonymous default-exported arrow', async () => {
    const symbols = await extract('export default (a: number) => a;\n');

    expect(byName(symbols, 'default')?.parameters?.map(p => p.name)).toEqual(['a']);
  });

  it('leaves a named default export with its own name', async () => {
    const symbols = await extract('export default function main() { return 1; }\n');

    expect(byName(symbols, 'main')).toBeDefined();
    expect(byName(symbols, 'default')).toBeUndefined();
  });

  it('finds a method defined on an object literal', async () => {
    const symbols = await extract('export const api = {\n  get(id: string) { return id; },\n};\n');

    expect(byName(symbols, 'get')?.parentId).toBe(byName(symbols, 'api')?.id);
  });
});
