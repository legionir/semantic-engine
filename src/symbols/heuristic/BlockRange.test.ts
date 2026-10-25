/**
 * تشخیص پایان بلوک — SE-DATA-01.
 *
 * همهٔ استخراج‌گرهای heuristic `endLine: line` می‌گذاشتند. این یک باگ
 * ساده نیست، ریشهٔ یک زنجیره است:
 *
 *   - `SymbolIndex.findSymbolAtLine` بر پایهٔ بازهٔ خط کار می‌کند، پس
 *     برای این زبان‌ها هرگز caller پیدا نمی‌کرد و همهٔ یال‌های call graph
 *     به `file.id` سقوط می‌کردند.
 *   - `VectorIndexer` هر chunk را تک‌خطی می‌ساخت.
 *   - هر مصرف‌کننده‌ای که بخواهد بدنهٔ تابع را برش بزند، صفر خط می‌گیرد.
 *
 * نکتهٔ اصلی این تست‌ها: شمارش آکولاد بدون آگاهی از رشته و کامنت،
 * روی کد واقعی می‌شکند. یک `{` داخل یک رشته کافی است تا بقیهٔ فایل
 * جابه‌جا شود.
 */

import { findBlockEnd, blockStyleFor } from './BlockRange';

/** کمک‌کننده: متن را به خطوط می‌شکند و پایان بلوکِ خط داده‌شده را می‌دهد. */
function endOf(source: string, startLine = 1, language = 'typescript'): number {
  return findBlockEnd(source.split('\n'), startLine, blockStyleFor(language));
}

describe('blockStyleFor', () => {

  it.each([
    'typescript', 'javascript', 'typescriptreact', 'go', 'php',
    'java', 'rust', 'csharp', 'c', 'cpp', 'swift', 'kotlin',
  ])('treats %s as brace-delimited', language => {
    expect(blockStyleFor(language)).toBe('brace');
  });

  it('treats python as indentation-delimited', () => {
    expect(blockStyleFor('python')).toBe('indent');
  });

  it('treats ruby as keyword-delimited', () => {
    expect(blockStyleFor('ruby')).toBe('ruby');
  });

  it('falls back to braces for anything unknown', () => {
    expect(blockStyleFor('brainfuck')).toBe('brace');
  });
});

