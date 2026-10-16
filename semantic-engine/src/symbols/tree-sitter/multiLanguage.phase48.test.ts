/**
 * معیار پذیرش فاز ۴۸.
 *
 * > فایل Python با کلاس و متد، symbolهای `source: 'tree-sitter'` بدهد.
 *
 * پیش از این فاز، `TreeSitterSymbolMapper.mapNodeTypeToKind` یک
 * `switch` هاردکدشده روی نام گره‌های گرامرِ TypeScript بود و
 * `getGrammarName` فقط چهار زبان را می‌شناخت. اندازه‌گیری روی
 * fixture:
 *
 * ```
 * python  ۳ فایل   ۹ نماد   همه heuristic
 * go      ۱ فایل   ۴ نماد   همه heuristic
 * java    ۱ فایل   ۴ نماد   همه heuristic
 * rust    ۱ فایل   ۸ نماد   همه heuristic
 * ```
 */

import * as path from 'path';
import { TreeSitterSymbolExtractor } from './TreeSitterSymbolExtractor';
import { TreeSitterParserManager } from './TreeSitterParserManager';
import { supportLevelFor, grammarFor } from './languageGrammars';
import { SymbolEntry } from '../../core/types/project-index.types';

const grammarDir = path.join(__dirname, '..', '..', '..', 'tree-sitter-grammars');

const SOURCES: Readonly<Record<string, string>> = {
  python: `class UserService:
    """Docs."""

    def __init__(self, repo):
        self.repo = repo

    def find(self, user_id):
        return self.repo.get(user_id)


def helper(value):
    return value
`,
  go: `package main

type UserService struct {
	repo string
}

func (s *UserService) Find(id string) string {
	return s.repo
}

func Helper(x int) int {
	return x
}
`,
  java: `package app;

public class UserService {
    private String repo;

    public String find(String id) {
        return repo;
    }
}

interface Greeter {
    String greet();
}
`,
  rust: `pub struct UserService {
    repo: String,
}

impl UserService {
    pub fn find(&self, id: &str) -> String {
        self.repo.clone()
    }
}

pub trait Greeter {
    fn greet(&self) -> String;
}

pub fn helper(x: i32) -> i32 {
    x
}
`,
};

async function extract2(languageId: string, source: string): Promise<SymbolEntry[]> {
  const manager = new TreeSitterParserManager({ grammarDir });
  const extractor = new TreeSitterSymbolExtractor({ parserManager: manager });
  const result = await extractor.extract(`f-${languageId}`, `s.${languageId}`, source, languageId);
  if (!result.ok) throw new Error('extraction failed');
  return [...result.value.symbols];
}

async function extract(languageId: string): Promise<SymbolEntry[]> {
  const manager = new TreeSitterParserManager({ grammarDir });
  const extractor = new TreeSitterSymbolExtractor({ parserManager: manager });
  const result = await extractor.extract(
    `f-${languageId}`,
    `sample.${languageId}`,
    SOURCES[languageId]!,
    languageId
  );
  if (!result.ok) throw new Error(`extraction failed: ${result.error.message}`);
  return [...result.value.symbols];
}

describe('معیار پذیرش فاز ۴۸ — Python', () => {
  let symbols: SymbolEntry[];

  beforeAll(async () => {
    symbols = await extract('python');
  });

  it('کلاس و متد با source: tree-sitter برمی‌گردند', () => {
    const service = symbols.find(s => s.name === 'UserService')!;

    expect(service).toBeDefined();
    expect(service.kind).toBe('class');
    expect(service.source).toBe('tree-sitter');
  });

  it('متدهای کلاس پیدا می‌شوند و به آن نسبت داده می‌شوند', () => {
    const service = symbols.find(s => s.name === 'UserService')!;
    const find = symbols.find(s => s.name === 'find')!;

    expect(find).toBeDefined();
    expect(find.source).toBe('tree-sitter');
    expect(find.parentId).toBe(service.id);
  });

  it('تابعِ داخل کلاس، متد است نه تابع', () => {
    /*
    | گرامر Python برای تابع و متد **یک** گره دارد
    | (`function_definition`). تفکیک باید از روی جایگاه بیاید.
    | نسخهٔ اول همه را `function` می‌گفت — یک پس‌رفت نسبت به مسیر
    | heuristic که درست `method` می‌داد.
    */
    const find = symbols.find(s => s.name === 'find')!;
    const init = symbols.find(s => s.name === '__init__')!;

    expect(find.kind).toBe('method');
    expect(init.kind).toBe('method');
  });

  it('تابعِ سطح فایل، متد حساب نمی‌شود', () => {
    const helper = symbols.find(s => s.name === 'helper')!;

    expect(helper.kind).toBe('function');
    expect(helper.parentId).toBeNull();
  });

  it('هیچ نمادی heuristic نیست', () => {
    expect(symbols.every(s => s.source === 'tree-sitter')).toBe(true);
  });

  it('شماره‌های خط معنادارند', () => {
    for (const s of symbols) {
      expect(s.line).toBeGreaterThan(0);
      expect(s.endLine).toBeGreaterThanOrEqual(s.line);
    }
  });
});

