/**
 * SE-SYM-20 (REMEDIATION_PLAN C-1 / finding F-0028).
 *
 * > پارامتر، نوع بازگشتی، extends و implements برای همهٔ زبان‌های
 * > tree-sitter‌دار باید پر شوند — نه فقط TypeScript.
 *
 * پیش از این فاز `TreeSitterSymbolMapper` فقط نام‌هایِ گرامر TS را
 * می‌شناخت (`formal_parameters`، `type_annotation`، `class_heritage`،
 * `extends_type_clause`)، پس برای پایتون/جاوا/C#/PHP/روبی/Go/راست
 * `parameters`، `returnType`، `extends` و `implements` خالی می‌ماند و
 * TypeGraph هیچ یالِ وراثتی نمی‌ساخت. نام‌هایِ گره در config از probeٔ
 * خودِ wasmها آمده‌اند، نه از دانشِ عمومیِ گرامرها.
 */

import * as path from 'path';
import { TreeSitterSymbolExtractor } from './TreeSitterSymbolExtractor';
import { TreeSitterParserManager } from './TreeSitterParserManager';
import { SymbolEntry } from '../../core/types/project-index.types';

const grammarDir = path.join(__dirname, '..', '..', '..', 'tree-sitter-grammars');

async function extract(languageId: string, source: string): Promise<SymbolEntry[]> {
  const extractor = new TreeSitterSymbolExtractor({
    parserManager: new TreeSitterParserManager({ grammarDir }),
  });
  const result = await extractor.extract(`f-${languageId}`, `s.${languageId}`, source, languageId);
  if (!result.ok) throw new Error(`extraction failed for ${languageId}`);
  return [...result.value.symbols];
}

const byName = (symbols: SymbolEntry[], name: string): SymbolEntry => {
  const hit = symbols.find(s => s.name === name);
  if (!hit) throw new Error(`symbol ${name} missing; got: ${symbols.map(s => s.name).join(', ')}`);
  return hit;
};

describe('SE-SYM-20 — params / return type / inheritance خارج از TypeScript', () => {
  it('python: bases از argument_list، params و return_type', async () => {
    const symbols = await extract('python', `class Child(Base, Mixin):\n    def run(self, x: int, y="z") -> bool:\n        return True\n`);

    expect(byName(symbols, 'Child').extends).toEqual(['Base', 'Mixin']);
    const run = byName(symbols, 'run');
    expect(run.returnType).toBe('bool');
    expect(run.parameters?.map(p => p.name)).toEqual(['self', 'x', 'y']);
    expect(run.parameters?.find(p => p.name === 'x')?.type).toBe('int');
    expect(run.parameters?.find(p => p.name === 'y')).toMatchObject({ optional: true, defaultValue: '"z"' });
  });

  it('java: superclass و interfaces از فیلدهایِ گرامر', async () => {
    const symbols = await extract('java', `package app;\npublic class Foo extends Bar implements Baz {\n  public int m(int a, String b) { return a; }\n}\n`);

    const foo = byName(symbols, 'Foo');
    expect(foo.extends).toEqual(['Bar']);
    expect(foo.implements).toEqual(['Baz']);
    const m = byName(symbols, 'm');
    expect(m.returnType).toBe('int');
    // نامِ پارامتر دیگر «int a» نیست: نام و نوع جدا خوانده می‌شوند
    expect(m.parameters?.map(p => p.name)).toEqual(['a', 'b']);
    expect(m.parameters?.map(p => p.type)).toEqual(['int', 'String']);
  });

  it('csharp: base_list، نوع بازگشتیِ هم‌سطح و parameter_list', async () => {
    const symbols = await extract('csharp', `public class Foo : Bar, IBaz {\n  public bool M(int x, string y) { return true; }\n}\n`);

    expect(byName(symbols, 'Foo').extends).toEqual(['Bar', 'IBaz']);
    const m = byName(symbols, 'M');
    expect(m.returnType).toBe('bool');
    expect(m.parameters?.map(p => p.name)).toEqual(['x', 'y']);
    expect(m.parameters?.map(p => p.type)).toEqual(['int', 'string']);
  });

  it('php: base_clause و class_interface_clause و return_type', async () => {
    const symbols = await extract('php', `<?php\nclass Foo extends Bar implements Baz {\n  public function m(int $x, $y): bool { return true; }\n}\n`);

    const foo = byName(symbols, 'Foo');
    expect(foo.extends).toEqual(['Bar']);
    expect(foo.implements).toEqual(['Baz']);
    const m = byName(symbols, 'm');
    expect(m.returnType).toBe('bool');
    expect(m.parameters?.map(p => p.name)).toEqual(['$x', '$y']);
  });

  it('ruby: superclass؛ و چون annotation ندارد، returnType عمداً null است', async () => {
    const symbols = await extract('ruby', `class Foo < Bar\n  def m(x, y = 1)\n    true\n  end\nend\n`);

    expect(byName(symbols, 'Foo').extends).toEqual(['Bar']);
    const m = byName(symbols, 'm');
    expect(m.parameters?.map(p => p.name)).toEqual(['x', 'y']);
    expect(m.parameters?.find(p => p.name === 'y')?.optional).toBe(true);
    expect(m.returnType).toBeNull();
  });

  it('go: parameter_list و result؛ بدونِ حدس‌زدنِ embedding', async () => {
    const symbols = await extract('go', `package main\n\ntype UserService struct {\n\trepo string\n}\n\ntype Repo interface{}\n\nfunc (s *UserService) Find(id string) (string, error) { return s.repo, nil }\n`);

    const find = byName(symbols, 'Find');
    expect(find.parameters?.map(p => p.name)).toEqual(['id']);
    expect(find.parameters?.[0]?.type).toBe('string');
    expect(find.returnType).toBe('(string, error)');
    // embedding در struct گرامرِ صریحی برای «والد» ندارد؛ پس یالِ جعلی نمی‌سازیم
    expect(byName(symbols, 'UserService').extends).toEqual([]);
  });

  it('rust: parameters و return_type در تابع و متد', async () => {
    const symbols = await extract('rust', `pub struct S;\nimpl S {\n  pub fn m(&self, a: i32) -> i32 { a }\n}\n\npub fn helper(x: u8) -> u8 { x }\n`);

    const m = byName(symbols, 'm');
    expect(m.returnType).toBe('i32');
    expect(m.parameters?.map(p => p.name)).toEqual(['self', 'a']);
    const helper = byName(symbols, 'helper');
    expect(helper.returnType).toBe('u8');
    expect(helper.parameters?.[0]).toMatchObject({ name: 'x', type: 'u8' });
  });

  it('typescript: رفتارِ قبلی دست‌نخورده می‌ماند (رگرسشن)', async () => {
    const symbols = await extract('typescript', `export class Foo extends Bar implements Baz {\n  m(a: number, b = 2): string { return String(a) + b; }\n}\n`);

    const foo = byName(symbols, 'Foo');
    expect(foo.extends).toEqual(['Bar']);
    expect(foo.implements).toEqual(['Baz']);
    const m = byName(symbols, 'm');
    expect(m.returnType).toBe('string');
    expect(m.parameters?.map(p => p.name)).toEqual(['a', 'b']);
    expect(m.parameters?.[0]?.type).toBe('number');
    expect(m.parameters?.[1]).toMatchObject({ optional: true, defaultValue: '2' });
  });
});

