/**
 * فاز ۳ — with `SEMANTIC_ENGINE_ARTIFACT_LOCATION=external` the real CLI must
 * write everything under the data directory and leave the checkout untouched.
 *
 * This drives `runIndex` itself (the same handler `semantic-engine index`
 * calls), not a copy of its logic.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseArgs } from '../args';
import { createLoggerFromEnv } from '../../host/Logger';
import { runIndex } from './index-command';
import { projectIdFor } from '../../core/config/ProjectIdentity';

interface IndexJson {
  readonly ok?: boolean;
  readonly indexPath?: string;
  readonly blueprintPath?: string;
  readonly artifactRoot?: string;
  readonly artifactLocation?: string;
  readonly migratedFrom?: string;
  readonly migrationMode?: string;
}

describe('index — external artifact location', () => {
  let base: string;
  let root: string;
  let dataRoot: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-index-external-')));
    root = path.join(base, 'app');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    dataRoot = path.join(base, 'data');

    for (const key of ['SEMANTIC_ENGINE_ARTIFACT_LOCATION', 'SEMANTIC_ENGINE_DATA_DIR']) {
      saved[key] = process.env[key];
    }
    process.env['SEMANTIC_ENGINE_ARTIFACT_LOCATION'] = 'external';
    process.env['SEMANTIC_ENGINE_DATA_DIR'] = dataRoot;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(base, { recursive: true, force: true });
  });

  const index = async (extra: string[] = []) => {
    const result = await runIndex(parseArgs(['index', '--root', root, '--no-git', ...extra]), {
      cwd: base,
      logger: createLoggerFromEnv({ SEMANTIC_ENGINE_LOG_LEVEL: 'error' }, { stdio: true }),
    });
    expect(result.error).toBeUndefined();
    expect(result.code).toBe(0);
    return result.json as IndexJson;
  };

  it('writes nothing into the checkout', async () => {
    const json = await index();
    const projectId = projectIdFor('app', root);

    expect(json.artifactLocation).toBe('external');
    expect(json.artifactRoot).toBe(path.join(dataRoot, 'projects', projectId));
    expect(json.indexPath).toBe(path.join(dataRoot, 'projects', projectId, 'project-index.json'));
    expect(json.blueprintPath).toBe(path.join(dataRoot, 'projects', projectId, 'blueprint.json'));

    expect(fs.existsSync(json.indexPath!)).toBe(true);
    expect(fs.existsSync(json.blueprintPath!)).toBe(true);
    expect(fs.existsSync(path.join(dataRoot, 'projects', projectId, 'project-artifacts.manifest.json'))).toBe(true);

    /* The acceptance criterion: the source tree stays exactly as it was. */
    expect(fs.readdirSync(root)).toEqual(['src']);
  });

  it('migrates an existing legacy index and keeps the original', async () => {
    const legacyDir = path.join(root, '.semantic-engine');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyDir, 'project-index.json'),
      JSON.stringify({ schemaVersion: 1, generatedAt: '2026-08-01T00:00:00.000Z', files: [], symbols: [] })
    );
    fs.writeFileSync(path.join(legacyDir, 'blueprint.json'), '{"modules":[]}');

    const json = await index();

    expect(json.migratedFrom).toBe(legacyDir);
    expect(json.migrationMode).toBe('copy-readonly-legacy');
    /* Legacy is never deleted. */
    expect(fs.existsSync(path.join(legacyDir, 'project-index.json'))).toBe(true);
    expect(fs.existsSync(path.join(legacyDir, 'blueprint.json'))).toBe(true);
  });

  it('still lets an explicit --out win', async () => {
    const out = path.join(base, 'elsewhere');
    const json = await index(['--out', out]);

    expect(json.indexPath).toBe(path.join(out, 'project-index.json'));
    expect(fs.existsSync(json.indexPath!)).toBe(true);
    expect(fs.existsSync(path.join(root, '.semantic-engine'))).toBe(false);
    expect(fs.existsSync(dataRoot)).toBe(false);
  });

  it('honours an explicit --project-id', async () => {
    const json = await index(['--project-id', 'prj-explicit-00000000']);
    expect(json.artifactRoot).toBe(path.join(dataRoot, 'projects', 'prj-explicit-00000000'));
    expect(fs.readdirSync(root)).toEqual(['src']);
  });
});
