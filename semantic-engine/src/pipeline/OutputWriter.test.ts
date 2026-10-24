/**
 * OutputWriter — MIG-22 و SE-EXP-02.
 *
 * ادعای مرکزی: هر خروجی *دقیقاً یک بار* نوشته می‌شود. مسیر قبلی
 * `project-index.json` را دو بار می‌نوشت (اول بدون بردار، بعد با آن) و
 * هر خواننده‌ای که بین این دو می‌رسید، ایندکسی بدون بردار می‌دید.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OutputWriter, INDEX_FILE_NAME, BLUEPRINT_FILE_NAME } from './OutputWriter';
import { NodeFileSystem } from '../host/FileSystem';
import { ProjectIndex } from '../core/types/project-index.types';

let dir: string;

/** فایل‌سیستمی که هر نوشتن را ثبت می‌کند. */
class RecordingFileSystem extends NodeFileSystem {
  readonly writes: string[] = [];

  override async writeFileAtomic(filePath: string, data: string | Buffer): Promise<void> {
    this.writes.push(filePath);
    return super.writeFileAtomic(filePath, data);
  }

  override async writeJsonAtomic(
    filePath: string,
    value: unknown,
    options?: { pretty?: boolean }
  ): Promise<void> {
    this.writes.push(filePath);
    return super.writeJsonAtomic(filePath, value, options);
  }
}

/*
| یک chunk کمینه — محتوایش برای این تست‌ها بی‌اهمیت است.
|
| SE-EXP-06: `unit` این‌جا `'file'` بود، که در فهرست مجاز قرارداد
| نیست. یک `as unknown as` جلوی کامپایلر را گرفته بود و هیچ‌چیز در
| مسیر نوشتن، خروجی را با schema نمی‌سنجید.
*/
const chunk = (id: string) => ({
  id,
  fileId: 'f1',
  unit: 'module',
  content: '',
  startLine: 1,
  endLine: 1,
  tokenEstimate: 0,
}) as unknown as NonNullable<ProjectIndex['vectorChunks']>[number];

function makeIndex(overrides: Partial<ProjectIndex> = {}): ProjectIndex {
  return {
    /*
    | SE-EXP-06: این `'1.0.0'` بود، در حالی که قرارداد `'2.0.0'` را
    | ثابت اعلام کرده. هیچ‌کس متوجه نشده بود چون هیچ‌چیز در مسیر
    | نوشتن، خروجی را با schema نمی‌سنجید. اولین اجرای اعتبارسنجی
    | همین را گرفت.
    */
    schemaVersion: '2.0.0',
    generatorVersion: '0.1.0',
    root: 'fixture',
    generatedAt: '2026-08-18T09:00:00.000Z',
    languages: ['typescript'],
    files: [],
    symbols: [],
    graphs: { callGraph: [], typeGraph: [], dependencyGraph: [], reverseDependencyGraph: [] },
    metrics: {
      totalFiles: 0,
      totalLoc: 0,
      totalSymbols: 0,
      avgCyclomaticComplexity: 0,
      languageBreakdown: {},
    },
    diagnostics: [],
    ...overrides,
  } as ProjectIndex;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-output-'));
});

