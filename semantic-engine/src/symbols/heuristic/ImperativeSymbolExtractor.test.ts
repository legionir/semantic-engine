import { ImperativeSymbolExtractor } from './ImperativeSymbolExtractor';

const extractor = new ImperativeSymbolExtractor();

describe('ImperativeSymbolExtractor', () => {
  it('should extract Java classes and methods', async () => {
    const content = `
public class UserService {
    public User findById(int id) {
        return null;
    }
}

interface Repository {
    void save(User user);
}
`;
    const result = await extractor.extract('f1', 'src/UserService.java', content, 'java');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const names = result.value.symbols.map(s => s.name);
    expect(names).toContain('UserService');
    expect(names).toContain('findById');
    expect(names).toContain('Repository');
  });

  it('should set parentId for nested Java methods', async () => {
    const content = `
public class UserService {
    public User findById(int id) {
        return null;
    }
}
`;
    const result = await extractor.extract('f1', 'src/UserService.java', content, 'java');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const classSymbol = result.value.symbols.find(s => s.name === 'UserService');
    const methodSymbol = result.value.symbols.find(s => s.name === 'findById');

    expect(classSymbol).toBeDefined();
    expect(methodSymbol).toBeDefined();
    expect(methodSymbol!.parentId).toBe(classSymbol!.id);
    expect(methodSymbol!.kind).toBe('method');
  });

  it('should extract Java documentation comments', async () => {
    const content = `
/**
 * Service for user operations.
 */
public class UserService {
    /**
     * Find user by id.
     */
    public User findById(int id) {
        return null;
    }
}
`;
    const result = await extractor.extract('f1', 'src/UserService.java', content, 'java');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const classSymbol = result.value.symbols.find(s => s.name === 'UserService');
    const methodSymbol = result.value.symbols.find(s => s.name === 'findById');

    expect(classSymbol?.documentation).toContain('Service for user operations');
    expect(methodSymbol?.documentation).toContain('Find user by id');
  });

  it('should extract Java parameters and signature', async () => {
    const content = `
public class UserService {
    public User findById(int id, boolean active) {
        return null;
    }
}
`;
    const result = await extractor.extract('f1', 'src/UserService.java', content, 'java');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const method = result.value.symbols.find(s => s.name === 'findById');
    expect(method?.parameters).toHaveLength(2);
    expect(method?.parameters![0]).toMatchObject({ name: 'id', type: 'int' });
    expect(method?.parameters![1]).toMatchObject({ name: 'active', type: 'boolean' });
    expect(method?.signature).toBe('findById(int id, boolean active)');
  });

  it('should detect Java visibility', async () => {
    const content = `
public class User {
    public void publicMethod() {}
    private void privateMethod() {}
    protected void protectedMethod() {}
    void packageMethod() {}
}
`;
    const result = await extractor.extract('f1', 'src/User.java', content, 'java');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.symbols.find(s => s.name === 'publicMethod')?.visibility).toBe('public');
    expect(result.value.symbols.find(s => s.name === 'privateMethod')?.visibility).toBe('private');
    expect(result.value.symbols.find(s => s.name === 'protectedMethod')?.visibility).toBe('protected');
    expect(result.value.symbols.find(s => s.name === 'packageMethod')?.visibility).toBe('public');
  });

  it('should extract Rust structs, traits, and functions', async () => {
    const content = `
pub struct User {
    name: String,
}

pub trait Greeter {
    fn greet(&self);
}

pub fn hello() {}
`;
    const result = await extractor.extract('f1', 'src/lib.rs', content, 'rust');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const names = result.value.symbols.map(s => s.name);
    expect(names).toContain('User');
    expect(names).toContain('Greeter');
    expect(names).toContain('hello');
  });

  it('should detect Rust visibility', async () => {
    const content = `
pub fn public_fn() {}
fn private_fn() {}
`;
    const result = await extractor.extract('f1', 'src/lib.rs', content, 'rust');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.symbols.find(s => s.name === 'public_fn')?.visibility).toBe('public');
    expect(result.value.symbols.find(s => s.name === 'private_fn')?.visibility).toBe('private');
  });

  it('should extract C# classes and methods', async () => {
    const content = `
public class Program
{
    public static void Main(string[] args)
    {
        Console.WriteLine("Hello");
    }
}
`;
    const result = await extractor.extract('f1', 'src/Program.cs', content, 'csharp');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const names = result.value.symbols.map(s => s.name);
    expect(names).toContain('Program');
    expect(names).toContain('Main');
  });

  it('should extract C# parameters and signature', async () => {
    const result = await extractor.extract('f1', 'src/Program.cs', `
public class Program
{
    public static void Main(string[] args)
    {
    }
}
`, 'csharp');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const main = result.value.symbols.find(s => s.name === 'Main');
    expect(main?.parameters).toHaveLength(1);
    expect(main?.parameters![0]).toMatchObject({ name: 'args', type: 'string[]' });
    expect(main?.signature).toBe('Main(string[] args)');
  });

  it('should extract C++ classes and functions', async () => {
    const content = `
class Calculator {
public:
    int add(int a, int b);
};

namespace math {
    int multiply(int a, int b);
}
`;
    const result = await extractor.extract('f1', 'src/calc.cpp', content, 'cpp');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const names = result.value.symbols.map(s => s.name);
    expect(names).toContain('Calculator');
    expect(names).toContain('math');
  });

  it('should extract Ruby classes, modules, and methods', async () => {
    const content = `
module Helpers
  class Formatter
    def format(name)
      name.upcase
    end
  end
end
`;
    const result = await extractor.extract('f1', 'src/formatter.rb', content, 'ruby');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const names = result.value.symbols.map(s => s.name);
    expect(names).toContain('Helpers');
    expect(names).toContain('Formatter');
    expect(names).toContain('format');
  });

  it('should set nested Ruby parentIds', async () => {
    const result = await extractor.extract('f1', 'src/formatter.rb', `
module Helpers
  class Formatter
    def format(name)
    end
  end
end
`, 'ruby');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const moduleSymbol = result.value.symbols.find(s => s.name === 'Helpers');
    const classSymbol = result.value.symbols.find(s => s.name === 'Formatter');
    const methodSymbol = result.value.symbols.find(s => s.name === 'format');

    expect(classSymbol?.parentId).toBe(moduleSymbol?.id);
    expect(methodSymbol?.parentId).toBe(classSymbol?.id);
  });

  it('should extract Swift classes and functions', async () => {
    const content = `
public class ViewModel {
    func load() {}
}

struct Config {
    let value: Int
}
`;
    const result = await extractor.extract('f1', 'src/ViewModel.swift', content, 'swift');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const names = result.value.symbols.map(s => s.name);
    expect(names).toContain('ViewModel');
    expect(names).toContain('load');
    expect(names).toContain('Config');
  });

  it('should extract Kotlin classes and functions', async () => {
    const content = `
class UserRepository {
    fun findById(id: Int): User? {
        return null
    }
}

object Constants {
    val VERSION = "1.0"
}
`;
    const result = await extractor.extract('f1', 'src/UserRepository.kt', content, 'kotlin');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const names = result.value.symbols.map(s => s.name);
    expect(names).toContain('UserRepository');
    expect(names).toContain('findById');
    expect(names).toContain('Constants');
  });

  it('should extract Kotlin parameters and signature', async () => {
    const result = await extractor.extract('f1', 'src/UserRepository.kt', `
class UserRepository {
    fun findById(id: Int, active: Boolean = true): User? {
        return null
    }
}
`, 'kotlin');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const method = result.value.symbols.find(s => s.name === 'findById');
    expect(method?.parameters).toHaveLength(2);
    expect(method?.parameters![0]).toMatchObject({ name: 'id', type: 'Int' });
    expect(method?.parameters![1]).toMatchObject({ name: 'active', type: 'Boolean', optional: true, defaultValue: 'true' });
  });
});

