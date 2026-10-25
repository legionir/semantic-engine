/**
 * Phase 0 — atomic publication of the artifact set.
 *
 * `FileSystemPort.writeFileAtomic` already guarantees that no *single* file is
 * ever torn (temp + fsync + rename, tested in `host/FileSystem.test.ts`). This
 * suite tests the thing above it: the published *set* — `project-index.json`
 * plus `project-artifacts.manifest.json`, whose `artifacts.index.sha256` is
 * supposed to describe the index beside it.
 *
 * Three properties are executed here:
 *
 *   1. a successful publish is coherent — the manifest digest matches the bytes
 *      of the index that was written;
 *   2. a concurrent reader never observes a partial index, no matter how often
 *      the writer replaces it;
 *   3. two writers publishing the same directory leave one *whole* revision.
 *
 * And one gap is pinned by execution rather than by prose (SE-P0-PUB-01):
 * `write()` writes the index first and the manifest second, so an interruption
 * between the two leaves a new index next to an old manifest. The test named
 * for that gap asserts the measured behaviour so the gap cannot be forgotten,
 * and the suite also asserts the recovery path — the next successful publish
 * repairs the pair and leaves no temporary file behind.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MANIFEST_FILE_NAME, OutputWriter } from './OutputWriter';
import { NodeFileSystem } from '../host/FileSystem';
import { ProjectIndex } from '../core/types/project-index.types';
import { IndexPipeline } from './IndexPipeline';
import { createExtractors, ExtractorSet } from './ExtractorFactory';

const INDEX_FILE = 'project-index.json';

let outputDir: string;
let workspace: string;
let extractors: ExtractorSet;

/** A schema-valid index produced by the real pipeline, reused for publications. */
async function realIndex(marker: string): Promise<ProjectIndex> {
  const { projectIndex } = await new IndexPipeline({
    workspaceRoot: workspace,
    outputPath: path.join(outputDir, INDEX_FILE),
    symbolExtractors: extractors.symbols,
    dependencyExtractors: extractors.dependencies,
    scannerConfig: { skipHiddenDirectories: false },
    gitCollector: null,
    vectorIndexer: null,
  }).run();
  return { ...projectIndex, root: marker };
}

function writer(fileSystem = new NodeFileSystem()): OutputWriter {
  return new OutputWriter({ outputDir, fileSystem, pretty: false, blueprint: false });
}

function digest(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function manifestOf(): { indexGeneration?: number; artifacts?: { index?: { sha256?: string } } } {
  return JSON.parse(fs.readFileSync(path.join(outputDir, MANIFEST_FILE_NAME), 'utf8'));
}

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'se-publication-ws-'));
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-publication-out-'));
  extractors = createExtractors({ workspaceRoot: workspace });
  fs.writeFileSync(path.join(workspace, 'a.ts'), 'export function a(): void {}\n');
});

afterEach(() => {
  extractors.dispose();
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(outputDir, { recursive: true, force: true });
});

describe('Phase 0 — a successful publish is coherent', () => {
  test('the manifest digest describes the index that is on disk', async () => {
    const index = await realIndex('marker-1');
    await writer().write(index);

    expect(fs.existsSync(path.join(outputDir, INDEX_FILE))).toBe(true);
    expect(digest(path.join(outputDir, INDEX_FILE))).toBe(manifestOf().artifacts?.index?.sha256);
    expect(manifestOf().indexGeneration).toBeGreaterThanOrEqual(1);
  });

  test('the generation counter moves forward on every publish', async () => {
    await writer().write(await realIndex('marker-1'));
    const first = manifestOf().indexGeneration!;
    await writer().write(await realIndex('marker-2'));
    const second = manifestOf().indexGeneration!;
    expect(second).toBeGreaterThan(first);
  });

  test('the directory holds no temporary file after a publish', async () => {
    await writer().write(await realIndex('marker-1'));
    const leftovers = fs.readdirSync(outputDir).filter(name => name.includes('.tmp') || name.startsWith('.'));
    expect(leftovers).toEqual([]);
  });
});

describe('Phase 0 — a reader never sees a torn index', () => {
  test('every observed revision parses, while the writer replaces it repeatedly', async () => {
    const first = await realIndex('rev-0');
    await writer().write(first);

    const observed: string[] = [];
    let reading = true;
    const reader = (async () => {
      while (reading) {
        try {
          const raw = fs.readFileSync(path.join(outputDir, INDEX_FILE), 'utf8');
          const parsed = JSON.parse(raw) as ProjectIndex;
          observed.push(parsed.root);
        } catch (error) {
          /* A missing file is fine; a broken one is not and fails the test. */
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await new Promise(resolve => setImmediate(resolve));
      }
    })();

    for (let revision = 1; revision <= 12; revision += 1) {
      await writer().write({ ...first, root: `rev-${revision}` });
    }
    reading = false;
    await reader;

    expect(observed.length).toBeGreaterThan(0);
    for (const root of observed) expect(root).toMatch(/^rev-\d+$/u);
    expect(observed).toContain('rev-12');
  });
});

describe('Phase 0 — two writers on the same directory', () => {
  test('the surviving index is one writer’s revision, never a mixture', async () => {
    const left = await realIndex('writer-left');
    const right = await realIndex('writer-right');

    await Promise.all([writer().write(left), writer().write(right)]);

    const published = JSON.parse(fs.readFileSync(path.join(outputDir, INDEX_FILE), 'utf8')) as ProjectIndex;
    expect(['writer-left', 'writer-right']).toContain(published.root);
    expect(published.files.map(file => file.path)).toEqual(left.files.map(file => file.path));
    expect(fs.readdirSync(outputDir).filter(name => name.includes('.tmp'))).toEqual([]);
  });
});

describe('Phase 0 — an interruption between index and manifest (SE-P0-PUB-01)', () => {
  class FailManifestWrite extends NodeFileSystem {
    override async writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
      if (path.basename(filePath) === MANIFEST_FILE_NAME) {
        throw new Error('simulated interruption before the manifest was written');
      }
      return super.writeJsonAtomic(filePath, value);
    }
  }

  test('measured behaviour: the index moves on and the manifest still describes the previous one', async () => {
    await writer().write(await realIndex('before-crash'));
    const digestBefore = manifestOf().artifacts?.index?.sha256;

    await expect(writer(new FailManifestWrite()).write(await realIndex('after-crash'))).rejects.toThrow(
      /simulated interruption/u
    );

    const published = JSON.parse(fs.readFileSync(path.join(outputDir, INDEX_FILE), 'utf8')) as ProjectIndex;
    /* The index already carries the new revision ... */
    expect(published.root).toBe('after-crash');
    /* ... while the manifest still carries the digest of the previous one. */
    expect(manifestOf().artifacts?.index?.sha256).toBe(digestBefore);
    expect(digest(path.join(outputDir, INDEX_FILE))).not.toBe(digestBefore);
  });

  test('the next successful publish repairs the pair and leaves no temporary file', async () => {
    await writer().write(await realIndex('before-crash'));
    await expect(writer(new FailManifestWrite()).write(await realIndex('after-crash'))).rejects.toThrow();

    await writer().write(await realIndex('repaired'));

    expect(digest(path.join(outputDir, INDEX_FILE))).toBe(manifestOf().artifacts?.index?.sha256);
    expect(fs.readdirSync(outputDir).filter(name => name.includes('.tmp'))).toEqual([]);
  });
});