describe('SE-EXP-06 — اعتبارسنجی قرارداد در مسیر نوشتن', () => {
  it('ایندکس نامعتبر نوشته نمی‌شود', async () => {
    const writer = new OutputWriter({ outputDir: dir, blueprint: false });
    const broken = makeIndex({ schemaVersion: '1.0.0' as ProjectIndex['schemaVersion'] });

    await expect(writer.write(broken)).rejects.toThrow(/schema/i);
    expect(fs.existsSync(path.join(dir, 'project-index.json'))).toBe(false);
  });

  it('می‌شود صریحاً خاموشش کرد', async () => {
    const writer = new OutputWriter({ outputDir: dir, blueprint: false, validate: false });
    const broken = makeIndex({ schemaVersion: '1.0.0' as ProjectIndex['schemaVersion'] });

    await writer.write(broken);
    expect(fs.existsSync(path.join(dir, 'project-index.json'))).toBe(true);
  });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('OutputWriter', () => {

  it('writes the index and the blueprint', async () => {
    const result = await new OutputWriter({ outputDir: dir }).write(makeIndex());

    expect(fs.existsSync(path.join(dir, INDEX_FILE_NAME))).toBe(true);
    expect(fs.existsSync(path.join(dir, BLUEPRINT_FILE_NAME))).toBe(true);
  });

  it('creates the output directory when it is missing', async () => {
    const nested = path.join(dir, 'a', '.semantic-engine');

    await new OutputWriter({ outputDir: nested }).write(makeIndex());

    expect(fs.existsSync(path.join(nested, INDEX_FILE_NAME))).toBe(true);
  });

  /*
  | معیار پذیرش فاز ۱۳، شمرده و نه فرض‌شده.
  */
  it('writes the index exactly once', async () => {
    const recording = new RecordingFileSystem();

    await new OutputWriter({ outputDir: dir, fileSystem: recording }).write(makeIndex());

    const indexWrites = recording.writes.filter(file => file.endsWith(INDEX_FILE_NAME));
    expect(indexWrites).toHaveLength(1);
  });

  it('writes the index once even when it carries vector chunks', async () => {
    const recording = new RecordingFileSystem();
    const index = makeIndex({ vectorChunks: [chunk('v1')] });

    await new OutputWriter({ outputDir: dir, fileSystem: recording }).write(index);

    expect(recording.writes.filter(file => file.endsWith(INDEX_FILE_NAME))).toHaveLength(1);
  });

  /*
  | مسئلهٔ اصلی SE-EXP-02 قابل مشاهده بودنِ حالت میانی بود: ایندکسِ
  | بدون بردار روی دیسک. نوشتن اتمیک یعنی چنین حالتی هرگز دیده
  | نمی‌شود — فایل مقصد یا نسخهٔ قبلی است یا نسخهٔ کامل.
  */
  it('never leaves an index without its vector chunks on disk', async () => {
    const target = path.join(dir, INDEX_FILE_NAME);
    fs.writeFileSync(target, JSON.stringify({ marker: 'previous' }));
    const index = makeIndex({ vectorChunks: [chunk('v1')] });

    const seen: unknown[] = [];
    const watching = new (class extends NodeFileSystem {
      override async writeJsonAtomic(
        filePath: string,
        value: unknown,
        options?: { pretty?: boolean }
      ): Promise<void> {
        if (filePath.endsWith(INDEX_FILE_NAME)) {
          seen.push(JSON.parse(fs.readFileSync(target, 'utf8')));
        }
        return super.writeJsonAtomic(filePath, value, options);
      }
    })();

    await new OutputWriter({ outputDir: dir, fileSystem: watching }).write(index);

    // فقط یک بار نوشته شد، و آنچه پیش از آن روی دیسک بود نسخهٔ قبلی است
    expect(seen).toEqual([{ marker: 'previous' }]);
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).vectorChunks).toHaveLength(1);
  });

  it('leaves no temporary files behind', async () => {
    await new OutputWriter({ outputDir: dir }).write(makeIndex());

    expect(fs.readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('can skip the blueprint', async () => {
    const result = await new OutputWriter({ outputDir: dir, blueprint: false }).write(makeIndex());

    expect(result.blueprintPath).toBeNull();
    expect(fs.existsSync(path.join(dir, BLUEPRINT_FILE_NAME))).toBe(false);
  });

  it('writes only the index and blueprint, and the manifest lists exactly those', async () => {
    await new OutputWriter({ outputDir: dir }).write(makeIndex());

    const manifest = JSON.parse(
      fs.readFileSync(path.join(dir, 'project-artifacts.manifest.json'), 'utf8')
    ) as { artifacts: Record<string, unknown> };
    expect(Object.keys(manifest.artifacts).sort()).toEqual(['blueprint', 'index']);
  });

  it('writes readable json', async () => {
    await new OutputWriter({ outputDir: dir }).write(makeIndex());

    const text = fs.readFileSync(path.join(dir, INDEX_FILE_NAME), 'utf8');
    expect(text).toContain('\n  "schemaVersion"');
    expect(JSON.parse(text).schemaVersion).toBe('2.0.0');
  });

  it('writes compact json when asked', async () => {
    await new OutputWriter({ outputDir: dir, pretty: false }).write(makeIndex());

    expect(fs.readFileSync(path.join(dir, INDEX_FILE_NAME), 'utf8')).not.toContain('\n');
  });

  it('reports the paths it wrote', async () => {
    const result = await new OutputWriter({ outputDir: dir }).write(makeIndex());

    expect(result.indexPath).toBe(path.join(dir, INDEX_FILE_NAME));
    expect(result.blueprintPath).toBe(path.join(dir, BLUEPRINT_FILE_NAME));
  });
});
