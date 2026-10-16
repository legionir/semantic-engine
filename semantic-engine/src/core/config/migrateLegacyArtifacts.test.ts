import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  MIGRATION_FILE,
  MIGRATION_MODE_COPY_READONLY,
  migrateLegacyArtifacts,
} from './migrateLegacyArtifacts';
import { PROJECT_INDEX_FILE, BLUEPRINT_FILE, SQLITE_FILE } from './ProjectPaths';
import { projectIdFor } from './ProjectIdentity';

const PROJECT_ID = 'prj-app-12345678';

function writeLegacy(root: string, legacyDir: string, indexBody = '{}'): string {
  const dir = path.join(root, legacyDir);
  fs.mkdirSync(dir, { recursive: true });
  const indexPath = path.join(dir, PROJECT_INDEX_FILE);
  fs.writeFileSync(indexPath, indexBody);
  return dir;
}

describe('migrateLegacyArtifacts — copy, never delete', () => {
  let base: string;
  let root: string;
  let dataRoot: string;

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-migration-')));
    root = path.join(base, 'app');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    dataRoot = path.join(base, 'data');
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const run = (extra: Partial<Parameters<typeof migrateLegacyArtifacts>[0]> = {}) =>
    migrateLegacyArtifacts({
      workspaceRoot: root,
      projectId: PROJECT_ID,
      location: 'external',
      dataRoot,
      now: () => new Date(Date.UTC(2026, 7, 26, 12, 0, 0)),
      ...extra,
    });

  const artifactRoot = () => path.join(dataRoot, 'projects', PROJECT_ID);

  it('does nothing while the default location is in-root', () => {
    writeLegacy(root, path.join('.semantic-engine'));
    const result = run({ location: 'in-root' });

    expect(result.status).toBe('skipped');
    expect(result.migrated).toBe(false);
    expect(fs.existsSync(dataRoot)).toBe(false);
  });

  it.each([
    ['.semantic-engine', 'canonical'],
    [path.join('.agent', 'semantic'), 'structured-ai sidecar'],
    ['semantic', 'flat'],
  ])('copies from the legacy location %s (%s) and keeps the original', (legacyDir) => {
    const legacy = writeLegacy(root, legacyDir, '{"generatedAt":"2026-08-01T00:00:00.000Z"}');
    fs.writeFileSync(path.join(legacy, BLUEPRINT_FILE), '{"modules":[]}');
    fs.writeFileSync(path.join(legacy, SQLITE_FILE), 'not really sqlite');

    const result = run();

    expect(result.status).toBe('migrated');
    expect(result.migrated).toBe(true);
    expect(result.from).toBe(legacy);
    expect(result.to).toBe(artifactRoot());
    expect(result.copied).toEqual(
      expect.arrayContaining([PROJECT_INDEX_FILE, BLUEPRINT_FILE, SQLITE_FILE])
    );

    /* Copied… */
    expect(fs.existsSync(path.join(artifactRoot(), PROJECT_INDEX_FILE))).toBe(true);
    expect(fs.existsSync(path.join(artifactRoot(), BLUEPRINT_FILE))).toBe(true);
    expect(fs.existsSync(path.join(artifactRoot(), SQLITE_FILE))).toBe(true);

    /* …and the legacy files are untouched. */
    expect(fs.existsSync(path.join(legacy, PROJECT_INDEX_FILE))).toBe(true);
    expect(fs.existsSync(path.join(legacy, BLUEPRINT_FILE))).toBe(true);

    const record = JSON.parse(
      fs.readFileSync(path.join(artifactRoot(), MIGRATION_FILE), 'utf8')
    ) as Record<string, unknown>;
    expect(record['migratedFrom']).toBe(legacy);
    expect(record['migrationMode']).toBe(MIGRATION_MODE_COPY_READONLY);
    expect(record['migratedAt']).toBe('2026-08-26T12:00:00.000Z');
  });

  it('prefers the canonical legacy location over the older ones', () => {
    writeLegacy(root, 'semantic', '{"from":"flat"}');
    const canonical = writeLegacy(root, '.semantic-engine', '{"from":"canonical"}');

    const result = run();
    expect(result.from).toBe(canonical);
    expect(
      JSON.parse(fs.readFileSync(path.join(artifactRoot(), PROJECT_INDEX_FILE), 'utf8'))['from']
    ).toBe('canonical');
  });

  it('is a no-op once the external index exists', () => {
    const legacy = writeLegacy(root, '.semantic-engine');
    run();

    const second = run();
    expect(second.status).toBe('external-already');
    expect(second.migrated).toBe(false);
    /* The copy is not repeated over a newer external index. */
    expect(fs.existsSync(legacy)).toBe(true);
  });

  it('reports no-legacy when there is nothing to migrate', () => {
    const result = run();
    expect(result.status).toBe('no-legacy');
    expect(result.migrated).toBe(false);
    expect(fs.existsSync(dataRoot)).toBe(false);
  });

  it('downgrades a corrupt legacy index instead of throwing', () => {
    const legacy = writeLegacy(root, '.semantic-engine', '{ this is not json');

    const result = run();
    expect(result.status).toBe('corrupt-legacy');
    expect(result.migrated).toBe(false);
    expect(result.from).toBe(legacy);
    expect(result.error).toBeTruthy();
    /* Nothing half-written into the data directory. */
    expect(fs.existsSync(path.join(artifactRoot(), PROJECT_INDEX_FILE))).toBe(false);
    expect(fs.existsSync(legacy)).toBe(true);
  });

  it('derives the same destination for the same project', () => {
    const derived = projectIdFor('app', fs.realpathSync(root));
    const first = run({ projectId: derived });
    writeLegacy(root, '.semantic-engine');
    const second = migrateLegacyArtifacts({
      workspaceRoot: root,
      projectId: derived,
      location: 'external',
      dataRoot,
    });

    expect(first.to).toBe(path.join(dataRoot, 'projects', derived));
    expect(second.to).toBe(first.to);
  });
});
