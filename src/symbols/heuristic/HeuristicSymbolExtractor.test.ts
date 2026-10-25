import { HeuristicSymbolExtractor } from './HeuristicSymbolExtractor';

const extractor = new HeuristicSymbolExtractor();

describe('HeuristicSymbolExtractor', () => {
  it('should extract Python functions and classes', async () => {
    const content = `
class UserService:
    def get_user(self, id):
        return id

async def fetch_users():
    return []
`;
    const result = await extractor.extract('f1', 'src/service.py', content, 'python');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const symbols = result.value.symbols;
    expect(symbols.map(s => s.name)).toContain('UserService');
    expect(symbols.map(s => s.name)).toContain('get_user');
    expect(symbols.map(s => s.name)).toContain('fetch_users');
  });

  it('should set parentId for nested Python methods', async () => {
    const content = `
class UserService:
    def get_user(self, user_id):
        return user_id
`;
    const result = await extractor.extract('f1', 'src/service.py', content, 'python');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const classSymbol = result.value.symbols.find(s => s.name === 'UserService');
    const methodSymbol = result.value.symbols.find(s => s.name === 'get_user');

    expect(classSymbol).toBeDefined();
    expect(methodSymbol).toBeDefined();
    expect(methodSymbol!.parentId).toBe(classSymbol!.id);
    expect(methodSymbol!.kind).toBe('method');
  });

  it('should extract Python docstrings as documentation', async () => {
    const content = `
class UserService:
    """Service for user operations."""

    def get_user(self, user_id):
        """Fetch a user by id."""
        return user_id
`;
    const result = await extractor.extract('f1', 'src/service.py', content, 'python');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const classSymbol = result.value.symbols.find(s => s.name === 'UserService');
    const methodSymbol = result.value.symbols.find(s => s.name === 'get_user');

    expect(classSymbol?.documentation).toContain('Service for user operations');
    expect(methodSymbol?.documentation).toContain('Fetch a user by id');
  });

  it('should extract Python parameters and signature', async () => {
    const content = `
def process(name: str, age: int = 18, *args) -> bool:
    return True
`;
    const result = await extractor.extract('f1', 'src/util.py', content, 'python');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const fn = result.value.symbols.find(s => s.name === 'process');
    expect(fn).toBeDefined();
    expect(fn!.parameters).toHaveLength(3);
    expect(fn!.parameters![0]).toMatchObject({ name: 'name', type: 'str', optional: false, rest: false });
    expect(fn!.parameters![1]).toMatchObject({ name: 'age', type: 'int', optional: true, defaultValue: '18', rest: false });
    expect(fn!.parameters![2]).toMatchObject({ name: 'args', optional: false, rest: true });
    expect(fn!.signature).toContain('process(name: str, age: int = 18, ...args)');
  });

  it('should detect Python visibility from naming convention', async () => {
    const content = `
class User:
    def public_method(self):
        pass

    def _private_method(self):
        pass

    def __dunder_method__(self):
        pass
`;
    const result = await extractor.extract('f1', 'src/user.py', content, 'python');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const publicMethod = result.value.symbols.find(s => s.name === 'public_method');
    const privateMethod = result.value.symbols.find(s => s.name === '_private_method');
    const dunderMethod = result.value.symbols.find(s => s.name === '__dunder_method__');

    expect(publicMethod?.visibility).toBe('public');
    expect(privateMethod?.visibility).toBe('private');
    expect(dunderMethod?.visibility).toBe('public');
  });

  it('should extract Go functions', async () => {
    const content = `
func Add(a, b int) int { return a + b }
func (s *Server) Handle() {}
`;
    const result = await extractor.extract('f1', 'src/main.go', content, 'go');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.symbols.map(s => s.name)).toContain('Add');
    expect(result.value.symbols.map(s => s.name)).toContain('Handle');
  });

  it('should extract Go interface methods', async () => {
    const content = `
type Reader interface {
    Read(p []byte) (n int, err error)
}
`;
    const result = await extractor.extract('f1', 'src/io.go', content, 'go');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const reader = result.value.symbols.find(s => s.name === 'Reader');
    const readMethod = result.value.symbols.find(s => s.name === 'Read');

    expect(reader?.kind).toBe('interface');
    expect(readMethod?.parentId).toBe(reader?.id);
    expect(readMethod?.kind).toBe('method');
  });

  it('should detect Go visibility by capitalization', async () => {
    const content = `
func PublicFunc() {}
func privateFunc() {}
`;
    const result = await extractor.extract('f1', 'src/vis.go', content, 'go');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const publicFn = result.value.symbols.find(s => s.name === 'PublicFunc');
    const privateFn = result.value.symbols.find(s => s.name === 'privateFunc');

    expect(publicFn?.visibility).toBe('public');
    expect(privateFn?.visibility).toBe('private');
  });

  it('should extract PHP functions and classes', async () => {
    const content = `
<?php
class Controller {
    public function index() {}
}
function helper() {}
`;
    const result = await extractor.extract('f1', 'src/app.php', content, 'php');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.symbols.map(s => s.name)).toContain('Controller');
    expect(result.value.symbols.map(s => s.name)).toContain('index');
    expect(result.value.symbols.map(s => s.name)).toContain('helper');
  });

  it('should detect PHP visibility modifiers', async () => {
    const content = `
<?php
class User {
    public function publicMethod() {}
    private function privateMethod() {}
    protected function protectedMethod() {}
}
`;
    const result = await extractor.extract('f1', 'src/user.php', content, 'php');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.symbols.find(s => s.name === 'publicMethod')?.visibility).toBe('public');
    expect(result.value.symbols.find(s => s.name === 'privateMethod')?.visibility).toBe('private');
    expect(result.value.symbols.find(s => s.name === 'protectedMethod')?.visibility).toBe('protected');
  });

  it('should extract Bash functions', async () => {
    const content = `
#!/bin/bash
function greet() {
    echo "hello"
}
backup() {
    echo "backup"
}
`;
    const result = await extractor.extract('f1', 'scripts/deploy.sh', content, 'shellscript');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.symbols.map(s => s.name)).toContain('greet');
    expect(result.value.symbols.map(s => s.name)).toContain('backup');
  });

  /*
  | این تست تا فاز ۱۵ می‌گفت دو تعریف هم‌نام باید *یک* symbol بدهند —
  | یعنی رفتار SE-SYM-18 را به‌عنوان قرارداد ثبت کرده بود. آن رفتار
  | «حذف تکراری» نبود، حذف داده بود: دومین تعریف واقعاً وجود دارد،
  | خط دیگری دارد و ممکن است بدنهٔ کاملاً متفاوتی داشته باشد. حالا
  | خواسته برعکس شده و تست هم برعکس شد.
  */
  it('keeps both definitions when a name is defined twice', async () => {
    const content = `
def helper():
    pass

def helper():
    return 1
`;
    const result = await extractor.extract('f1', 'src/util.py', content, 'python');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const helperSymbols = result.value.symbols.filter(s => s.name === 'helper');
    expect(helperSymbols).toHaveLength(2);
    expect(helperSymbols[0].line).not.toBe(helperSymbols[1].line);
    expect(helperSymbols[0].id).not.toBe(helperSymbols[1].id);
  });
});

