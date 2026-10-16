/**
 * فاز ۴, گام ۵ — `doctor` must say where generated data goes and whether an
 * index from before the move is waiting to be copied.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseArgs } from '../args';
import { createLoggerFromEnv } from '../../host/Logger';
import { runDoctor } from './doctor-command';

interface DoctorJson {
  readonly ok: boolean;
  readonly checks: { name: string; ok: boolean; detail: string }[];
}

describe('doctor — data root and artifact status', () => {
  let base: string;
  let root: string;
  let dataRoot: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-doctor-')));
    root = path.join(base, 'app');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    dataRoot = path.join(base, 'data');

    for (const key of ['SEMANTIC_ENGINE_DATA_DIR', 'SEMANTIC_ENGINE_ARTIFACT_LOCATION']) {
      saved[key] = process.env[key];
    }
    process.env['SEMANTIC_ENGINE_DATA_DIR'] = dataRoot;
    delete process.env['SEMANTIC_ENGINE_ARTIFACT_LOCATION'];
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(base, { recursive: true, force: true });
  });

  const doctor = async (extra: string[] = []) => {
    const result = await runDoctor(parseArgs(['doctor', '--root', root, ...extra]), {
      cwd: base,
      logger: createLoggerFromEnv({ SEMANTIC_ENGINE_LOG_LEVEL: 'error' }, { stdio: true }),
    });
    return result.json as DoctorJson;
  };

  const find = (json: DoctorJson, name: string) =>
    json.checks.find(check => check.name === name);

  it('reports the data root and creates it', async () => {
    const json = await doctor();
    const check = find(json, 'data-root');

    expect(check).toBeDefined();
    expect(check!.ok).toBe(true);
    expect(check!.detail).toBe(dataRoot);
    expect(fs.statSync(dataRoot).isDirectory()).toBe(true);
  });

  it('reports a project with no index yet', async () => {
    const json = await doctor();
    const check = find(json, 'artifacts');

    expect(check!.ok).toBe(true);
    expect(check!.detail).toContain('external');
    expect(check!.detail).toContain('no index yet');
  });

  it('reports a legacy index waiting to be copied', async () => {
    const legacy = path.join(root, '.agent', 'semantic');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'project-index.json'), '{"files":[],"symbols":[]}');

    const json = await doctor();
    const check = find(json, 'artifacts');

    expect(check!.detail).toContain(path.join(legacy, 'project-index.json'));
    expect(check!.detail).toContain('copied');
    /* doctor reports; it does not migrate. */
    expect(fs.existsSync(path.join(legacy, 'project-index.json'))).toBe(true);
  });

  it('reports an index that is already in the data directory', async () => {
    const json = await doctor();
    const artifacts = find(json, 'artifacts')!;
    const indexPath = artifacts.detail.split(' — ')[1]!;

    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(indexPath, '{"files":[],"symbols":[]}');

    const after = await doctor();
    expect(find(after, 'artifacts')!.detail).toBe(`external — ${indexPath}`);
  });

  it('follows an explicit --data-dir', async () => {
    const explicit = path.join(base, 'explicit-data');
    const json = await doctor(['--data-dir', explicit]);

    expect(find(json, 'data-root')!.detail).toBe(explicit);
    expect(fs.statSync(explicit).isDirectory()).toBe(true);
  });
});