describe('brace-delimited blocks', () => {

  it('finds the closing brace of a simple function', () => {
    expect(endOf(`function greet() {
  return 'hi';
}`)).toBe(3);
  });

  it('handles nested blocks', () => {
    expect(endOf(`function outer() {
  if (x) {
    while (y) {
      z();
    }
  }
  return 1;
}`)).toBe(8);
  });

  it('finds the end of a class', () => {
    expect(endOf(`class A {
  method() {
    return 1;
  }
}`)).toBe(5);
  });

  it('finds the end of an inner method, not the outer class', () => {
    expect(endOf(`class A {
  method() {
    return 1;
  }
  other() {}
}`, 2)).toBe(4);
  });

  it('handles a signature spread over several lines', () => {
    expect(endOf(`function longOne(
  a: string,
  b: number
): void {
  doThing();
}`)).toBe(6);
  });

  it('handles a body opened and closed on one line', () => {
    expect(endOf('function tiny() { return 1; }')).toBe(1);
  });

  /*
  | یک `{` داخل رشته، بدون آگاهی از نقل‌قول، عمق را بالا می‌برد و از
  | آن به بعد هیچ پایانی درست پیدا نمی‌شود. این تنها دلیلی است که
  | شمارش ساده کافی نیست.
  */
  it('ignores braces inside a string literal', () => {
    expect(endOf(`function f() {
  const s = "a { b";
  const t = 'c } d';
}`)).toBe(4);
  });

  it('ignores braces inside a template literal', () => {
    expect(endOf(`function f() {
  const s = \`a { b } c\`;
}`)).toBe(3);
  });

  it('handles an escaped quote inside a string', () => {
    expect(endOf(`function f() {
  const s = "he said \\" { ";
}`)).toBe(3);
  });

  it('ignores braces inside a line comment', () => {
    expect(endOf(`function f() {
  // closing } here
  return 1;
}`)).toBe(4);
  });

  it('ignores braces inside a block comment', () => {
    expect(endOf(`function f() {
  /* }
     { */
  return 1;
}`)).toBe(5);
  });

  it('ignores a brace inside a character literal', () => {
    expect(endOf(`int f(void) {
  char c = '}';
  return 0;
}`, 1, 'c')).toBe(4);
  });

  /*
  | اعلان بدون بدنه واقعاً تک‌خطی است. اگر تابع تا اولین آکولادِ بعدی
  | جلو برود، امضای بعدی را می‌بلعد.
  */
  it('treats a declaration with no body as one line', () => {
    expect(endOf(`void doThing(int a);
void other(void) {
  return;
}`, 1, 'c')).toBe(1);
  });

  it('treats an interface method as one line', () => {
    expect(endOf(`interface A {
  method(): void;
  other(): string;
}`, 2)).toBe(2);
  });

  it('treats an abstract method as one line', () => {
    expect(endOf(`abstract class A {
  abstract run(): void;
}`, 2)).toBe(2);
  });

  it('treats an expression-bodied arrow as one line', () => {
    expect(endOf('const double = (n: number) => n * 2;')).toBe(1);
  });

  it('finds the end of a block-bodied arrow', () => {
    expect(endOf(`const run = (n: number) => {
  return n * 2;
};`)).toBe(3);
  });

  /*
  | یک فایل بریده یا کد ناقص نباید باعث شود شمارنده تا ابد جلو برود و
  | یک عدد ساختگی برگرداند. بهترین حدس، پایان فایل است.
  */
  it('stops at the end of the file when a block is never closed', () => {
    expect(endOf(`function broken() {
  if (x) {
    y();`)).toBe(3);
  });

  it('does not search forever for an opening brace', () => {
    const source = ['const x = 1;', ...Array.from({ length: 200 }, () => '// filler'), 'function f() {', '}'];

    expect(findBlockEnd(source, 1, 'brace')).toBe(1);
  });

  /*
  | خطی که با `#` شروع می‌شود کلاً کنار می‌رود: هم کامنت شل/Python/PHP
  | و هم دستور پیش‌پردازندهٔ C. مورد زیر واقعی است — بدون این قاعده،
  | آکولاد بی‌جفتِ داخل `#define` تابع بعدی را هم به این symbol
  | می‌چسباند (اندازه‌گیری‌شده: ۷ به‌جای ۴).
  */
  it('ignores an unbalanced brace inside a preprocessor directive', () => {
    expect(endOf(`void f(void) {
#define BEGIN_SCOPE {
  return;
}
void g(void) {
  return;
}`, 1, 'c')).toBe(4);
  });

  it('ignores a balanced brace inside a preprocessor directive', () => {
    expect(endOf(`void f(void) {
#define PAIR {1,2}
  return;
}`, 1, 'c')).toBe(4);
  });

  it('does not treat a JavaScript private field as a comment', () => {
    expect(endOf(`class A {
  #count = 0;
  m() { return this.#count; }
}`)).toBe(4);
  });

  it('handles a go function with a struct literal inside', () => {
    expect(endOf(`func Handle(w http.ResponseWriter) {
	x := Config{Name: "a"}
	_ = x
}`, 1, 'go')).toBe(4);
  });

  it('handles php with a variable interpolation brace', () => {
    expect(endOf(`function render($name) {
    echo "Hello {$name}";
}`, 1, 'php')).toBe(3);
  });
});

