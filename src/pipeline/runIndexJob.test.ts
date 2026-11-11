import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { INDEX_LOCK_FILE } from '../gateway/ProjectLock';
import { INDEX_FILE_NAME } from './OutputWriter';
import { IndexBusyError, readIndexCheck, runIndexJob } from './runIndexJob';

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

  describe('the run checks itself', () => {
    const indexFile = () => path.join(outputDir, INDEX_FILE_NAME);
    const rebuildNotes = () => {
      const notes: string[] = [];
      return { notes, progress: { report: (u: { message?: string }) => void (u.message?.startsWith('Rebuilding from scratch') && notes.push(u.message)) } };
    };

    it('leaves a healthy project alone: no rebuild, a clean record', async () => {
      await job();
      const spy = rebuildNotes();
      const second = await runIndexJob({ workspaceRoot: root, outputDir, git: false, progress: spy.progress });
      expect(spy.notes).toEqual([]);
      expect(second.check).toMatchObject({ ok: true, autoRebuilt: false });
      expect(readIndexCheck(outputDir)).toMatchObject({ ok: true, autoRebuilt: false });
    });

    it('starts from zero by itself when the previous index cannot be read', async () => {
      await job();
      fs.writeFileSync(indexFile(), '{ this is not json');
      const spy = rebuildNotes();
      const result = await runIndexJob({ workspaceRoot: root, outputDir, git: false, progress: spy.progress });
      expect(spy.notes[0]).toMatch(/could not be read/);
      expect(result.check).toMatchObject({ autoRebuilt: true, ok: true });
      expect(((result.extractionCache as { hits: number }).hits)).toBe(0);
      expect(JSON.parse(fs.readFileSync(indexFile(), 'utf8')).files).toHaveLength(1);
    });

    it('starts from zero by itself when the previous index contradicts itself', async () => {
      await job();
      const broken = JSON.parse(fs.readFileSync(indexFile(), 'utf8'));
      broken.symbols[0].fileId = 'a-file-that-is-gone';
      fs.writeFileSync(indexFile(), JSON.stringify(broken));
      const spy = rebuildNotes();
      const result = await runIndexJob({ workspaceRoot: root, outputDir, git: false, progress: spy.progress });
      expect(spy.notes[0]).toMatch(/inconsistent/);
      expect(result.check).toMatchObject({ autoRebuilt: true, ok: true });
    });

    it('does not keep rebuilding for a problem a rebuild did not clear', async () => {
      await job();
      fs.writeFileSync(
        path.join(outputDir, 'index-check.json'),
        JSON.stringify({ checkedAt: '', ok: false, autoRebuilt: true, reason: 'x', issues: [{ code: 'orphan-symbols', severity: 'rebuild', message: 'm' }] })
      );
      fs.writeFileSync(indexFile(), '{ broken');
      const spy = rebuildNotes();
      await runIndexJob({ workspaceRoot: root, outputDir, git: false, progress: spy.progress }).catch(() => undefined);
      expect(spy.notes).toEqual([]);
    });
  });
});
