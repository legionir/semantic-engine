/**
 * فاز ۲ — the collision that made one project disappear.
 *
 * Before this phase `registerProject` derived the id from `basename` and keyed
 * its map by that id, so two checkouts named `app` produced the same id and the
 * second registration silently replaced the first. Measured while auditing the
 * plan:
 *
 * ```text
 * ids: prj-app prj-app | listProjects().length → 1
 * ```
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProjectService } from './ProjectService';
import { ProjectRegistry, REGISTRY_FILE } from '../core/config/ProjectRegistry';
import { projectIdFor } from '../core/config/ProjectIdentity';

function makeProject(base: string, ...parts: string[]): string {
  const root = path.join(base, ...parts);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  return fs.realpathSync(root);
}

describe('ProjectService — project identity and registration', () => {
  let base: string;

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-project-service-')));
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('keeps two projects named `app` as two projects', () => {
    const clientA = makeProject(base, 'client-a', 'app');
    const clientB = makeProject(base, 'client-b', 'app');

    const service = new ProjectService(base);
    const a = service.registerProject(clientA);
    const b = service.registerProject(clientB);

    expect(a.id).not.toBe(b.id);
    expect(a.id).toBe(projectIdFor(path.basename(clientA), clientA));
    expect(service.listProjects()).toHaveLength(2);
    expect(service.getProject(a.id)?.rootPath).toBe(clientA);
    expect(service.getProject(b.id)?.rootPath).toBe(clientB);
    service.dispose();
  });

  it('registers the same root once, however often it is asked', () => {
    const root = makeProject(base, 'app');
    const service = new ProjectService(base);

    const first = service.registerProject(root);
    const second = service.registerProject(root);

    expect(second.id).toBe(first.id);
    expect(service.listProjects()).toHaveLength(1);
    service.dispose();
  });

  it('honours an explicit id and resolves every alias to the same project', () => {
    /* `serve` registers the workspace under three ids so the UI can ask for
       `project=current`; all of them must keep working, but the project must
       appear only once. */
    const root = makeProject(base, 'app');
    const service = new ProjectService(base);

    const byBasename = service.registerProject(root, 'app', 'App');
    const byPrefixed = service.registerProject(root, 'prj-app', 'App');
    const current = service.registerProject(root, 'current', 'App');

    expect(byBasename.id).toBe('app');
    expect(byPrefixed.id).toBe('app');
    expect(current.id).toBe('app');
    expect(service.listProjects()).toHaveLength(1);
    expect(service.listProjects()[0]!.aliases).toEqual(
      expect.arrayContaining(['app', 'prj-app', 'current'])
    );

    for (const alias of ['app', 'prj-app', 'current']) {
      expect(service.getProject(alias)?.rootPath).toBe(root);
    }
    service.dispose();
  });

  it('persists through a registry without writing into the source tree', () => {
    const root = makeProject(base, 'app');
    const dataRoot = path.join(base, 'data');
    const service = new ProjectService(base, {
      registry: new ProjectRegistry({ dataRoot }),
    });

    const project = service.registerProject(root, undefined, 'App');

    expect(fs.existsSync(path.join(dataRoot, REGISTRY_FILE))).toBe(true);
    expect(project.id).toBe(projectIdFor('App', root));
    /* Nothing generated inside the checkout. */
    expect(fs.readdirSync(root)).toEqual(['src']);

    /*
    | A fresh service starts with an empty in-memory map — hydrating it from
    | the registry is the Gateway's job (فاز ۹) — but the registry kept the
    | record, so re-registering the same root yields the very same id.
    */
    service.dispose();
    const persisted = new ProjectRegistry({ dataRoot });
    expect(persisted.list()).toHaveLength(1);
    expect(persisted.list()[0]!.id).toBe(project.id);

    const reopened = new ProjectService(base, { registry: persisted });
    expect(reopened.listProjects()).toHaveLength(0);
    expect(reopened.registerProject(root).id).toBe(project.id);
    expect(reopened.listProjects()).toHaveLength(1);
    reopened.dispose();
  });

  it('still tolerates a root that is not there yet', () => {
    const service = new ProjectService(base, {
      registry: new ProjectRegistry({ dataRoot: path.join(base, 'data') }),
    });

    const missing = path.join(base, 'not-created-yet');
    const project = service.registerProject(missing, 'pending', 'Pending');

    expect(project.status).toBe('missing');
    expect(project.id).toBe('pending');
    expect(service.listProjects()).toHaveLength(1);
    service.dispose();
  });
});