/*
| SE-DATA-01 — تا فاز ۱۴ همهٔ این‌ها `endLine === line` می‌دادند.
| بازهٔ درست پیش‌نیاز سه چیز است: `findSymbolAtLine` برای پیدا کردن
| caller، chunk معنادار در بردارها، و برش بدنهٔ symbol.
*/
describe('endLine spans the real block', () => {

  const extract = async (content: string, language: string, path = 'a.ts') => {
    const result = await new HeuristicSymbolExtractor()
      .extract('f1', path, content, language);
    if (!result.ok) throw result.error;
    return result.value.symbols;
  };

  it('covers a typescript function body', async () => {
    const symbols = await extract(`export function greet(name: string): string {
  const greeting = 'hello';
  return greeting + name;
}
`, 'typescript');

    expect(symbols[0]).toMatchObject({ name: 'greet', line: 1, endLine: 4 });
  });

  it('covers a python function body by indentation', async () => {
    const symbols = await extract(`def greet(name):
    prefix = 'hello '
    return prefix + name

def other():
    pass
`, 'python', 'a.py');

    expect(symbols.find(s => s.name === 'greet')).toMatchObject({ line: 1, endLine: 3 });
    expect(symbols.find(s => s.name === 'other')).toMatchObject({ line: 5, endLine: 6 });
  });

  it('covers a go function containing a struct literal', async () => {
    const symbols = await extract(`package main

func Handle(x int) error {
	cfg := Config{Name: "a"}
	_ = cfg
	return nil
}
`, 'go', 'a.go');

    expect(symbols.find(s => s.name === 'Handle')).toMatchObject({ line: 3, endLine: 7 });
  });

  it('keeps a genuinely one-line function on one line', async () => {
    const symbols = await extract('export function noop(): void {}\n', 'typescript');

    expect(symbols[0]).toMatchObject({ line: 1, endLine: 1 });
  });

  it('is not fooled by a brace inside a string', async () => {
    const symbols = await extract(`export function f(): void {
  const s = "} not the end {";
  return;
}
`, 'typescript');

    expect(symbols[0].endLine).toBe(4);
  });

  it('never ends before it starts, on any symbol', async () => {
    const symbols = await extract(`class A {
  m() { return 1; }
}
function after() {
  return 2;
}
`, 'typescript');

    for (const symbol of symbols) {
      expect(symbol.endLine).toBeGreaterThanOrEqual(symbol.line);
    }
  });
});

