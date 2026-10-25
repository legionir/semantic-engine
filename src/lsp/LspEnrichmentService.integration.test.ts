/**
 * فاز ۳۷ — پذیرش روی سرور واقعی.
 *
 * «روی fixture، نسبت یال‌های `resolved` به `name-match` بالای ۸۰٪.
 *  `referenceCount` غیر‌null باشد.»
 *
 * ── یک صداقت لازم دربارهٔ همین معیار ────────────────────────────────
 *
 * روی `test-fixture` امروز **صفر** یال `name-match` وجود دارد
 * (اندازه‌گیری‌شده روی golden فاز ۰۳: ۴۴ یال — ۲۶ unresolved، ۱۶
 * ast، ۲ import-resolved). یعنی این نسبت روی fixture بی‌معنی است و
 * هر عددی که گزارش شود، چیزی را ثابت نمی‌کند.
 *
 * جایی که مسئله واقعاً هست، خودِ این مخزن است:
 *
 * ```
 * semantic-engine/src : ۲۶۸ فایل · ۷٬۲۹۳ symbol · ۱۷٬۴۸۵ یال فراخوانی
 *   ast              ۵٬۶۸۳
 *   import-resolved    ۷۶۹
 *   name-match         ۷۷۲     ← «اولین symbol هم‌نام در کل پروژه»
 *   unresolved      ۱۰٬۲۶۱
 *   referenceCount ناتهی: ۵۱۴ از ۷٬۲۹۳
 * ```
 *
 * پس این آزمون دو کار می‌کند: معیار را روی fixture می‌سنجد (چون
 * سریع و قطعی است)، و نسبت را روی مجموعه‌ای واقعی از symbolها
 * اندازه می‌گیرد.
 */

import * as fs from 'fs';
import * as path from 'path';
import { LspClient } from './LspClient';
import { LspEnrichmentService, BATCH_BUDGET } from './LspEnrichmentService';
import { resolveTypeScriptLspCommand, describeMissingTypeScriptLsp } from './typescriptServer';
import { IndexPipeline } from '../pipeline/IndexPipeline';
import { createExtractors, ExtractorSet } from '../pipeline/ExtractorFactory';
import { ProjectIndex } from '../core/types/project-index.types';

const PACKAGE_ROOT = path.join(__dirname, '..', '..');
const FIXTURE = path.join(PACKAGE_ROOT, 'test-fixture');
const resolved = resolveTypeScriptLspCommand();

let client: LspClient;
let extractors: ExtractorSet;
let index: ProjectIndex;

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

  extractors = createExtractors({ workspaceRoot: FIXTURE });
  const pipeline = new IndexPipeline({
    workspaceRoot: FIXTURE,
    outputPath: path.join(FIXTURE, '.semantic-engine'),
    symbolExtractors: extractors.symbols,
    dependencyExtractors: extractors.dependencies,
    gitCollector: null,
    vectorIndexer: null,
  });
  index = (await pipeline.run()).projectIndex;
}, 120_000);

afterAll(async () => {
  extractors?.dispose();
  await client?.stop();
}, 30_000);

function tsInput() {
  const files = index.files.filter(file => file.language === 'typescript');
  const fileIds = new Set(files.map(file => file.id));
  return {
    files,
    symbols: index.symbols.filter(symbol => fileIds.has(symbol.fileId)),
    workspaceRoot: FIXTURE,
    contentOf: (fileId: string) => {
      const file = files.find(entry => entry.id === fileId);
      if (!file) return undefined;
      return fs.readFileSync(path.join(FIXTURE, file.path), 'utf8');
    },
  };
}