/*
| F-0037 — سازنده نوعِ بازگشتی ندارد.
|
| در C#/Java گرهٔ `constructor_declaration` یک گرهٔ نوعِ هم‌سطح (نامِ کلاس)
| دارد، پس مسیرِ گرامر-محورِ تازه آن را به‌عنوانِ returnType برمی‌داشت و
| امضا `WeatherController(...): WeatherController` می‌شد.
*/
describe('F-0037 — سازنده‌ها returnType ندارند', () => {
  it('csharp: سازنده null می‌ماند، متد معمولی نوعش را نگه می‌دارد', async () => {
    const symbols = await extract('csharp', `public class Weather {
  public Weather(int x) { }
  public bool M(int x, string y) { return true; }
}
`);

    // خودِ کلاس هم نباید «نوع بازگشتی» بگیرد (نام کلاس گرهٔ identifier است)
    expect(byName(symbols, 'Weather').returnType).toBeNull();
    const ctor = symbols.find(s => s.kind === 'method' && s.name === 'Weather');
    expect(ctor).toBeDefined();
    expect(ctor?.returnType).toBeNull();
    expect(byName(symbols, 'M').returnType).toBe('bool');
  });

  it('java: سازنده null، متد معمولی پر', async () => {
    const symbols = await extract('java', `package app;
public class Foo {
  public Foo(int a) { }
  public int m(int a) { return a; }
}
`);

    expect(byName(symbols, 'Foo').returnType).toBeNull();
    const javaCtor = symbols.find(s => s.kind === 'method' && s.name === 'Foo');
    expect(javaCtor?.returnType).toBeNull();
    expect(byName(symbols, 'm').returnType).toBe('int');
  });

  it('python: __init__ نوعِ بازگشتی نمی‌گیرد', async () => {
    const symbols = await extract('python', `class Node:
    def __init__(self, v: int) -> "Node":
        self.v = v
`);

    expect(byName(symbols, '__init__').returnType).toBeNull();
  });

  it('typescript: سازنده هم مثل قبل null است (رگرسشن)', async () => {
    const symbols = await extract('typescript', `export class Box {
  constructor(private v: number) { }
  value(): number { return this.v; }
}
`);

    const ctor = symbols.find(s => s.name === 'constructor');
    expect(ctor?.returnType ?? null).toBeNull();
    expect(byName(symbols, 'value').returnType).toBe('number');
  });
});
