import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { INDEX_LOCK_FILE } from '../gateway/ProjectLock';
import { INDEX_FILE_NAME } from './OutputWriter';
import { IndexBusyError, runIndexJob } from './runIndexJob';

describe('runIndexJob', () => {
  let root: string;
  let outputDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'se-indexjob-'));
    outputDir = path.join(root, 'out');
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function alpha(): number {\n  return 1;\n}\n');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const job = () => runIndexJob({ workspaceRoot: root, outputDir, git: false });

  it('writes the index, reports counts and releases the lock', async () => {
    const result = await job();
    expect(result.files).toBe(1);
    expect(result.symbols).toBeGreaterThan(0);
    expect(result.indexPath).toBe(path.join(outputDir, INDEX_FILE_NAME));
    expect(fs.existsSync(result.indexPath)).toBe(true);
    expect(fs.existsSync(path.join(outputDir, INDEX_LOCK_FILE))).toBe(false);
  });

  it('refuses a second run on the same project while one is in progress', async () => {
    const first = job();
    await expect(job()).rejects.toBeInstanceOf(IndexBusyError);
    await first;
    /* and runs again once the first has finished */
    await expect(job()).resolves.toMatchObject({ files: 1 });
  });

  it('takes over the lock of a process that no longer exists', async () => {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputDir, INDEX_LOCK_FILE),
      JSON.stringify({ projectId: 'out', pid: 2 ** 22 + 12345, kind: 'index', acquiredAt: '', heartbeatAt: new Date().toISOString() })
    );
    await expect(job()).resolves.toMatchObject({ files: 1 });
  });

  it('reuses the extraction cache on the next run unless told to rebuild', async () => {
    await job();
    const reused = (await job()).extractionCache as { hits: number };
    expect(reused.hits).toBe(1);
    const rebuilt = (await runIndexJob({ workspaceRoot: root, outputDir, git: false, cache: 'rebuild' })).extractionCache as { hits: number };
    expect(rebuilt.hits).toBe(0);
  });

  it('an update re-embeds nothing that is unchanged; a rebuild re-embeds everything', async () => {
    let embedded = 0;
    const generator = {
      modelName: 'counting',
      isReady: async () => true,
      generate: async () => ({ embedding: [1, 2], model: 'counting', dimensions: 2 }),
      generateBatch: async (texts: readonly string[]) => {
        embedded += texts.length;
        return texts.map(() => ({ embedding: [1, 2], model: 'counting', dimensions: 2 }));
      },
      dispose: async () => {},
    };
    const run = (cache?: 'rebuild') =>
      runIndexJob({ workspaceRoot: root, outputDir, git: false, embeddingGenerator: generator, ...(cache ? { cache } : {}) });

    const first = await run();
    const firstCount = embedded;
    expect(first.vectorChunks).toBeGreaterThan(0);
    expect(firstCount).toBe(first.vectorChunks);

    embedded = 0;
    await run();
    expect(embedded).toBe(0);

    embedded = 0;
    const rebuilt = await run('rebuild');
    expect(embedded).toBe(rebuilt.vectorChunks);
  });
});
