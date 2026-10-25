/**
 * `in-root` remains a supported mode (D10) after فاز ۴ flipped the default to
 * `external`: asking for it explicitly must keep producing
 * `<dir>/.semantic-engine/…` exactly as before, and must not write into the
 * data directory.
 *
 * This drives the real command handler, not a copy of it. The external default
 * is covered by `artifactLocationExternal.test.ts`.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseArgs } from '../args';
import { createLoggerFromEnv } from '../../host/Logger';
import { runIndex } from './index-command';

interface IndexJson {
  readonly ok?: boolean;
  readonly indexPath?: string;
  readonly blueprintPath?: string;
}

describe('index — the in-root compatibility mode still works', () => {
  let base: string;
  let dataRoot: string;
  let savedDataDir: string | undefined;
  let savedLocation: string | undefined;

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-index-location-')));
    dataRoot = path.join(base, 'data-dir');
    savedDataDir = process.env['SEMANTIC_ENGINE_DATA_DIR'];
    savedLocation = process.env['SEMANTIC_ENGINE_ARTIFACT_LOCATION'];
    process.env['SEMANTIC_ENGINE_DATA_DIR'] = dataRoot;
    process.env['SEMANTIC_ENGINE_ARTIFACT_LOCATION'] = 'in-root';

    const src = path.join(base, 'app', 'src');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'a.ts'), 'export function hello(): string { return "hi"; }\n');
  });

  afterEach(() => {
    if (savedDataDir === undefined) delete process.env['SEMANTIC_ENGINE_DATA_DIR'];
    else process.env['SEMANTIC_ENGINE_DATA_DIR'] = savedDataDir;
    if (savedLocation === undefined) delete process.env['SEMANTIC_ENGINE_ARTIFACT_LOCATION'];
    else process.env['SEMANTIC_ENGINE_ARTIFACT_LOCATION'] = savedLocation;
    fs.rmSync(base, { recursive: true, force: true });
  });

  const logger = () => createLoggerFromEnv({ SEMANTIC_ENGINE_LOG_LEVEL: 'error' }, { stdio: true });

  it('writes the index and blueprint inside the workspace root when asked for in-root', async () => {
    const root = path.join(base, 'app');
    const result = await runIndex(parseArgs(['index', '--root', root, '--no-git']), {
      cwd: base,
      logger: logger(),
    });

    expect(result.error).toBeUndefined();
    expect(result.code).toBe(0);

    const json = result.json as IndexJson;
    expect(json.ok).toBe(true);
    expect(json.indexPath).toBe(path.join(root, '.semantic-engine', 'project-index.json'));
    expect(fs.existsSync(json.indexPath!)).toBe(true);
    expect(fs.existsSync(path.join(root, '.semantic-engine', 'blueprint.json'))).toBe(true);

    /* Nothing leaks into the data directory while in-root was requested. */
    expect(fs.existsSync(dataRoot)).toBe(false);
  });

  it('still honours an explicit absolute --out', async () => {
    const root = path.join(base, 'app');
    const out = path.join(base, 'elsewhere');

    const result = await runIndex(parseArgs(['index', '--root', root, '--no-git', '--out', out]), {
      cwd: base,
      logger: logger(),
    });

    expect(result.code).toBe(0);
    const json = result.json as IndexJson;
    expect(json.indexPath).toBe(path.join(out, 'project-index.json'));
    expect(fs.existsSync(json.indexPath!)).toBe(true);
    expect(fs.existsSync(path.join(root, '.semantic-engine'))).toBe(false);
  });
});
