import { CssSymbolExtractor } from './CssSymbolExtractor';

const extractor = new CssSymbolExtractor();

describe('CssSymbolExtractor', () => {
  it('should extract class selectors as property symbols', async () => {
    const content = `.btn-primary {
  color: white;
}

.card {
  padding: 1rem;
}`;

    const result = await extractor.extract('f1', 'styles.css', content, 'css');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const names = result.value.symbols.map(s => s.name);
    expect(names).toContain('.btn-primary');
    expect(names).toContain('.card');
  });

  it('should extract at-rules as module symbols', async () => {
    const content = `@media (min-width: 768px) {
  .sidebar { width: 200px; }
}

@keyframes fadeIn {
  from { opacity: 0; }
}`;

    const result = await extractor.extract('f1', 'styles.css', content, 'css');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const moduleNames = result.value.symbols
      .filter(s => s.kind === 'module')
      .map(s => s.name);
    expect(moduleNames).toContain('@media');
    expect(moduleNames).toContain('@keyframes');
  });

  it('should handle SCSS/Less files', async () => {
    const content = `.nav {
  &__link { color: blue; }
}`;

    const result = await extractor.extract('f1', 'styles.scss', content, 'scss');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.symbols.map(s => s.name)).toContain('.nav');
  });
});

/*
| SE-SYM-24 — media queryهای تودرتو.
*/
describe('nested rules', () => {

  const extract = async (content: string) => {
    const result = await new CssSymbolExtractor().extract('f1', 'a.css', content, 'css');
    if (!result.ok) throw result.error;
    return result.value.symbols;
  };

  const NESTED = `@media (max-width: 600px) {
  .card {
    color: red;
  }
}
.plain { color: blue; }
`;

  /*
  | گروه selector از درست بعد از `{` قبلی شروع می‌شود، پس اعلان‌ها و
  | `}`های بسته را هم می‌گیرد. گرفتن شماره خط از ابتدای آن گروه یعنی
  | هر قاعده شماره خط قاعدهٔ قبلی را می‌گرفت: `.card` خط ۱ و `.plain`
  | خط ۲، به‌جای ۲ و ۶.
  */
  it('puts a nested selector on its own line', async () => {
    const symbols = await extract(NESTED);

    expect(symbols.find(s => s.name === '.card')).toMatchObject({ line: 2, endLine: 4 });
  });

  it('puts the rule after a nested block on its own line', async () => {
    const symbols = await extract(NESTED);

    expect(symbols.find(s => s.name === '.plain')).toMatchObject({ line: 6, endLine: 6 });
  });

  it('spans an at-rule across its whole block', async () => {
    const symbols = await extract(NESTED);

    expect(symbols.find(s => s.name === '@media')).toMatchObject({ line: 1, endLine: 5 });
  });

  it('ends an at-rule without a block at its semicolon', async () => {
    const symbols = await extract('@import url("https://example.com/a.css");\n.x { color: red; }\n');

    expect(symbols.find(s => s.name === '@import')).toMatchObject({ line: 1, endLine: 1 });
    expect(symbols.find(s => s.name === '.x')).toMatchObject({ line: 2, endLine: 2 });
  });
});
