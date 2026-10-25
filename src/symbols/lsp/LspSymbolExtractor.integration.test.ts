/**
 * فاز ۳۳ — معیار پذیرش روی زبان‌سرور واقعی.
 *
 * «روی fixture، symbolهای TS با `source: 'lsp'` و `endLine` درست.
 *  ابزار بی‌اثر اعلام نشود.»
 *
 * سه‌تای این‌ها اینجا سنجیده می‌شوند، و کنارشان چیزی که سنجیدنش
 * مهم‌تر از هر ادعای دیگری در این فاز است: **زبان‌سرور در همه‌چیز
 * بهتر نیست.** نتیجهٔ هر دو مسیر روی همان فایل مقایسه می‌شود تا
 * تصمیم ادغام (SE-SYM-01) روی داده بنشیند نه روی حدس.
 */

import * as fs from 'fs';
import * as path from 'path';
import { LspClient } from '../../lsp/LspClient';
import { CapabilityProbe } from '../../lsp/CapabilityProbe';
import { resolveTypeScriptLspCommand, describeMissingTypeScriptLsp } from '../../lsp/typescriptServer';
import { LspSymbolExtractor } from './LspSymbolExtractor';
import { TreeSitterParserManager } from '../tree-sitter/TreeSitterParserManager';
import { TreeSitterSymbolExtractor } from '../tree-sitter/TreeSitterSymbolExtractor';
import { SymbolExtractorManager } from '../SymbolExtractorManager';
import { SymbolEntry } from '../../core/types/project-index.types';

const PACKAGE_ROOT = path.join(__dirname, '..', '..', '..');
const FIXTURE = path.join(PACKAGE_ROOT, 'test-fixture');
const GRAMMARS = path.join(PACKAGE_ROOT, 'tree-sitter-grammars');

const resolved = resolveTypeScriptLspCommand();

let client: LspClient;
let extractor: LspSymbolExtractor;

beforeAll(async () => {
  if (!resolved) throw new Error(describeMissingTypeScriptLsp());
  client = new LspClient({
    id: 'typescript',
    command: resolved.command,
    args: resolved.args,
    rootPath: FIXTURE,
    initializeTimeoutMs: 60_000,
    requestTimeoutMs: 30_000,
  });
  await client.start();
  extractor = new LspSymbolExtractor({
    acquire: async () => client,
    probe: new CapabilityProbe(),
    requestTimeoutMs: 20_000,
  });
}, 90_000);

afterAll(async () => {
  await extractor?.dispose();
  await client?.stop();
}, 30_000);

async function extract(relative: string): Promise<readonly SymbolEntry[]> {
  const file = path.join(FIXTURE, relative);
  const content = fs.readFileSync(file, 'utf8');
  const result = await extractor.extract('fixture-file', file, content, 'typescript');
  if (!result.ok) throw result.error;
  return result.value.symbols;
}

describe('LSP-07 — پذیرش روی fixture', () => {
  it('symbolها با source برابر lsp می‌آیند', async () => {
    const symbols = await extract('src/app.ts');
    expect(symbols.length).toBeGreaterThan(0);
    expect(symbols.every(symbol => symbol.source === 'lsp')).toBe(true);
    expect(symbols.every(symbol => symbol.confidence > 0)).toBe(true);
  }, 60_000);

  it('endLine واقعیِ بدنه است، نه خط اعلان', async () => {
    /*
    | همان چیزی که SE-SYM-12 دربارهٔ مسیر heuristic می‌گفت:
    | `endLine === line`. زبان‌سرور پایان واقعی بدنه را می‌دهد.
    */
    const symbols = await extract('src/app.ts');
    const application = symbols.find(symbol => symbol.name === 'Application')!;

    expect(application.kind).toBe('class');
    expect(application.line).toBe(7);
    expect(application.endLine).toBe(20);
  }, 60_000);

  it('SE-LSP-02 — نام‌های import شده در نتیجه نیستند', async () => {
    const symbols = await extract('src/app.ts');
    /*
    | `src/app.ts` چهار import دارد: Logger, UserService, CONFIG,
    | join. زبان‌سرور هر چهار را `Variable` سطح‌بالا گزارش می‌کند.
    */
    for (const imported of ['Logger', 'UserService', 'CONFIG', 'join']) {
      expect(symbols.map(symbol => symbol.name)).not.toContain(imported);
    }
    expect(symbols.map(symbol => symbol.name)).toEqual([
      'Application',
      'log',
      'constructor',
      'users',
      'start',
      'stop',
      'createApplication',
      'VERSION',
    ]);
  }, 60_000);

  it('سلسله‌مراتب کامل است — اعضا به کلاسشان وصل‌اند', async () => {
    const symbols = await extract('src/app.ts');
    const application = symbols.find(symbol => symbol.name === 'Application')!;
    const members = symbols.filter(symbol => symbol.parentId === application.id);

    expect(members.map(symbol => symbol.name)).toEqual([
      'log',
      'constructor',
      'users',
      'start',
      'stop',
    ]);
  }, 60_000);

  it('SE-LSP-08 — `type` دیگر class نیست و `const` دیگر variable نیست', async () => {
    const symbols = await extract('src/util/strings.ts');
    const byName = new Map(symbols.map(symbol => [symbol.name, symbol]));

    /*
    | خام از سرور: هر دو غلط می‌آمدند —
    |   type … → kind=5  (Class)
    |   const … → kind=13 (Variable)
    */
    for (const symbol of symbols) {
      const line = fs.readFileSync(path.join(FIXTURE, 'src/util/strings.ts'), 'utf8').split('\n')[
        symbol.line - 1
      ];
      if (/^\s*(?:export\s+)?type\s/.test(line)) expect(symbol.kind).toBe('type-alias');
      if (/^\s*(?:export\s+)?const\s/.test(line)) expect(symbol.kind).toBe('constant');
    }
    expect(byName.size).toBeGreaterThan(0);
  }, 60_000);
});

