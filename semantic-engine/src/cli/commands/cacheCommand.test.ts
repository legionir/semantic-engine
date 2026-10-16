/**
 * `semantic-engine cache` — فاز ۱۳.
 *
 * The point of these tests is the safety rule, not the convenience: the command
 * removes generated data and never anything that belongs to a checkout.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseArgs } from '../args';
import { createLoggerFromEnv } from '../../host/Logger';
import { runCache } from './cache-command';

interface CacheJson {
  ok?: boolean;
  dryRun?: boolean;
  dataRoot?: string;
  totalBytes?: number;
  projects?: { projectId: string; bytes: number; files: number; indexBytes: number }[];
  removed?: string[];
  refused?: string[];
  wouldRemove?: string[];
  from?: string;
  to?: string;
  files?: number;
}

describe('semantic-engine cache', () => {
  let base: string;
  let dataRoot: string;
  let workspace: string;

  const makeProject = (projectId: string, olderThanMs = 0): string => {
    const dir = path.join(dataRoot, 'projects', projectId);
    fs.mkdirSync(dir, { recursive: true });
    const indexPath = path.join(dir, 'project-index.json');
    fs.writeFileSync(indexPath, JSON.stringify({ schemaVersion: '1.0', files: [], symbols: [] }));
    fs.writeFileSync(path.join(dir, 'blueprint.json'), '{"modules":[]}');
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ projectId, name: projectId, rootPath: workspace })
    );
    if (olderThanMs > 0) {
      const past = new Date(Date.now() - olderThanMs);
      fs.utimesSync(indexPath, past, past);
    }
    return dir;
  };

  const run = async (...argv: string[]): Promise<{ code: number; json: CacheJson; error?: string }> => {
    const result = await runCache(parseArgs(['cache', ...argv]), {
      cwd: base,
      logger: createLoggerFromEnv({ SEMANTIC_ENGINE_LOG_LEVEL: 'error' }, { stdio: true }),
    });
    return { code: result.code, json: (result.json ?? {}) as CacheJson, error: result.error };
  };

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-cache-')));
    dataRoot = path.join(base, 'data');
    workspace = path.join(base, 'app');
    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'src', 'a.ts'), 'export const a = 1;\n');
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(
      path.join(dataRoot, 'registry.json'),
      JSON.stringify({ version: 1, projects: [{ id: 'prj-a-11111111', rootPath: workspace }] })
    );
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('lists what is cached and how big it is', async () => {
    makeProject('prj-a-11111111');
    makeProject('prj-b-22222222');

    const result = await run('list', '--data-dir', dataRoot);

    expect(result.code).toBe(0);
    expect(result.json.dataRoot).toBe(dataRoot);
    expect(result.json.projects).toHaveLength(2);
    expect((result.json.totalBytes ?? 0)).toBeGreaterThan(0);
    for (const entry of result.json.projects ?? []) {
      expect(entry.files).toBeGreaterThan(0);
      expect(entry.indexBytes).toBeGreaterThan(0);
    }
  });

  it('cleans one project and leaves everything else alone', async () => {
    const dirA = makeProject('prj-a-11111111');
    const dirB = makeProject('prj-b-22222222');

    const result = await run('clean', '--project', 'prj-a-11111111', '--data-dir', dataRoot);

    expect(result.code).toBe(0);
    expect(result.json.removed).toEqual(['prj-a-11111111']);
    expect(fs.existsSync(dirA)).toBe(false);
    expect(fs.existsSync(dirB)).toBe(true);

    /* The source tree is never touched. */
    expect(fs.existsSync(path.join(workspace, 'src', 'a.ts'))).toBe(true);
    expect(fs.readdirSync(workspace).sort()).toEqual(['src']);
  });

  it('dry-runs --older-than unless --force is passed', async () => {
    makeProject('prj-old-33333333', 10 * 86_400_000);
    makeProject('prj-new-44444444');

    const dry = await run('clean', '--older-than', '1d', '--data-dir', dataRoot);
    expect(dry.code).toBe(0);
    expect(dry.json.dryRun).toBe(true);
    expect(dry.json.wouldRemove).toEqual(['prj-old-33333333']);
    expect(fs.existsSync(path.join(dataRoot, 'projects', 'prj-old-33333333'))).toBe(true);

    const forced = await run('clean', '--older-than', '1d', '--force', '--data-dir', dataRoot);
    expect(forced.json.removed).toEqual(['prj-old-33333333']);
    expect(fs.existsSync(path.join(dataRoot, 'projects', 'prj-old-33333333'))).toBe(false);
    expect(fs.existsSync(path.join(dataRoot, 'projects', 'prj-new-44444444'))).toBe(true);
  });

  it('refuses a target that overlaps a registered workspace', async () => {
    /*
    | A pathological registry entry: a "workspace" that is the cache directory
    | itself. The guard must refuse rather than delete a checkout.
    */
    const dir = makeProject('prj-a-11111111');
    fs.writeFileSync(
      path.join(dataRoot, 'registry.json'),
      JSON.stringify({ version: 1, projects: [{ id: 'prj-a-11111111', rootPath: dir }] })
    );

    const result = await run('clean', '--project', 'prj-a-11111111', '--data-dir', dataRoot);

    expect(result.code).toBe(0);
    expect(result.json.removed).toEqual([]);
    expect(result.json.refused?.[0]).toMatch(/overlaps the registered workspace/);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('refuses to clean outside the data directory', async () => {
    const result = await run('clean', '--project', '..', '--data-dir', dataRoot);
    expect(result.code).toBe(0);
    expect(result.json.removed ?? []).toEqual([]);
    expect(fs.existsSync(workspace)).toBe(true);
  });

  it('needs a selector for clean', async () => {
    const result = await run('clean', '--data-dir', dataRoot);
    expect(result.code).toBe(2);
    expect(result.error).toMatch(/needs --project|--older-than/);
  });

  it('exports and imports a project', async () => {
    makeProject('prj-a-11111111');
    const exportDir = path.join(base, 'export');

    const exported = await run('export', '--project', 'prj-a-11111111', '--to', exportDir, '--data-dir', dataRoot);
    expect(exported.code).toBe(0);
    expect(exported.json.files).toBe(3);
    expect(fs.existsSync(path.join(exportDir, 'prj-a-11111111', 'project-index.json'))).toBe(true);

    const imported = await run(
      'import',
      '--project',
      'prj-c-55555555',
      '--from',
      path.join(exportDir, 'prj-a-11111111'),
      '--data-dir',
      dataRoot
    );
    expect(imported.code).toBe(0);
    expect(imported.json.files).toBe(3);
    expect(
      fs.existsSync(path.join(dataRoot, 'projects', 'prj-c-55555555', 'project-index.json'))
    ).toBe(true);
  });

  it('rejects an unknown subcommand', async () => {
    const result = await run('vacuum', '--data-dir', dataRoot);
    expect(result.code).toBe(2);
    expect(result.error).toMatch(/unknown cache subcommand/);
  });
});