describe('ProjectService — update, remove and indexProject contract', () => {
  let base: string;

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-project-service-mut-')));
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('updateProject changes the map and the registry; a new service sees it after restart', () => {
    const dataRoot = path.join(base, 'data');
    const root = makeProject(base, 'a', 'app');
    const service = new ProjectService(base, { registry: new ProjectRegistry({ dataRoot }) });
    const project = service.registerProject(root, 'app-id', 'Old');

    const updated = service.updateProject(project.id, { name: 'New', autoStart: true });
    expect(updated?.name).toBe('New');
    expect(service.getProject('app-id')?.name).toBe('New');
    expect(service.listProjects()).toHaveLength(1);
    service.dispose();

    const registry = new ProjectRegistry({ dataRoot });
    expect(registry.get('app-id')).toMatchObject({ name: 'New', autoStart: true });
  });

  it('removeProject clears every alias and does not come back after restart', () => {
    const dataRoot = path.join(base, 'data');
    const service = new ProjectService(base, { registry: new ProjectRegistry({ dataRoot }) });
    const project = service.registerProject(makeProject(base, 'a', 'app'), 'gone', 'Gone');
    const alias = project.aliases[0];

    expect(service.removeProject('gone')).toBe(true);
    expect(service.getProject('gone')).toBeUndefined();
    if (alias) expect(service.getProject(alias)).toBeUndefined();
    expect(service.listProjects()).toHaveLength(0);
    expect(service.removeProject('gone')).toBe(false);
    expect(new ProjectRegistry({ dataRoot }).get('gone')).toBeUndefined();
    service.dispose();
  });

  it('indexProject states that it reloaded artifacts and did not re-index', async () => {
    const service = new ProjectService(base);
    const project = service.registerProject(makeProject(base, 'a', 'app'), 'idx', 'Idx');
    const result = await service.indexProject(project.id);
    expect(result).toMatchObject({ mode: 'reload', reindexed: false });
    await expect(service.indexProject('missing')).rejects.toThrow(/not found/);
    service.dispose();
  });
});

describe('ProjectService — reads the index the CLI wrote ("not indexed" regression)', () => {
  let base: string;

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-project-service-idx-')));
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  /**
   * `semantic-engine start` indexes with the id derived from the root
   * (`prj-<name>-<hash>`), while the UI registers the same folder under display
   * ids (`<name>`, `current`). The UI used to read `<dataRoot>/projects/<name>`
   * and so reported a freshly indexed project as "not indexed".
   */
  it.each(['current', 'my-app', undefined])('finds the index under the derived id (requested id: %s)', async requested => {
    const root = makeProject(base, 'my-app');
    const dataRoot = path.join(base, 'data');
    const derived = projectIdFor('my-app', root);
    const artifactDir = path.join(dataRoot, 'projects', derived);

    const { IndexPipeline } = await import('../pipeline/IndexPipeline');
    const { OutputWriter, INDEX_FILE_NAME } = await import('../pipeline/OutputWriter');
    const { createExtractors } = await import('../pipeline/ExtractorFactory');
    const extractors = createExtractors({ workspaceRoot: root, treeSitter: false });
    const { projectIndex } = await new IndexPipeline({
      workspaceRoot: root,
      outputPath: path.join(artifactDir, INDEX_FILE_NAME),
      symbolExtractors: extractors.symbols,
      dependencyExtractors: extractors.dependencies,
      gitCollector: null,
      vectorIndexer: null,
    }).run();
    await new OutputWriter({ outputDir: artifactDir, blueprint: true }).write(projectIndex);
    extractors.dispose();

    const service = new ProjectService(root, {
      dataRoot,
      artifactLocation: 'external',
      registry: new ProjectRegistry({ dataRoot }),
    });
    const project = service.registerProject(root, requested, 'my-app');

    expect(project.status).toBe('ready');
    expect(project.indexPath).toBe(path.join(artifactDir, INDEX_FILE_NAME));
    expect(project.stats.filesCount).toBeGreaterThan(0);
    service.dispose();
  });
});