describe('فاز ۴۸ — Go', () => {
  let symbols: SymbolEntry[];

  beforeAll(async () => {
    symbols = await extract('go');
  });

  it('struct پیدا می‌شود', () => {
    const service = symbols.find(s => s.name === 'UserService')!;

    expect(service).toBeDefined();
    expect(service.kind).toBe('struct');
    expect(service.source).toBe('tree-sitter');
  });

  it('متدِ گیرنده‌دار و تابعِ آزاد هر دو پیدا می‌شوند', () => {
    expect(symbols.find(s => s.name === 'Find')?.kind).toBe('method');
    expect(symbols.find(s => s.name === 'Helper')?.kind).toBe('function');
  });

  it('`type X interface` را interface می‌شناسد، نه struct', async () => {
    /*
    | در Go هم `type X struct{}` و هم `type X interface{}` یک
    | `type_spec` هستند؛ نوعِ واقعی در فرزندش است. نگاشتِ ثابتِ
    | `type_spec → struct` هر interfaceی را struct می‌کرد.
    */
    const withInterface = await extract2(
      'go',
      `package main

type Handler interface {
	Serve() error
}

type Server struct {
	addr string
}
`
    );

    expect(withInterface.find(s => s.name === 'Handler')?.kind).toBe('interface');
    expect(withInterface.find(s => s.name === 'Server')?.kind).toBe('struct');
  });
});

describe('فاز ۴۸ — Java', () => {
  let symbols: SymbolEntry[];

  beforeAll(async () => {
    symbols = await extract('java');
  });

  it('کلاس و interface پیدا می‌شوند', () => {
    expect(symbols.find(s => s.name === 'UserService')?.kind).toBe('class');
    expect(symbols.find(s => s.name === 'Greeter')?.kind).toBe('interface');
  });

  it('متد به کلاسش نسبت داده می‌شود', () => {
    const service = symbols.find(s => s.name === 'UserService')!;
    const find = symbols.find(s => s.name === 'find')!;

    expect(find.kind).toBe('method');
    expect(find.parentId).toBe(service.id);
  });
});

describe('فاز ۴۸ — Rust', () => {
  let symbols: SymbolEntry[];

  beforeAll(async () => {
    symbols = await extract('rust');
  });

  it('struct و trait پیدا می‌شوند', () => {
    expect(symbols.find(s => s.name === 'UserService')?.kind).toBe('struct');
    expect(symbols.find(s => s.name === 'Greeter')?.kind).toBe('trait');
  });

  it('تابعِ آزاد پیدا می‌شود', () => {
    const helper = symbols.find(s => s.name === 'helper')!;

    expect(helper.kind).toBe('function');
    expect(helper.parentId).toBeNull();
  });

  it('تابعِ داخل impl، متد است', () => {
    const find = symbols.find(s => s.name === 'find')!;

    expect(find.kind).toBe('method');
  });

  it('متدِ داخل impl به struct نسبت داده می‌شود، نه به فایل', () => {
    /*
    | `impl_item` خودش نمادی نیست. بدون شفاف کردنش، `find` یا گم
    | می‌شود یا فرزندِ چیزی می‌شود که در ایندکس وجود ندارد.
    */
    const service = symbols.find(s => s.name === 'UserService')!;
    const find = symbols.find(s => s.name === 'find')!;

    expect(find).toBeDefined();
    expect(find.parentId).toBe(service.id);
  });
});

describe('سطح پشتیبانی صریح است (SE-SYM-16)', () => {
  it('هر زبانِ دارای گرامر، سطحش اعلام شده', () => {
    expect(supportLevelFor('typescript')).toBe('full');
    expect(supportLevelFor('python')).toBe('structural');
    expect(supportLevelFor('go')).toBe('structural');
    expect(supportLevelFor('java')).toBe('structural');
    expect(supportLevelFor('rust')).toBe('structural');
    // AI-06 — Kotlin و Swift حالا گرامرِ build-شده دارند.
    expect(supportLevelFor('kotlin')).toBe('structural');
    expect(supportLevelFor('swift')).toBe('structural');
  });

  it('زبانِ بدون گرامر، heuristic اعلام می‌شود', () => {
    expect(supportLevelFor('zig')).toBe('heuristic');
    expect(supportLevelFor('cobol')).toBe('heuristic');
  });

  it('پیکربندی هر زبان قابل بازرسی است', () => {
    const python = grammarFor('python')!;

    expect(python.grammar).toBe('python');
    expect(Object.keys(python.kinds).length).toBeGreaterThan(0);
  });

  it('زبانِ ناشناخته پیکربندی ندارد', () => {
    expect(grammarFor('cobol')).toBeNull();
  });
});

describe('مسیر tree-sitter در دسترس است', () => {
  it('گرامر هر چهار زبان بارگذاری می‌شود', async () => {
    const manager = new TreeSitterParserManager({ grammarDir });

    for (const languageId of ['python', 'go', 'java', 'rust']) {
      expect({ languageId, ok: await manager.isAvailable(languageId) }).toEqual({
        languageId,
        ok: true,
      });
    }
  });

  it('AI-06 — گرامرهای Kotlin و Swift بارگذاری می‌شوند', async () => {
    const manager = new TreeSitterParserManager({ grammarDir });

    for (const languageId of ['kotlin', 'swift']) {
      expect({ languageId, ok: await manager.isAvailable(languageId) }).toEqual({
        languageId,
        ok: true,
      });
    }
  });

  it('زبانِ بدون گرامر، در دسترس اعلام نمی‌شود', async () => {
    const manager = new TreeSitterParserManager({ grammarDir });

    expect(await manager.isAvailable('cobol')).toBe(false);
  });
});