describe('indentation-delimited blocks (python)', () => {

  const py = (source: string, line = 1) => endOf(source, line, 'python');

  it('finds the end of a function body', () => {
    expect(py(`def greet():
    print('hi')
    return 1
`)).toBe(3);
  });

  it('stops before a sibling at the same indentation', () => {
    expect(py(`def first():
    return 1

def second():
    return 2
`)).toBe(2);
  });

  it('includes blank lines inside the body but not the trailing ones', () => {
    expect(py(`def f():
    a = 1

    b = 2


def g():
    pass
`)).toBe(4);
  });

  it('finds the end of a class including its methods', () => {
    expect(py(`class A:
    def m(self):
        return 1

    def n(self):
        return 2
`)).toBe(6);
  });

  it('finds the end of a method inside a class', () => {
    expect(py(`class A:
    def m(self):
        return 1

    def n(self):
        return 2
`, 2)).toBe(3);
  });

  it('handles a one-line body after the colon', () => {
    expect(py(`def f(): return 1
def g(): return 2
`)).toBe(1);
  });

  it('handles a signature spread over several lines', () => {
    expect(py(`def long(
    a,
    b,
):
    return a + b
`)).toBe(5);
  });

  it('handles a decorated function', () => {
    expect(py(`@decorator
def f():
    return 1
`, 2)).toBe(3);
  });

  it('treats a comment at body indentation as part of the body', () => {
    expect(py(`def f():
    # explanation
    return 1
`)).toBe(3);
  });

  /*
  | فایل‌های واقعی گاهی tab دارند و گاهی space. مقایسهٔ خام طول رشته،
  | یک tab را با یک space برابر می‌گیرد و بدنه را همان‌جا می‌برد.
  */
  it('treats a tab as deeper indentation than the def', () => {
    expect(py('def f():\n\treturn 1\n')).toBe(2);
  });

  it('reaches the end of the file when the body runs to it', () => {
    expect(py(`def f():
    a = 1
    b = 2`)).toBe(3);
  });
});

describe('keyword-delimited blocks (ruby)', () => {

  const rb = (source: string, line = 1) => endOf(source, line, 'ruby');

  it('finds the matching end of a method', () => {
    expect(rb(`def greet
  puts 'hi'
end`)).toBe(3);
  });

  it('finds the matching end of a class with methods', () => {
    expect(rb(`class A
  def m
    1
  end
end`)).toBe(5);
  });

  it('finds the end of an inner method, not the class', () => {
    expect(rb(`class A
  def m
    1
  end
end`, 2)).toBe(4);
  });

  it('counts a nested if', () => {
    expect(rb(`def f
  if x
    1
  end
end`)).toBe(5);
  });

  /*
  | `if` پسوندی بلوک باز نمی‌کند. شمردنش یعنی هر `end` بعدی یکی
  | جابه‌جا شود و پایان متد اشتباه دربیاید.
  */
  it('does not count a modifier if', () => {
    expect(rb(`def f
  return 1 if x
end`)).toBe(3);
  });

  it('counts a do block', () => {
    expect(rb(`def f
  items.each do |i|
    puts i
  end
end`)).toBe(5);
  });

  it('ignores the word end inside a string', () => {
    expect(rb(`def f
  puts "the end"
end`)).toBe(3);
  });

  it('ignores a keyword inside a comment', () => {
    expect(rb(`def f
  # if this were counted
  1
end`)).toBe(4);
  });

  it('treats an endless method as one line', () => {
    expect(rb(`def square(x) = x * x
def cube(x) = x ** 3`)).toBe(1);
  });
});

describe('matched delimiter search', () => {

  it('finds the end of a json object value', () => {
    const source = `{
  "a": {
    "b": 1
  },
  "c": 2
}`;
    expect(findBlockEnd(source.split('\n'), 2, 'brace')).toBe(4);
  });

  it('finds the end of a css rule', () => {
    const source = `.a {
  color: red;
}
.b { color: blue; }`;
    expect(findBlockEnd(source.split('\n'), 1, 'brace')).toBe(3);
    expect(findBlockEnd(source.split('\n'), 4, 'brace')).toBe(4);
  });
});
