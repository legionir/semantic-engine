import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BLUEPRINT_FILE,
  LOCKS_DIR,
  LOGS_DIR,
  PROJECT_ARTIFACTS_MANIFEST_FILE,
  PROJECT_INDEX_FILE,
  PROJECTS_DIR_NAME,
  SQLITE_FILE,
  artifactRootFor,
  canonicalIndexPath,
  resolveProjectPaths,
} from './ProjectPaths';
import { DATA_DIR_ENV_VAR } from './DataRootResolver';

const PROJECT_ID = 'prj-app-12345678';

describe('resolveProjectPaths — source and generated data never share a root', () => {
  let base: string;
  let workspace: string;

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-paths-external-')));
    workspace = path.join(base, 'app');
    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('keeps the legacy in-root layout when `in-root` is requested', () => {
    const paths = resolveProjectPaths({
      projectId: PROJECT_ID,
      workspaceRoot: workspace,
      location: 'in-root',
    });

    expect(paths.location).toBe('in-root');
    expect(paths.workspaceRoot).toBe(workspace);
    expect(paths.artifactRoot).toBe(path.join(workspace, '.semantic-engine'));
    expect(paths.indexPath).toBe(canonicalIndexPath(workspace));
    expect(paths.dataRoot).not.toBe('');
  });

  it('defaults to the data directory', () => {
    const paths = resolveProjectPaths({
      projectId: PROJECT_ID,
      workspaceRoot: workspace,
      dataRoot: path.join(base, 'data'),
    });

    expect(paths.location).toBe('external');
    expect(paths.artifactRoot).toBe(path.join(base, 'data', PROJECTS_DIR_NAME, PROJECT_ID));
  });

  it('puts every artifact under the data root in external mode', () => {
    const dataRoot = path.join(base, 'data');
    const paths = resolveProjectPaths({
      projectId: PROJECT_ID,
      workspaceRoot: workspace,
      dataRoot,
      location: 'external',
    });

    const artifactRoot = path.join(dataRoot, PROJECTS_DIR_NAME, PROJECT_ID);
    expect(paths.location).toBe('external');
    expect(paths.artifactRoot).toBe(artifactRoot);
    expect(paths.indexPath).toBe(path.join(artifactRoot, PROJECT_INDEX_FILE));
    expect(paths.blueprintPath).toBe(path.join(artifactRoot, BLUEPRINT_FILE));
    expect(paths.sqlitePath).toBe(path.join(artifactRoot, SQLITE_FILE));
    expect(paths.manifestPath).toBe(path.join(artifactRoot, PROJECT_ARTIFACTS_MANIFEST_FILE));
    expect(paths.lockDir).toBe(path.join(artifactRoot, LOCKS_DIR));
    expect(paths.logDir).toBe(path.join(artifactRoot, LOGS_DIR));

    /* The whole point of the phase: generated data stays out of the source
       tree, so a checkout never becomes dirty because of an index. */
    expect(paths.artifactRoot.startsWith(paths.workspaceRoot + path.sep)).toBe(false);
  });

  it('resolves the data root from SEMANTIC_ENGINE_DATA_DIR when none is given', () => {
    const dataRoot = path.join(base, 'env-data');
    const paths = resolveProjectPaths({
      projectId: PROJECT_ID,
      workspaceRoot: workspace,
      location: 'external',
      platform: 'linux',
      homeDir: base,
      env: { [DATA_DIR_ENV_VAR]: dataRoot },
    });

    expect(paths.dataRoot).toBe(dataRoot);
    expect(paths.artifactRoot).toBe(path.join(dataRoot, PROJECTS_DIR_NAME, PROJECT_ID));
  });

  it('lets an explicit --out win in both modes, exactly as the CLI does today', () => {
    const absolute = path.join(base, 'custom-out');
    expect(
      artifactRootFor({ projectId: PROJECT_ID, workspaceRoot: workspace, outOverride: absolute })
    ).toBe(absolute);

    /* Relative --out is resolved against the workspace, matching
       `path.resolve(root, out)` in index-command.ts. */
    expect(
      artifactRootFor({ projectId: PROJECT_ID, workspaceRoot: workspace, outOverride: 'build/sem' })
    ).toBe(path.join(workspace, 'build', 'sem'));

    expect(
      artifactRootFor({
        projectId: PROJECT_ID,
        workspaceRoot: workspace,
        outOverride: absolute,
        dataRoot: path.join(base, 'data'),
        location: 'external',
      })
    ).toBe(absolute);
  });

  it('normalizes a runtime directory passed as the root', () => {
    const paths = resolveProjectPaths({
      projectId: PROJECT_ID,
      workspaceRoot: path.join(workspace, '.agent'),
      location: 'in-root',
    });

    expect(paths.workspaceRoot).toBe(workspace);
    expect(paths.artifactRoot).toBe(path.join(workspace, '.semantic-engine'));
  });

  it('refuses a project id that could escape the data root', () => {
    const dataRoot = path.join(base, 'data');

    for (const bad of ['../evil', 'prj-../evil', 'prj-a/../../etc', '', 'PRJ-UPPER-12345678']) {
      expect(() =>
        resolveProjectPaths({
          projectId: bad,
          workspaceRoot: workspace,
          dataRoot,
          location: 'external',
        })
      ).toThrow(/Invalid project id/);

      expect(() => artifactRootFor({ projectId: bad, workspaceRoot: workspace })).toThrow(
        /Invalid project id/
      );
    }
  });

  it('keeps different projects in different artifact roots', () => {
    const dataRoot = path.join(base, 'data');
    const other = path.join(base, 'client-b', 'app');
    fs.mkdirSync(other, { recursive: true });

    const a = resolveProjectPaths({
      projectId: PROJECT_ID,
      workspaceRoot: workspace,
      dataRoot,
      location: 'external',
    });
    const b = resolveProjectPaths({
      projectId: 'prj-app-87654321',
      workspaceRoot: other,
      dataRoot,
      location: 'external',
    });

    expect(a.artifactRoot).not.toBe(b.artifactRoot);
    expect(path.dirname(a.artifactRoot)).toBe(path.dirname(b.artifactRoot));
  });
});