/*
| SE-SYM-18 و SE-DATA-06 — هویت symbol.
|
| کلید dedupe قبلاً فقط `مسیر + نام + نوع` بود و روی تصادم `continue`
| می‌شد. روی fixture، ۸ symbol واقعی به همین دلیل بی‌صدا حذف می‌شدند.
*/
describe('symbol identity', () => {

  const extract = async (content: string, language: string, path: string) => {
    const result = await new ImperativeSymbolExtractor().extract('f1', path, content, language);
    if (!result.ok) throw result.error;
    return result.value.symbols;
  };

  const OVERLOADS = `public class Calc {
    public int add(int a, int b) {
        return a + b;
    }

    public double add(double a, double b) {
        return a + b;
    }

    public String add(String a, String b) {
        return a + b;
    }
}
`;

  it('keeps every overload of a method', async () => {
    const adds = (await extract(OVERLOADS, 'java', 'src/Calc.java'))
      .filter(s => s.name === 'add');

    expect(adds).toHaveLength(3);
    expect(new Set(adds.map(s => s.id)).size).toBe(3);
  });

  it('gives each overload its own range', async () => {
    const adds = (await extract(OVERLOADS, 'java', 'src/Calc.java'))
      .filter(s => s.name === 'add');

    expect(adds.map(s => [s.line, s.endLine])).toEqual([[2, 4], [6, 8], [10, 12]]);
  });

  /*
  | معیار پذیرش: افزودن خط در ابتدای فایل نباید هیچ شناسه‌ای را عوض
  | کند. طرح قبلی در تصادم پسوند `:L{line}C{col}` می‌زد، پس یک خط
  | خالی، diff ایندکس را منفجر می‌کرد.
  */
  it('keeps every id when the whole file shifts down', async () => {
    const before = await extract(OVERLOADS, 'java', 'src/Calc.java');
    const after = await extract(`\n\n// a new header\n${OVERLOADS}`, 'java', 'src/Calc.java');

    expect(after.map(s => s.line)).not.toEqual(before.map(s => s.line));
    expect(after.map(s => s.id)).toEqual(before.map(s => s.id));
  });

  it('does not put a line or column into the qualified name', async () => {
    const symbols = await extract(OVERLOADS, 'java', 'src/Calc.java');

    for (const symbol of symbols) {
      expect(symbol.fullyQualifiedName ?? '').not.toMatch(/:L\d+|C\d+/);
    }
  });

  it('gives every symbol a qualified name', async () => {
    const symbols = await extract(OVERLOADS, 'java', 'src/Calc.java');

    expect(symbols.every(s => typeof s.fullyQualifiedName === 'string')).toBe(true);
    expect(symbols[0].fullyQualifiedName).toBe('src/Calc.java::Calc');
  });

  it('separates same-named methods of two types in one file', async () => {
    const symbols = await extract(`class Reader {
    public int run() { return 1; }
}
class Writer {
    public int run() { return 2; }
}
`, 'java', 'src/Two.java');

    const runs = symbols.filter(s => s.name === 'run');
    expect(runs).toHaveLength(2);
    expect(new Set(runs.map(s => s.id)).size).toBe(2);
  });
});