/*
| فاز ۱۶ — کیفیت استخراج‌گرهای heuristic.
*/
describe('signatures and literals', () => {

  const extract = async (content: string, language: string, path: string) => {
    const result = await new HeuristicSymbolExtractor().extract('f1', path, content, language);
    if (!result.ok) throw result.error;
    return result.value.symbols;
  };

  /*
  | SE-SYM-19 — الگوی قبلی `/\(([^)]*)\)/` بود و فقط یک خط را می‌دید.
  | امضای چندخطی در Python و Go و Java قاعده است.
  */
  it('reads parameters from a multi-line python signature', async () => {
    const symbols = await extract(`def long_one(
    alpha,
    beta,
    gamma,
):
    return 1
`, 'python', 'a.py');

    expect(symbols[0].parameters?.map(p => p.name)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('reads parameters from a multi-line go signature', async () => {
    const symbols = await extract(`func Handle(
	ctx context.Context,
	req *Request,
) error {
	return nil
}
`, 'go', 'a.go');

    expect(symbols[0].parameters?.map(p => p.name)).toEqual(['ctx', 'req']);
  });

  /*
  | SE-SYM-29 — Go برعکس Java است: نام اول می‌آید. کد قبلی آخرین توکن
  | را نام می‌گرفت، پس هر پارامتر Go وارونه ثبت می‌شد.
  */
  it('reads go parameters in the right order, name first', async () => {
    const symbols = await extract('func Handle(ctx context.Context, req *Request) error {\n\treturn nil\n}\n', 'go', 'a.go');

    expect(symbols[0].parameters).toEqual([
      expect.objectContaining({ name: 'ctx', type: 'context.Context' }),
      expect.objectContaining({ name: 'req', type: '*Request' }),
    ]);
  });

  it('handles a grouped go parameter list', async () => {
    const symbols = await extract('func Add(a, b int) int {\n\treturn a + b\n}\n', 'go', 'a.go');

    expect(symbols[0].parameters?.map(p => p.name)).toEqual(['a', 'b']);
  });

  /*
  | SE-SYM-20 — الگوها روی متن پوشانده‌شده اجرا می‌شوند.
  */
  it('does not extract a function that only exists in a comment', async () => {
    const symbols = await extract(`// export function commented() {}
export function real() {}
`, 'typescript', 'a.ts');

    expect(symbols.map(s => s.name)).toEqual(['real']);
  });

  it('does not extract a function that only exists in a string', async () => {
    const symbols = await extract(`const template = "export function fake() {}";
export function real() {}
`, 'typescript', 'a.ts');

    expect(symbols.map(s => s.name)).toEqual(['real']);
  });

  it('keeps the line number right after masking', async () => {
    const symbols = await extract(`/* a long
   block comment
   spanning lines */
export function real() {}
`, 'typescript', 'a.ts');

    expect(symbols[0]).toMatchObject({ name: 'real', line: 4 });
  });

  /*
  | SE-SYM-23 — یک فایل با تورفتگی tab. مقایسهٔ طول خام، tab را با یک
  | space برابر می‌گرفت و والد اشتباه پیدا می‌شد.
  */
  it('finds the parent of a tab-indented python method', async () => {
    const symbols = await extract('class A:\n\tdef m(self):\n\t\treturn 1\n', 'python', 'a.py');

    const parent = symbols.find(s => s.name === 'A');
    const method = symbols.find(s => s.name === 'm');

    expect(method?.parentId).toBe(parent?.id);
    expect(method?.kind).toBe('method');
  });
});
