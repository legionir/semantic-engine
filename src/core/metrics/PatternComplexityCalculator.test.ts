/**
 * تست PatternComplexityCalculator برای زبان‌های غیر TS/JS.
 */

import {
  createPythonComplexityCalculator,
} from './PythonComplexityCalculator';
import { createGoComplexityCalculator } from './GoComplexityCalculator';
import { createPhpComplexityCalculator } from './PhpComplexityCalculator';
import { createBashComplexityCalculator } from './BashComplexityCalculator';
import { createJavaComplexityCalculator } from './JavaComplexityCalculator';
import { createRustComplexityCalculator } from './RustComplexityCalculator';
import { createCSharpComplexityCalculator } from './CSharpComplexityCalculator';
import { createCppComplexityCalculator } from './CppComplexityCalculator';
import { createRubyComplexityCalculator } from './RubyComplexityCalculator';
import { createSwiftComplexityCalculator } from './SwiftComplexityCalculator';
import { createKotlinComplexityCalculator } from './KotlinComplexityCalculator';

describe('PatternComplexityCalculator', () => {
  it('should compute Python complexity', () => {
    const calc = createPythonComplexityCalculator();
    const code = `
def analyze(x):
    if x > 0:
        for i in range(x):
            if i % 2 == 0 and i > 5:
                print(i)
    elif x < 0:
        while x < 0:
            x += 1
    else:
        assert False
`;
    // base 1 + if(1) + for(1) + if(1) + and(1) + elif(1) + while(1) + assert(1) = 8
    expect(calc.calculate(code)).toBeGreaterThanOrEqual(7);
  });

  it('should compute Go complexity', () => {
    const calc = createGoComplexityCalculator();
    const code = `
func process(n int) {
    if n > 0 && n < 10 {
        for i := 0; i < n; i++ {
            switch i {
            case 1:
                fmt.Println("one")
            }
        }
    }
}
`;
    // base 1 + if(1) + &&(1) + for(1) + switch(1) + case(1) = 6
    expect(calc.calculate(code)).toBeGreaterThanOrEqual(5);
  });

  it('should compute PHP complexity', () => {
    const calc = createPhpComplexityCalculator();
    const code = `
<?php
function handle($x) {
    if ($x > 0) {
        return 1;
    } elseif ($x < 0) {
        return -1;
    } else {
        return 0;
    }
}
`;
    // base 1 + if + elseif + else = 4
    expect(calc.calculate(code)).toBeGreaterThanOrEqual(4);
  });

  it('should compute Bash complexity', () => {
    const calc = createBashComplexityCalculator();
    const code = `
#!/bin/bash
if [ "$1" == "start" ]; then
    for f in *.txt; do
        echo "$f"
    done
elif [ "$1" == "stop" ]; then
    echo "stop"
fi
`;
    // base 1 + if + for + elif = 4
    expect(calc.calculate(code)).toBeGreaterThanOrEqual(4);
  });

  it('should compute Java complexity', () => {
    const calc = createJavaComplexityCalculator();
    const code = `
public int analyze(int x) {
    if (x > 0 && x < 10) {
        for (int i = 0; i < x; i++) {
            if (i % 2 == 0) return i;
        }
    } else {
        return -1;
    }
    return 0;
}
`;
    expect(calc.calculate(code)).toBeGreaterThanOrEqual(6);
  });

  it('should compute Rust complexity', () => {
    const calc = createRustComplexityCalculator();
    const code = `
fn process(n: i32) -> i32 {
    if n > 0 && n < 10 {
        for i in 0..n {
            match i % 2 {
                0 => return i,
                _ => continue,
            }
        }
    }
    0
}
`;
    expect(calc.calculate(code)).toBeGreaterThanOrEqual(5);
  });

  it('should compute C# complexity', () => {
    const calc = createCSharpComplexityCalculator();
    const code = `
public int Handle(int x)
{
    if (x > 0 && x < 10)
    {
        foreach (var i in Enumerable.Range(0, x))
        {
            if (i % 2 == 0) return i;
        }
    }
    return x ?? 0;
}
`;
    expect(calc.calculate(code)).toBeGreaterThanOrEqual(6);
  });

  it('should compute C++ complexity', () => {
    const calc = createCppComplexityCalculator();
    const code = `
int analyze(int x) {
    if (x > 0 && x < 10) {
        for (int i = 0; i < x; i++) {
            switch (i % 2) {
                case 0: return i;
                default: break;
            }
        }
    }
    return 0;
}
`;
    expect(calc.calculate(code)).toBeGreaterThanOrEqual(6);
  });

  it('should compute Ruby complexity', () => {
    const calc = createRubyComplexityCalculator();
    const code = `
def analyze(x)
  if x > 0 && x < 10
    (0...x).each do |i|
      return i if i % 2 == 0
    end
  elsif x < 0
    nil
  end
end
`;
    expect(calc.calculate(code)).toBeGreaterThanOrEqual(4);
  });

  it('should compute Swift complexity', () => {
    const calc = createSwiftComplexityCalculator();
    const code = `
func analyze(_ x: Int) -> Int {
    if x > 0 && x < 10 {
        for i in 0..<x {
            if i % 2 == 0 { return i }
        }
    } else if x < 0 {
        return -1
    }
    return 0
}
`;
    expect(calc.calculate(code)).toBeGreaterThanOrEqual(6);
  });

  it('should compute Kotlin complexity', () => {
    const calc = createKotlinComplexityCalculator();
    const code = `
fun analyze(x: Int): Int {
    if (x > 0 && x < 10) {
        for (i in 0 until x) {
            if (i % 2 == 0) return i
        }
    } else {
        return -1
    }
    return 0
}
`;
    expect(calc.calculate(code)).toBeGreaterThanOrEqual(6);
  });
});
