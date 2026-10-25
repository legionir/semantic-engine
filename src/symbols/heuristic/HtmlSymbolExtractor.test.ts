import { HtmlSymbolExtractor } from './HtmlSymbolExtractor';

const extractor = new HtmlSymbolExtractor();

describe('HtmlSymbolExtractor', () => {
  /*
  | SE-SYM-24 — این تست تا فاز ۱۶ انتظار `kind: 'class'` داشت، یعنی
  | همان نگاشت معنایی غلط را به‌عنوان قرارداد ثبت کرده بود. یک `id`
  | در HTML شناسهٔ یک عنصر است، نه یک کلاس.
  */
  it('should extract id attributes as property symbols', async () => {
    const content = `<!DOCTYPE html>
<html>
  <body>
    <div id="app"></div>
    <nav id="main-nav"></nav>
  </body>
</html>`;

    const result = await extractor.extract('f1', 'index.html', content, 'html');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const names = result.value.symbols.map(s => s.name);
    expect(names).toContain('app');
    expect(names).toContain('main-nav');

    const appSymbol = result.value.symbols.find(s => s.name === 'app');
    expect(appSymbol?.kind).toBe('property');
  });

  it('should extract script and template as module boundaries', async () => {
    const content = `<template id="tpl">
  <div></div>
</template>
<script src="app.js"></script>
<style>.red { color: red; }</style>`;

    const result = await extractor.extract('f1', 'index.html', content, 'html');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const moduleSymbols = result.value.symbols.filter(s => s.kind === 'module');
    expect(moduleSymbols.map(s => s.name)).toContain('template');
    expect(moduleSymbols.map(s => s.name)).toContain('script');
    expect(moduleSymbols.map(s => s.name)).toContain('style');
  });

  it('should extract first class name as property symbol', async () => {
    const content = `<div class="btn btn-primary"></div>`;

    const result = await extractor.extract('f1', 'index.html', content, 'html');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.symbols.map(s => s.name)).toContain('btn');
  });
});
