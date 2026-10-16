import { JsonSymbolExtractor } from './JsonSymbolExtractor';

const extractor = new JsonSymbolExtractor();

describe('JsonSymbolExtractor', () => {
  it('should extract top-level keys as property symbols', async () => {
    const content = `{
  "name": "semantic-engine",
  "version": "1.0.0",
  "scripts": {
    "build": "tsc"
  }
}`;

    const result = await extractor.extract('f1', 'package.json', content, 'json');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const names = result.value.symbols.map(s => s.name);
    expect(names).toContain('name');
    expect(names).toContain('version');
    expect(names).toContain('scripts');
    expect(names).toContain('build');

    const buildSymbol = result.value.symbols.find(s => s.name === 'build');
    expect(buildSymbol?.kind).toBe('property');
    expect(buildSymbol?.parentId).not.toBeNull();
  });

  it('should keep symbol id stable when value changes', async () => {
    const contentV1 = `{"name":"v1"}`;
    const contentV2 = `{"name":"v2"}`;

    const resultV1 = await extractor.extract('f1', 'config.json', contentV1, 'json');
    const resultV2 = await extractor.extract('f1', 'config.json', contentV2, 'json');

    expect(resultV1.ok && resultV2.ok).toBe(true);
    if (!resultV1.ok || !resultV2.ok) return;

    expect(resultV1.value.symbols[0]?.id).toBe(resultV2.value.symbols[0]?.id);
  });

  it('should handle JSON with comments (jsonc)', async () => {
    const content = `{
  // project name
  "name": "test"
}`;

    const result = await extractor.extract('f1', 'tsconfig.json', content, 'jsonc');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.symbols.map(s => s.name)).toContain('name');
  });

  it('should return partial result on invalid JSON', async () => {
    const content = `{ invalid }`;

    const result = await extractor.extract('f1', 'broken.json', content, 'json');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.partial).toBe(true);
    expect(result.value.symbols).toHaveLength(0);
  });
});

/*
| SE-SYM-21 و SE-SYM-22 — معیار پذیرش فاز ۱۶.
*/
describe('json with real-world content', () => {

  const extract = async (content: string, path = 'package.json', language = 'json') => {
    const result = await new JsonSymbolExtractor().extract('f1', path, content, language);
    if (!result.ok) throw result.error;
    return result.value;
  };

  /*
  | معیار پذیرش: «`package.json` دارای `homepage` با URL، symbol تولید
  | کند.» پیش از این صفر symbol و `partial: true` می‌داد، چون
  | `stripComments` رشتهٔ URL را از `//` می‌بُرید.
  */
  it('extracts from a package.json that has URLs in it', async () => {
    const content = JSON.stringify({
      name: 'pkg',
      homepage: 'https://example.com/docs',
      repository: { type: 'git', url: 'git+https://github.com/a/b.git' },
    }, null, 2);

    const result = await extract(content);

    expect(result.partial).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.symbols.map(s => s.name)).toEqual(
      expect.arrayContaining(['name', 'homepage', 'repository', 'type', 'url'])
    );
  });

  it('survives a glob pattern that looks like a block comment', async () => {
    const result = await extract('{"include":["src/**/*.ts"],"strict":true}', 'tsconfig.json');

    expect(result.partial).toBe(false);
    expect(result.symbols.map(s => s.name)).toEqual(['include', 'strict']);
  });

  /*
  | SE-SYM-22 — دو کلید هم‌نام در دو مسیر باید دو خط متفاوت بگیرند.
  | روش قبلی هر دو را به اولین رخداد نسبت می‌داد.
  */
  it('gives same-named keys at different paths their own lines', async () => {
    const content = `{
  "build": {
    "target": "es5"
  },
  "test": {
    "target": "es2022"
  }
}`;

    const targets = (await extract(content, 'a.json')).symbols.filter(s => s.name === 'target');

    expect(targets).toHaveLength(2);
    expect(targets.map(s => s.line)).toEqual([3, 6]);
    expect(new Set(targets.map(s => s.id)).size).toBe(2);
  });

  it('records the full path in the qualified name', async () => {
    const symbols = (await extract('{"a":{"b":1}}', 'a.json')).symbols;

    expect(symbols.find(s => s.name === 'b')?.fullyQualifiedName).toBe('a.json::a.b');
  });

  it('links a nested key to its parent', async () => {
    const symbols = (await extract('{"a":{"b":1}}', 'a.json')).symbols;
    const parent = symbols.find(s => s.name === 'a');
    const child = symbols.find(s => s.name === 'b');

    expect(child?.parentId).toBe(parent?.id);
    expect(parent?.parentId).toBeNull();
  });

  it('spans an object value to its closing brace', async () => {
    const content = `{
  "a": {
    "b": 1
  }
}`;
    const a = (await extract(content, 'a.json')).symbols.find(s => s.name === 'a');

    expect(a).toMatchObject({ line: 2, endLine: 4 });
  });

  it('rejects comments in plain json but accepts them in jsonc', async () => {
    const content = '{\n  // pick one\n  "a": 1\n}';

    expect((await extract(content, 'a.json', 'json')).partial).toBe(true);
    expect((await extract(content, 'a.jsonc', 'jsonc')).partial).toBe(false);
  });

  it('reports a malformed file instead of throwing', async () => {
    const result = await extract('{"a" 1}', 'a.json');

    expect(result.partial).toBe(true);
    expect(result.symbols).toEqual([]);
    expect(result.warnings[0]).toContain('JSON parse error');
  });
});