describe('LSP-15 — ابزار بی‌اثر اعلام نمی‌شود', () => {
  it('کاوش، قابلیت‌های واقعی این سرور را جدا می‌کند', async () => {
    const probe = new CapabilityProbe();
    const report = await probe.probe(client, 'typescript', path.join(FIXTURE, 'src/app.ts'));

    // این‌ها روی tsgo واقعاً کار می‌کنند.
    expect(report.verdicts.documentSymbol).toBe('works');
    expect(report.verdicts.hover).toBe('works');
    expect(report.verdicts.references).toBe('works');
    expect(report.verdicts.definition).toBe('works');
    expect(report.verdicts.rename).toBe('works');
    expect(report.verdicts.callHierarchy).toBe('works');

    // و هیچ‌کدام «اعلام‌شده ولی همیشه خالی» نمانده‌اند.
    expect(Object.values(report.verdicts)).not.toContain('failed');
  }, 60_000);

  it('کاوش یک‌بار است، نه به‌ازای هر فایل', async () => {
    const probe = new CapabilityProbe();
    const once = new LspSymbolExtractor({
      acquire: async () => client,
      probe,
      probeFile: path.join(FIXTURE, 'src/app.ts'),
    });

    const startedAt = Date.now();
    for (const relative of ['src/app.ts', 'src/config.ts', 'src/util/logger.ts']) {
      const file = path.join(FIXTURE, relative);
      await once.isAvailable('typescript');
      await once.extract('f', file, fs.readFileSync(file, 'utf8'), 'typescript');
    }
    const elapsed = Date.now() - startedAt;

    expect(probe.cached(client.serverKey, 'typescript')).toBeDefined();
    expect(elapsed).toBeLessThan(20_000);
    await once.dispose();
  }, 60_000);
});

describe('SE-SYM-01 — چرا ادغام، و نه انتخاب', () => {
  it('هیچ‌کدام از دو مسیر زیرمجموعهٔ دیگری نیست', async () => {
    /*
    | این آزمون یک *اندازه‌گیری* است، نه یک قاعده: اگر روزی
    | زبان‌سرور همه‌چیزِ tree-sitter را بدهد، این قرمز می‌شود و آن
    | روز باید دربارهٔ ادغام دوباره تصمیم گرفت.
    */
    const parserManager = new TreeSitterParserManager({ grammarDir: GRAMMARS });
    const treeSitter = new TreeSitterSymbolExtractor({ parserManager });

    const file = path.join(FIXTURE, 'src/app.ts');
    const content = fs.readFileSync(file, 'utf8');

    const fromTreeSitter = await treeSitter.extract('f', file, content, 'typescript');
    const fromLsp = await extractor.extract('f', file, content, 'typescript');
    if (!fromTreeSitter.ok || !fromLsp.ok) throw new Error('both extractors must answer');

    const names = (symbols: readonly SymbolEntry[]) => new Set(symbols.map(s => s.name));
    const lspNames = names(fromLsp.value.symbols);
    const treeSitterNames = names(fromTreeSitter.value.symbols);

    const onlyLsp = [...lspNames].filter(name => !treeSitterNames.has(name));
    const onlyTreeSitter = [...treeSitterNames].filter(name => !lspNames.has(name));

    // پارامتر-پراپرتی سازنده را فقط زبان‌سرور می‌بیند.
    expect(onlyLsp).toContain('users');
    // و هیچ symbolای نیست که فقط tree-sitter ببیند — امروز.
    expect(onlyTreeSitter).toEqual([]);

    await treeSitter.dispose();
    parserManager.dispose();
  }, 90_000);

  it('مدیر، نتیجهٔ ناقص زبان‌سرور را با tree-sitter ادغام می‌کند', async () => {
    const parserManager = new TreeSitterParserManager({ grammarDir: GRAMMARS });
    const manager = new SymbolExtractorManager({ availabilityTtlMs: 0 });

    /*
    | یک زبان‌سرور که «ناقص» جواب می‌دهد را با یک استخراج‌گر بدلی
    | می‌سازیم که همان symbolهای واقعی LSP را برمی‌گرداند ولی
    | `partial: true` می‌گوید — همان حالتی که پیش از این کل نتیجه
    | را دور می‌ریخت.
    */
    const file = path.join(FIXTURE, 'src/app.ts');
    const content = fs.readFileSync(file, 'utf8');
    const real = await extractor.extract('f', file, content, 'typescript');
    if (!real.ok) throw real.error;

    manager.register({
      name: 'lsp',
      priority: 90,
      isAvailable: async () => true,
      extract: async () => ({ ok: true as const, value: { ...real.value, partial: true } }),
      dispose: async () => {},
    });
    manager.register(new TreeSitterSymbolExtractor({ parserManager }));

    const merged = await manager.extract('f', file, content, 'typescript');
    if (!merged.ok) throw merged.error;

    const names = merged.value.symbols.map(symbol => symbol.name);
    expect(names).toContain('users');            // فقط از LSP
    expect(names).toContain('Application');      // از هر دو، یک‌بار
    expect(names.filter(name => name === 'Application')).toHaveLength(1);
    expect(merged.value.partial).toBe(false);

    await manager.dispose();
    parserManager.dispose();
  }, 90_000);
});
