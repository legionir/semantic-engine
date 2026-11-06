import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PROJECT_MANIFEST_FILE, REGISTRY_FILE, ProjectRegistry } from './ProjectRegistry';

function makeProject(base: string, name: string): string {
  const root = path.join(base, name);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  return fs.realpathSync(root);
}

describe('ProjectRegistry — several processes share one registry file (F-01)', () => {
  let base: string;
  let dataRoot: string;

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-registry-conc-')));
    dataRoot = path.join(base, 'data');
  });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  it('does not drop a project registered by another instance with a stale cache', () => {
    const gateway = new ProjectRegistry({ dataRoot });
    const cli = new ProjectRegistry({ dataRoot });

    gateway.register({ rootPath: makeProject(base, 'one'), name: 'one' });
    /* the gateway now holds a cache that knows only `one` */
    expect(gateway.list()).toHaveLength(1);

    cli.register({ rootPath: makeProject(base, 'two'), name: 'two' });

    /* the gateway writes again from what it cached: `two` must survive */
    gateway.register({ rootPath: makeProject(base, 'three'), name: 'three' });

    const names = new ProjectRegistry({ dataRoot }).list().map(r => r.name).sort();
    expect(names).toEqual(['one', 'three', 'two']);
  });

  it('sees a registration made by another instance without a restart', () => {
    const a = new ProjectRegistry({ dataRoot });
    const b = new ProjectRegistry({ dataRoot });
    expect(a.list()).toEqual([]);

    const record = b.register({ rootPath: makeProject(base, 'late'), name: 'late' });
    expect(a.get(record.id)?.name).toBe('late');
  });

  it('rebuilds the list from manifests when the registry file is corrupt', () => {
    const reg = new ProjectRegistry({ dataRoot });
    const one = reg.register({ rootPath: makeProject(base, 'one'), name: 'one', autoStart: true });
    const two = reg.register({ rootPath: makeProject(base, 'two'), name: 'two' });

    fs.writeFileSync(path.join(dataRoot, REGISTRY_FILE), '{"version":1,"projects":[');

    const fresh = new ProjectRegistry({ dataRoot });
    const ids = fresh.list().map(r => r.id).sort();
    expect(ids).toEqual([one.id, two.id].sort());
    expect(fresh.get(one.id)?.autoStart).toBe(true);
    expect(fs.readdirSync(dataRoot).some(f => f.startsWith(`${REGISTRY_FILE}.corrupt-`))).toBe(true);
  });

  it('does not resurrect a project whose root is gone or whose manifest names another id', () => {
    const reg = new ProjectRegistry({ dataRoot });
    const gone = reg.register({ rootPath: makeProject(base, 'gone'), name: 'gone' });
    const kept = reg.register({ rootPath: makeProject(base, 'kept'), name: 'kept' });
    fs.rmSync(path.join(base, 'gone'), { recursive: true, force: true });

    const forged = path.join(dataRoot, 'projects', 'forged');
    fs.mkdirSync(forged, { recursive: true });
    fs.writeFileSync(
      path.join(forged, PROJECT_MANIFEST_FILE),
      JSON.stringify({ projectId: 'someone-else', rootPath: path.join(base, 'kept'), name: 'x' })
    );

    fs.writeFileSync(path.join(dataRoot, REGISTRY_FILE), 'not json');
    const ids = new ProjectRegistry({ dataRoot }).list().map(r => r.id);
    expect(ids).toEqual([kept.id]);
    expect(ids).not.toContain(gone.id);
  });

  it('leaves no temporary or lock file behind', () => {
    const reg = new ProjectRegistry({ dataRoot });
    reg.register({ rootPath: makeProject(base, 'one'), name: 'one' });
    const leftovers = fs.readdirSync(dataRoot).filter(f => f.endsWith('.tmp') || f.endsWith('.lock'));
    expect(leftovers).toEqual([]);
  });
});