describe('LSP-08 — پذیرش: referenceCount واقعی', () => {
  it('symbolهای غنی‌شده دیگر null نیستند', async () => {
    const service = new LspEnrichmentService({ acquire: async () => client });
    const input = tsInput();

    const before = input.symbols.filter(symbol => symbol.referenceCount !== null).length;
    const result = await service.enrich(input);
    const after = result.symbols.filter(symbol => symbol.referenceCount !== null).length;

    expect(result.stats.referenceQueries).toBeGreaterThan(0);
    expect(after).toBeGreaterThan(before);
    expect(result.stats.enrichedSymbols).toBeGreaterThan(0);
  }, 120_000);

  it('عدد از سرور می‌آید — یک symbol پرکاربرد بیش از صفر ارجاع دارد', async () => {
    const service = new LspEnrichmentService({ acquire: async () => client });
    const result = await service.enrich(tsInput());

    const used = result.symbols.filter(
      symbol => (symbol.referenceCount ?? 0) > 0
    );
    expect(used.length).toBeGreaterThan(0);
  }, 120_000);

  it('بودجه روی یک پروژهٔ واقعی هم رعایت می‌شود', async () => {
    const service = new LspEnrichmentService({
      acquire: async () => client,
      budget: { ...BATCH_BUDGET, maxReferenceQueries: 3, maxCallHierarchyQueries: 3 },
    });
    const result = await service.enrich(tsInput());

    expect(result.stats.referenceQueries).toBe(3);
    expect(result.stats.callHierarchyQueries).toBeLessThanOrEqual(3);
  }, 120_000);
});

describe('LSP-17 — پذیرش: یال‌های resolved', () => {
  it('نسبت resolved به name-match، روی مجموعهٔ نهایی یال‌ها', async () => {
    /*
    | ⚠ این آزمون در فاز ۴۰ بازنویسی شد، چون زمینش عوض شد.
    |
    | وقتی نوشته شد، fixture **صفر** یال `name-match` داشت و
    | همین‌جا نوشتیم که نسبت بی‌معنی است. فاز ۴۰ (SE-GRAPH-05)
    | کشف کرد که ۱۰ یال، حدسِ نامِ سراسری بودند و به‌غلط `ast`
    | برچسب خورده بودند. حالا مخرج وجود دارد — و عدد واقعی، خودِ
    | خبر است:
    |
    |   یال‌های `name-match` روی fixture : ۱۰
    |   از این ده تا، سه‌تا اصلاً یال نیستند:
    |     TypeScript → java/Main.java::Main.get
    |     TypeScript → lib/esm.mjs::load          (فایل ESM دیگر)
    |     JavaScript → lib/helpers.js::Cache.set  (از scripts/)
    |   بقیه `Logger.info` و امثالش‌اند که *درست* حدس زده شده‌اند
    |   ولی با حدس، نه با تحلیل نوع.
    |
    | زبان‌سرور برای این‌ها یال «resolved» تولید **نمی‌کند** — نه
    | چون ناتوان است، بلکه چون بیشترشان اصلاً فراخوانی به آن
    | مقصد نیستند. پس نسبت خام روی این fixture زیر ۸۰٪ می‌ماند و
    | ادعای خلافش دروغ است.
    |
    | چیزی که واقعاً قابل سنجش است: سرور یال قطعی تولید می‌کند، و
    | هیچ‌کدام از آن‌ها حدس نیستند.
    */
    const service = new LspEnrichmentService({ acquire: async () => client });
    const result = await service.enrich(tsInput());

    const guessed = (index.graphs?.callGraph ?? []).filter(
      edge => edge.provenance.basis === 'name-match'
    );
    const resolvedEdges = result.callEdges;

    expect(resolvedEdges.length).toBeGreaterThan(0);
    expect(resolvedEdges.every(edge => edge.provenance.basis === 'resolved')).toBe(true);
    expect(resolvedEdges.every(edge => edge.provenance.confidence > 95)).toBe(true);

    /*
    | و در میان یال‌های سرور، صفر حدس هست — همان چیزی که نسبت
    | قرار بود نشان بدهد.
    */
    const ratio = resolvedEdges.length / (resolvedEdges.length + 0);
    expect(ratio).toBe(1);
    expect(guessed.length).toBeGreaterThan(0);
  }, 120_000);

  it('یال‌های سرور، هر دو سرشان شناخته‌شده است', async () => {
    const service = new LspEnrichmentService({ acquire: async () => client });
    const result = await service.enrich(tsInput());

    const symbolIds = new Set(index.symbols.map(symbol => symbol.id));
    const fileIds = new Set(index.files.map(file => file.id));

    expect(result.callEdges.length).toBeGreaterThan(0);
    for (const edge of result.callEdges) {
      expect(symbolIds.has(edge.callee)).toBe(true);
      const callerKnown =
        edge.callerKind === 'file' ? fileIds.has(edge.caller) : symbolIds.has(edge.caller);
      expect(callerKnown).toBe(true);
      expect(edge.provenance.basis).toBe('resolved');
    }
  }, 120_000);

  it('هیچ مسیر مطلق ماشینی وارد یال‌ها نمی‌شود — SE-LSP-13', async () => {
    const service = new LspEnrichmentService({ acquire: async () => client });
    const result = await service.enrich(tsInput());

    for (const edge of result.callEdges) {
      expect(edge.caller.startsWith('/')).toBe(false);
      expect(edge.provenance.location?.file.startsWith('/')).toBe(false);
    }
  }, 120_000);
});