/*
| SE-SYM-20 و SE-SYM-28 — تعریف‌های خیالی در C.
*/
describe('false definitions in C', () => {

  const extract = async (content: string) => {
    const result = await new ImperativeSymbolExtractor().extract('f1', 'a.c', content, 'c');
    if (!result.ok) throw result.error;
    return result.value.symbols.map(s => s.name);
  };

  /*
  | معیار پذیرش فاز ۱۶: «`return foo(x);` در C به‌عنوان تعریف تابع
  | ثبت نشود.» پیش از این `foo` یک symbol می‌شد.
  */
  it('does not record a called function as a definition', async () => {
    expect(await extract('int wrapper(int x) {\n    return foo(x);\n}\n')).toEqual(['wrapper']);
  });

  /*
  | SE-SYM-28 — پیکربندی C برخلاف C++ هیچ فیلتر کلیدواژه‌ای نداشت، پس
  | خودِ `for` و `if` تابع ثبت می‌شدند. روی fixture واقعاً اتفاق افتاده
  | بود.
  */
  it('does not record control keywords as functions', async () => {
    const names = await extract(`void run(void) {
    for (int i = 0; i < 3; i++) {
        if (i) { work(); }
    }
    while (0) { }
    switch (1) { default: break; }
}
`);

    expect(names).toEqual(['run']);
  });

  it('does not record a definition that only exists in a comment', async () => {
    expect(await extract('/* int commented(void) { return 0; } */\nint real(void) {\n    return 1;\n}\n'))
      .toEqual(['real']);
  });

  it('still records a real static function', async () => {
    expect(await extract('static int count_tokens(const char *s) {\n    return 0;\n}\n'))
      .toEqual(['count_tokens']);
  });

  it('still records a declaration', async () => {
    expect(await extract('void do_thing(int a);\n')).toEqual(['do_thing']);
  });
});
