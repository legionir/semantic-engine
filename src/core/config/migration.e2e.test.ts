/**
 * Legacy migration end-to-end — فاز ۱۴, گام ۴.
 *
 * Indexes written before the data-directory move live inside the checkout, in
 * one of three places. The rule being tested: they are **copied**, never moved,
 * the original survives, and every later write goes to the data directory. A
 * corrupt legacy index degrades to `corrupt-legacy` instead of taking the
 * command down.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseArgs } from '../../cli/args';
import { createLoggerFromEnv } from '../../host/Logger';
import { runIndex } from '../../cli/commands/index-command';
import { migrateLegacyArtifacts } from './migrateLegacyArtifacts';
import { resolveDataRoot } from './DataRootResolver';

const LEGACY_LAYOUTS = ['.semantic-engine', path.join('.agent', 'semantic'), 'semantic'];

interface IndexJson {
  indexPath?: string;
  migratedFrom?: string;
  migrationMode?: string;
  artifactLocation?: string;
}

describe('legacy artifact migration', () => {
  let base: string;
  let root: string;
  let dataRoot: string;

  const makeWorkspace = (): void => {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function a(): number { return 1; }\n');
  };

  const writeLegacy = (layout: string, body: string): string => {
    const dir = path.join(root, layout);
    fs.mkdirSync(dir, { recursive: true });
    const indexPath = path.join(dir, 'project-index.json');
    fs.writeFileSync(indexPath, body);
    fs.writeFileSync(path.join(dir, 'blueprint.json'), '{"modules":[]}');
    return dir;
  };

  const index = async (): Promise<IndexJson> => {
    const result = await runIndex(
      parseArgs([
        'index',
        '--root',
        root,
        '--no-git',
        '--data-dir',
        dataRoot,
        '--project-id',
        'prj-app-12345678',
      ]),
      {
        cwd: base,
        logger: createLoggerFromEnv({ SEMANTIC_ENGINE_LOG_LEVEL: 'error' }, { stdio: true }),
      }
    );
    expect(result.code).toBe(0);
    return (result.json ?? {}) as IndexJson;
  };

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-migration-')));
    root = path.join(base, 'app');
    dataRoot = path.join(base, 'data');
    makeWorkspace();
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it.each(LEGACY_LAYOUTS)('copies a legacy index from %s and keeps the original', async layout => {
    const legacyDir = writeLegacy(
      layout,
      JSON.stringify({ schemaVersion: '1.0', generatedAt: '2026-01-01T00:00:00.000Z', files: [], symbols: [] })
    );

    const migration = migrateLegacyArtifacts({
      workspaceRoot: root,
      projectId: 'prj-app-12345678',
      dataRoot,
      location: 'external',
    });

    expect(migration.status).toBe('migrated');
    expect(migration.from).toBe(legacyDir);
    expect(migration.copied).toEqual(
      expect.arrayContaining(['project-index.json', 'blueprint.json'])
    );

    /* The original is never deleted. */
    expect(fs.existsSync(path.join(legacyDir, 'project-index.json'))).toBe(true);
    expect(fs.existsSync(path.join(legacyDir, 'blueprint.json'))).toBe(true);

    /* And a manifest records where it came from. */
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(dataRoot, 'projects', 'prj-app-12345678', 'migration.json'),
        'utf8'
      )
    ) as Record<string, unknown>;
    expect(manifest['migratedFrom']).toBe(legacyDir);
    expect(manifest['migrationMode']).toBe('copy-readonly-legacy');
  });

  it('writes only to the data directory after migrating', async () => {
    writeLegacy('.semantic-engine', '{"not":"valid json"');

    /*
    | A corrupt legacy index must not stop the run: the migration reports it,
    | and indexing simply produces a fresh index in the data directory.
    */
    const migration = migrateLegacyArtifacts({
      workspaceRoot: root,
      projectId: 'prj-app-12345678',
      dataRoot,
      location: 'external',
    });
    expect(migration.status).toBe('corrupt-legacy');
    expect(migration.migrated).toBe(false);

    const json = await index();
    expect(json.artifactLocation).toBe('external');
    expect(json.indexPath).toBe(
      path.join(dataRoot, 'projects', 'prj-app-12345678', 'project-index.json')
    );
    expect(fs.existsSync(json.indexPath as string)).toBe(true);

    /* Nothing new appeared inside the checkout. */
    expect(fs.readdirSync(root).sort()).toEqual(['.semantic-engine', 'src']);
  });

  it('prefers the data directory once it has an index', async () => {
    writeLegacy(
      '.agent/semantic',
      JSON.stringify({ schemaVersion: '1.0', generatedAt: '2026-01-01T00:00:00.000Z', files: [], symbols: [] })
    );

    const first = migrateLegacyArtifacts({
      workspaceRoot: root,
      projectId: 'prj-app-12345678',
      dataRoot,
      location: 'external',
    });
    expect(first.status).toBe('migrated');

    const second = migrateLegacyArtifacts({
      workspaceRoot: root,
      projectId: 'prj-app-12345678',
      dataRoot,
      location: 'external',
    });
    expect(second.status).toBe('external-already');
    expect(second.migrated).toBe(false);
  });

  it('does nothing at all while the location is in-root', async () => {
    const legacyDir = writeLegacy('.semantic-engine', '{"schemaVersion":"1.0"}');

    const migration = migrateLegacyArtifacts({
      workspaceRoot: root,
      projectId: 'prj-app-12345678',
      dataRoot,
      location: 'in-root',
    });

    expect(migration.status).toBe('skipped');
    expect(fs.existsSync(dataRoot)).toBe(false);
    expect(fs.existsSync(legacyDir)).toBe(true);
  });

  it('resolves the data root per platform', () => {
    expect(
      resolveDataRoot({ platform: 'linux', homeDir: '/home/u', env: {} })
    ).toBe('/home/u/.local/share/semantic-engine');
    expect(
      resolveDataRoot({ platform: 'darwin', homeDir: '/Users/u', env: {} })
    ).toBe(path.join('/Users/u', 'Library', 'Application Support', 'SemanticEngine'));
    expect(
      resolveDataRoot({
        platform: 'win32',
        homeDir: 'C:\\Users\\u',
        env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
      })
    ).toBe('C:\\Users\\u\\AppData\\Local\\SemanticEngine');
  });
});