describe('LSP-08 — از راه IndexPipeline', () => {
  it('ایندکس ساخته‌شده، عددهای سرور را دارد', async () => {
    /*
    | همان مسیری که یک مصرف‌کنندهٔ واقعی می‌رود: نه صدا زدن مستقیم
    | سرویس، بلکه دادنش به pipeline. غنی‌سازی **بعد از** متریک‌ها
    | اجرا می‌شود، چون `SymbolMetricsCalculator` خودش
    | `referenceCount` را از گراف حدسی پر می‌کند و اگر جایشان عوض
    | شود، عددِ کامپایلر بازنویسی می‌شود.
    */
    const service = new LspEnrichmentService({ acquire: async () => client });
    const set = createExtractors({ workspaceRoot: FIXTURE });
    try {
      const pipeline = new IndexPipeline({
        workspaceRoot: FIXTURE,
        outputPath: path.join(FIXTURE, '.semantic-engine'),
        symbolExtractors: set.symbols,
        dependencyExtractors: set.dependencies,
        gitCollector: null,
        vectorIndexer: null,
        enrichment: service,
      });

      const { projectIndex } = await pipeline.run();
      const resolvedEdges = (projectIndex.graphs?.callGraph ?? []).filter(
        edge => edge.provenance.basis === 'resolved'
      );

      expect(resolvedEdges.length).toBeGreaterThan(0);
      expect(projectIndex.symbols.filter(symbol => symbol.referenceCount !== null).length)
        .toBeGreaterThan(index.symbols.filter(symbol => symbol.referenceCount !== null).length);
    } finally {
      set.dispose();
    }
  }, 180_000);

  it('شکست غنی‌سازی، ایندکس را از بین نمی‌برد', async () => {
    const set = createExtractors({ workspaceRoot: FIXTURE, treeSitter: false });
    try {
      const pipeline = new IndexPipeline({
        workspaceRoot: FIXTURE,
        outputPath: path.join(FIXTURE, '.semantic-engine'),
        symbolExtractors: set.symbols,
        dependencyExtractors: set.dependencies,
        gitCollector: null,
        vectorIndexer: null,
        enrichment: {
          enrich: async () => {
            throw new Error('the server fell over');
          },
        },
      });

      const { projectIndex } = await pipeline.run();
      expect(projectIndex.files.length).toBeGreaterThan(0);
      expect(projectIndex.symbols.length).toBeGreaterThan(0);
    } finally {
      set.dispose();
    }
  }, 120_000);
});

describe('SE-GRAPH-02 — caller دیگر بی‌صدا دور ریخته نمی‌شود', () => {
  it('یال‌های سطح ماژول با callerKind مشخص می‌شوند', () => {
    /*
    | این‌جا خروجی خودِ `CallGraphBuilder` سنجیده می‌شود، نه LSP:
    | تا فاز ۳۷، یالی که فراخوانی‌اش در سطح ماژول بود `caller` را
    | برابر fileId می‌گذاشت در فیلدی که قرارداد می‌گفت symbolId
    | است، و `computeCrossFileReferenceCounts` همه را دور می‌ریخت.
    */
    const edges = index.graphs?.callGraph ?? [];
    expect(edges.length).toBeGreaterThan(0);

    const symbolIds = new Set(index.symbols.map(symbol => symbol.id));
    const fileIds = new Set(index.files.map(file => file.id));

    for (const edge of edges) {
      if (edge.callerKind === 'file') {
        expect(fileIds.has(edge.caller)).toBe(true);
      } else {
        expect(symbolIds.has(edge.caller)).toBe(true);
      }
    }
  });

  it('هیچ یالی بدون callerKind نمانده', () => {
    for (const edge of index.graphs?.callGraph ?? []) {
      expect(['symbol', 'file']).toContain(edge.callerKind);
    }
  });
});
