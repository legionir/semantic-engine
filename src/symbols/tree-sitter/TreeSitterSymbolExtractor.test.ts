import * as path from 'path';
import { TreeSitterParserManager } from './TreeSitterParserManager';
import { TreeSitterSymbolExtractor } from './TreeSitterSymbolExtractor';
import { TreeSitterAstCache } from './TreeSitterAstCache';

const GRAMMAR_DIR = path.join(__dirname, '..', '..', '..', 'tree-sitter-grammars');

function createExtractor(cache?: TreeSitterAstCache): TreeSitterSymbolExtractor {
  const parserManager = new TreeSitterParserManager({ grammarDir: GRAMMAR_DIR });
  return new TreeSitterSymbolExtractor({ parserManager, astCache: cache });
}

describe('TreeSitterSymbolExtractor', () => {
  afterEach(async () => {
    // هر test extractor خودش را dispose می‌کند
  });

  it('should be available for typescript and javascript', async () => {
    const extractor = createExtractor();
    expect(await extractor.isAvailable('typescript')).toBe(true);
    expect(await extractor.isAvailable('javascript')).toBe(true);
    expect(await extractor.isAvailable('typescriptreact')).toBe(true);
    expect(await extractor.isAvailable('javascriptreact')).toBe(true);
    // Python/Ruby حالا گرامر دارند؛ zig ندارد.
    expect(await extractor.isAvailable('zig')).toBe(false);
    expect(await extractor.isAvailable('ruby')).toBe(true);
    expect(await extractor.isAvailable('python')).toBe(true);
    await extractor.dispose();
  });

  it('should extract TypeScript class and method', async () => {
    const content = `
class UserService {
  findById(id: number): User {
    return null as any;
  }
}
`;
    const extractor = createExtractor();
    const result = await extractor.extract('f1', 'src/UserService.ts', content, 'typescript');
    await extractor.dispose();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const names = result.value.symbols.map(s => s.name);
    expect(names).toContain('UserService');
    expect(names).toContain('findById');

    const classSymbol = result.value.symbols.find(s => s.name === 'UserService');
    const methodSymbol = result.value.symbols.find(s => s.name === 'findById');

    expect(classSymbol?.kind).toBe('class');
    expect(methodSymbol?.kind).toBe('method');
    expect(methodSymbol?.parentId).toBe(classSymbol?.id);
  });

  it('should extract parameters and signature', async () => {
    const content = `
export function greet(name: string, age?: number): string {
  return \`Hello \${name}\`;
}
`;
    const extractor = createExtractor();
    const result = await extractor.extract('f1', 'src/greet.ts', content, 'typescript');
    await extractor.dispose();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const fn = result.value.symbols.find(s => s.name === 'greet');
    expect(fn).toBeDefined();
    expect(fn?.parameters).toHaveLength(2);
    expect(fn?.parameters![0]).toMatchObject({ name: 'name', type: 'string' });
    expect(fn?.parameters![1]).toMatchObject({ name: 'age', type: 'number', optional: true });
    expect(fn?.signature).toBe('greet(name: string, age?: number): string');
    expect(fn?.returnType).toBe('string');
    expect(fn?.exported).toBe(true);
  });

  it('should detect visibility modifiers', async () => {
    const content = `
class User {
  public publicMethod() {}
  private privateMethod() {}
  protected protectedMethod() {}
  #privateField = 0;
}
`;
    const extractor = createExtractor();
    const result = await extractor.extract('f1', 'src/User.ts', content, 'typescript');
    await extractor.dispose();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.symbols.find(s => s.name === 'publicMethod')?.visibility).toBe('public');
    expect(result.value.symbols.find(s => s.name === 'privateMethod')?.visibility).toBe('private');
    expect(result.value.symbols.find(s => s.name === 'protectedMethod')?.visibility).toBe('protected');
    expect(result.value.symbols.find(s => s.name === '#privateField')?.visibility).toBe('private');
  });

  it('should extract JavaScript functions', async () => {
    const content = `
function add(a, b) {
  return a + b;
}

const multiply = (x, y) => x * y;
`;
    const extractor = createExtractor();
    const result = await extractor.extract('f1', 'src/math.js', content, 'javascript');
    await extractor.dispose();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const names = result.value.symbols.map(s => s.name);
    expect(names).toContain('add');
    expect(names).toContain('multiply');

    const add = result.value.symbols.find(s => s.name === 'add');
    expect(add?.kind).toBe('function');
    expect(add?.parameters).toHaveLength(2);
  });

  it('should extract interface and type alias', async () => {
    const content = `
interface User {
  id: number;
  name: string;
}

type UserId = string | number;
`;
    const extractor = createExtractor();
    const result = await extractor.extract('f1', 'src/types.ts', content, 'typescript');
    await extractor.dispose();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const names = result.value.symbols.map(s => s.name);
    expect(names).toContain('User');
    expect(names).toContain('UserId');

    expect(result.value.symbols.find(s => s.name === 'User')?.kind).toBe('interface');
    expect(result.value.symbols.find(s => s.name === 'UserId')?.kind).toBe('type-alias');
  });

  it('should extract class inheritance', async () => {
    const content = `
class Animal {}
class Dog extends Animal implements Pet, Walkable {}
`;
    const extractor = createExtractor();
    const result = await extractor.extract('f1', 'src/animals.ts', content, 'typescript');
    await extractor.dispose();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const dog = result.value.symbols.find(s => s.name === 'Dog');
    expect(dog?.extends).toContain('Animal');
    expect(dog?.implements).toContain('Pet');
    expect(dog?.implements).toContain('Walkable');
  });

  it('should extract documentation comments', async () => {
    const content = `
/**
 * Service for user operations.
 */
class UserService {
  /**
   * Find user by id.
   */
  findById(id: number): User {
    return null as any;
  }
}
`;
    const extractor = createExtractor();
    const result = await extractor.extract('f1', 'src/UserService.ts', content, 'typescript');
    await extractor.dispose();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const classSymbol = result.value.symbols.find(s => s.name === 'UserService');
    const methodSymbol = result.value.symbols.find(s => s.name === 'findById');

    expect(classSymbol?.documentation).toContain('Service for user operations');
    expect(methodSymbol?.documentation).toContain('Find user by id');
  });

  it('should return partial=true on syntax errors', async () => {
    const content = `
class User {
  findById(id: number): User {
    return null as any
  // missing brace
}
`;
    const extractor = createExtractor();
    const result = await extractor.extract('f1', 'src/broken.ts', content, 'typescript');
    await extractor.dispose();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.partial).toBe(true);
    expect(result.value.warnings.length).toBeGreaterThan(0);
  });

  it('should reuse cached trees', async () => {
    const content = `function foo() {}`;
    const cache = new TreeSitterAstCache();
    const extractor = createExtractor(cache);

    const result1 = await extractor.extract('f1', 'src/foo.ts', content, 'typescript');
    expect(result1.ok).toBe(true);
    expect(cache.size()).toBe(1);

    const result2 = await extractor.extract('f1', 'src/foo.ts', content, 'typescript');
    expect(result2.ok).toBe(true);
    expect(cache.size()).toBe(1);

    await extractor.dispose();
  });
});
