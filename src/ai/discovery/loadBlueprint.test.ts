/**
 * SE-BP-06 — blueprint یک آرتیفکتِ فقط‌نوشتنی بود.
 *
 * `BlueprintGenerator` آن را می‌ساخت، `BlueprintExporter` می‌نوشتش،
 * `OutputWriter` مسیرش را گزارش می‌کرد، و **هیچ‌کس بازنمی‌خواندش**.
 * جست‌وجوی کد روی کل `src` تأیید کرد:
 *
 * ```
 * $ grep -rn "JSON.parse" src | grep -i blueprint
 * (خالی)
 * ```
 *
 * یعنی هزینهٔ محاسبه و نوشتنش پرداخت می‌شد و فایده‌اش صفر بود. GAP-04
 * هم صریحاً کشف نامزد را «جست‌وجو + blueprint» تعریف کرده بود، پس
 * بدون خواننده، نیمِ دوم آن جمله وجود خارجی نداشت.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { loadBlueprint, loadBlueprintBeside } from './loadBlueprint';
import { BlueprintGenerator } from '../../blueprint/BlueprintGenerator';
import { ProjectIndex } from '../../core/types/project-index.types';

function sampleIndex(): ProjectIndex {
  const files = ['payments/checkout.ts', 'ledger/postings.ts', 'ledger/reconcile.ts'].map(
    (p, i) => ({
      id: `f${i}`,
      path: p,
      language: 'typescript',
      size: 10,
      lines: 5,
      hash: 'h',
      binary: false,
      testFile: false,
      symbolIds: [],
      imports: [],
      exports: [],
      diagnostics: [],
      outline: [],
    })
  );

  return {
    schemaVersion: '2.0.0',
    root: 'fixture',
    generatedAt: '2026-08-19T00:00:00.000Z',
    languages: ['typescript'],
    files,
    symbols: [],
    graphs: {
      dependencyGraph: [],
      reverseDependencyGraph: [],
      callGraph: [],
      typeGraph: [],
    },
    diagnostics: [],
    metrics: {
      totalFiles: files.length,
      totalLoc: 15,
      totalSymbols: 0,
      avgCyclomaticComplexity: 1,
      languageBreakdown: { typescript: files.length },
    },
  } as unknown as ProjectIndex;
}

describe('loadBlueprint (SE-BP-06)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-engine-bp-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('blueprintی که واقعاً تولید شده را می‌خواند و قابل پرس‌وجو می‌کند', () => {
    const blueprint = new BlueprintGenerator().generate(sampleIndex());
    const file = path.join(dir, 'blueprint.json');
    fs.writeFileSync(file, JSON.stringify(blueprint));

    const result = loadBlueprint(file);

    expect(result.index).not.toBeNull();
    expect(result.loadedFrom).toBe(file);
    expect(result.index!.moduleCount).toBe(blueprint.moduleMap.length);
    expect(result.index!.matchModules(['ledger'])[0].id).toBe('mod-ledger');
  });

  it('کنارِ project-index پیدایش می‌کند بی‌آنکه مسیرش پرسیده شود', () => {
    const blueprint = new BlueprintGenerator().generate(sampleIndex());
    fs.writeFileSync(path.join(dir, 'blueprint.json'), JSON.stringify(blueprint));
    const indexPath = path.join(dir, 'project-index.json');
    fs.writeFileSync(indexPath, '{}');

    const result = loadBlueprintBeside(indexPath);

    expect(result.index).not.toBeNull();
    expect(result.loadedFrom).toBe(path.join(dir, 'blueprint.json'));
  });

  it('نبودِ فایل، خطا نیست — کشف باید بدون blueprint هم کار کند', () => {
    const result = loadBlueprintBeside(path.join(dir, 'project-index.json'));

    expect(result.index).toBeNull();
    expect(result.note).toContain('no blueprint');
  });

  it('JSON خراب، بی‌صدا رد نمی‌شود', () => {
    const file = path.join(dir, 'blueprint.json');
    fs.writeFileSync(file, '{ not json');

    const result = loadBlueprint(file);

    expect(result.index).toBeNull();
    expect(result.note).toContain('not valid JSON');
  });

  it('JSON معتبر ولی بدون moduleMap رد می‌شود', () => {
    const file = path.join(dir, 'blueprint.json');
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: '2.0.0' }));

    const result = loadBlueprint(file);

    expect(result.index).toBeNull();
    expect(result.note).toContain('moduleMap');
  });

  it('moduleMap با آیتمِ ناقص هم رد می‌شود', () => {
    const file = path.join(dir, 'blueprint.json');
    fs.writeFileSync(file, JSON.stringify({ moduleMap: [{ id: 'mod-a' }] }));

    expect(loadBlueprint(file).index).toBeNull();
  });

  it('نگاشتِ فایل به ماژول کار می‌کند', () => {
    const index = sampleIndex();
    const blueprint = new BlueprintGenerator().generate(index);
    const file = path.join(dir, 'blueprint.json');
    fs.writeFileSync(file, JSON.stringify(blueprint));

    const loaded = loadBlueprint(file).index!;
    const postings = index.files.find(f => f.path === 'ledger/postings.ts')!;

    expect(loaded.moduleOf(postings.id)?.id).toBe('mod-ledger');
  });
});
