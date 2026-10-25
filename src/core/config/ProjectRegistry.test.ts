import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PROJECT_MANIFEST_FILE, REGISTRY_FILE, ProjectRegistry } from './ProjectRegistry';
import { projectIdFor } from './ProjectIdentity';

function makeProject(base: string, ...parts: string[]): string {
  const root = path.join(base, ...parts);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  return fs.realpathSync(root);
}

describe('ProjectRegistry — stable identity, canonical root as the unique key', () => {
  let base: string;
  let dataRoot: string;
  let clock: number;
  const now = () => new Date(clock);

  function registry(): ProjectRegistry {
    return new ProjectRegistry({ dataRoot, now });
  }

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-registry-')));
    dataRoot = path.join(base, 'data');
    clock = Date.UTC(2026, 7, 26, 12, 0, 0);
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('gives two projects named `app` distinct ids and keeps both', () => {
    /* The regression the plan audit measured: both used to collapse into one. */
    const clientA = makeProject(base, 'client-a', 'app');
    const clientB = makeProject(base, 'client-b', 'app');

    const reg = registry();
    const a = reg.register({ rootPath: clientA, name: 'app' });
    const b = reg.register({ rootPath: clientB, name: 'app' });

    expect(a.id).not.toBe(b.id);
    expect(a.id).toBe(projectIdFor('app', clientA));
    expect(reg.list()).toHaveLength(2);
    expect(reg.get(a.id)?.rootPath).toBe(clientA);
    expect(reg.get(b.id)?.rootPath).toBe(clientB);
  });

  it('returns the existing record for a repeated root instead of creating one', () => {
    const root = makeProject(base, 'app');
    const reg = registry();

    const first = reg.register({ rootPath: root, name: 'App' });
    clock += 60_000;
    const second = reg.register({ rootPath: root, name: 'App' });

    expect(second.id).toBe(first.id);
    expect(reg.list()).toHaveLength(1);
    expect(second.lastSeenAt).not.toBe(first.lastSeenAt);
    expect(second.createdAt).toBe(first.createdAt);
  });

  it('adopts a safe external id verbatim and keeps later ones as aliases', () => {
    const root = makeProject(base, 'app');
    const reg = registry();

    const created = reg.register({ rootPath: root, name: 'App', id: 'sample-app' });
    expect(created.id).toBe('sample-app');

    const again = reg.register({ rootPath: root, name: 'App', id: 'current' });
    expect(again.id).toBe('sample-app');
    expect(again.aliases).toContain('current');
    expect(reg.get('current')?.id).toBe('sample-app');
    expect(reg.list()).toHaveLength(1);
  });

  it('falls back to a generated id when the requested one cannot be a directory name', () => {
    const root = makeProject(base, 'app');
    const reg = registry();

    const record = reg.register({ rootPath: root, name: 'App', id: '../escape' });
    expect(record.id).toBe(projectIdFor('App', root));
    expect(record.aliases).not.toContain('../escape');
    expect(reg.list()).toHaveLength(1);
  });

  it('refuses to bind one id to two different roots', () => {
    const a = makeProject(base, 'a');
    const b = makeProject(base, 'b');
    const reg = registry();

    reg.register({ rootPath: a, name: 'A', id: 'shared' });
    expect(() => reg.register({ rootPath: b, name: 'B', id: 'shared' })).toThrow(
      /already registered/
    );
  });

  it('renames without changing the id, and relocates only explicitly', () => {
    const root = makeProject(base, 'app');
    const moved = makeProject(base, 'moved-app');
    const reg = registry();
    const created = reg.register({ rootPath: root, name: 'App' });

    const renamed = reg.rename(created.id, 'Renamed App');
    expect(renamed.id).toBe(created.id);
    expect(renamed.name).toBe('Renamed App');

    const relocated = reg.relocate(created.id, moved);
    expect(relocated.id).toBe(created.id);
    expect(relocated.rootPath).toBe(moved);

    /* A root that already belongs to another project cannot be claimed. */
    const other = makeProject(base, 'other');
    reg.register({ rootPath: other, name: 'Other' });
    expect(() => reg.relocate(created.id, other)).toThrow(/already registered as/);
  });

  it('removes a project and reports unknown ids', () => {
    const root = makeProject(base, 'app');
    const reg = registry();
    const created = reg.register({ rootPath: root, name: 'App' });

    expect(reg.remove(created.id)).toBe(true);
    expect(reg.list()).toHaveLength(0);
    expect(reg.remove(created.id)).toBe(false);
    expect(() => reg.rename('nope', 'x')).toThrow(/Unknown project id/);
    expect(reg.touch('nope')).toBeUndefined();
  });

  it('persists to <dataRoot>/registry.json and survives a restart', () => {
    const root = makeProject(base, 'app');
    registry().register({ rootPath: root, name: 'App' });

    const file = path.join(dataRoot, REGISTRY_FILE);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      version: number;
      projects: { id: string; rootPath: string }[];
    };
    expect(parsed.version).toBe(1);
    expect(parsed.projects).toHaveLength(1);
    expect(parsed.projects[0]!.rootPath).toBe(root);

    const reopened = registry();
    expect(reopened.list()).toHaveLength(1);
    expect(reopened.getByRoot(root)?.id).toBe(parsed.projects[0]!.id);
  });

  it('writes the project manifest into the data root, never into the source tree', () => {
    const root = makeProject(base, 'app');
    const reg = registry();
    const record = reg.register({ rootPath: root, name: 'App' });

    const manifestPath = path.join(dataRoot, 'projects', record.id, PROJECT_MANIFEST_FILE);
    expect(fs.existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    expect(manifest['projectId']).toBe(record.id);
    expect(manifest['rootPath']).toBe(root);

    /* Registering must not dirty the checkout. */
    expect(fs.readdirSync(root)).toEqual(['src']);
  });

  it('quarantines a corrupt registry instead of failing', () => {
    const root = makeProject(base, 'app');
    registry().register({ rootPath: root, name: 'App' });

    fs.writeFileSync(path.join(dataRoot, REGISTRY_FILE), '{ this is not json');
    const reopened = registry();
    expect(reopened.list()).toHaveLength(0);

    const quarantined = fs
      .readdirSync(dataRoot)
      .filter(name => name.startsWith(`${REGISTRY_FILE}.corrupt-`));
    expect(quarantined).toHaveLength(1);

    /* The registry keeps working and can register again. */
    expect(reopened.register({ rootPath: root, name: 'App' }).id).toBeTruthy();
    expect(reopened.list()).toHaveLength(1);
  });

  it('refuses a root that does not exist or is not a directory', () => {
    const reg = registry();
    expect(() => reg.register({ rootPath: path.join(base, 'missing'), name: 'X' })).toThrow(
      /does not exist/
    );

    const file = path.join(base, 'a-file');
    fs.writeFileSync(file, 'x');
    expect(() => reg.register({ rootPath: file, name: 'X' })).toThrow(/not a directory/);
    expect(reg.list()).toHaveLength(0);
  });
});
