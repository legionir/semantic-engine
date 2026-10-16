import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseArgs } from './args';
import {
  ARTIFACT_LOCATION_ENV_VAR,
  artifactLocationFromArgs,
  indexLookupFromArgs,
  projectIdFromArgs,
  projectPathsFromArgs,
} from './projectPathsFromArgs';
import { envVarNameFor } from '../host/Config';
import { projectIdFor } from '../core/config/ProjectIdentity';
import { indexPathCandidates } from '../core/config/ProjectPaths';

describe('projectPathsFromArgs — one resolver for every CLI command', () => {
  let base: string;
  let root: string;

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-cli-paths-')));
    root = path.join(base, 'app');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('keeps the env name tied to the config key', () => {
    expect(envVarNameFor('semanticEngine.artifactLocation')).toBe(ARTIFACT_LOCATION_ENV_VAR);
  });

  it('defaults to the data directory', () => {
    const paths = projectPathsFromArgs(parseArgs(['index', '--root', root]), root, {
      SEMANTIC_ENGINE_DATA_DIR: path.join(base, 'data'),
    });

    expect(paths.location).toBe('external');
    expect(paths.artifactRoot).toBe(
      path.join(base, 'data', 'projects', projectIdFor('app', root))
    );
  });

  it('still supports the legacy in-root layout on request', () => {
    const paths = projectPathsFromArgs(
      parseArgs(['index', '--root', root, '--artifact-location', 'in-root']),
      root,
      { SEMANTIC_ENGINE_DATA_DIR: path.join(base, 'data') }
    );

    expect(paths.location).toBe('in-root');
    expect(paths.artifactRoot).toBe(path.join(root, '.semantic-engine'));
    expect(paths.indexPath).toBe(path.join(root, '.semantic-engine', 'project-index.json'));
  });

  it('moves to the data directory when the environment asks for it', () => {
    const dataRoot = path.join(base, 'data');
    const paths = projectPathsFromArgs(parseArgs(['index', '--root', root]), root, {
      [ARTIFACT_LOCATION_ENV_VAR]: 'external',
      SEMANTIC_ENGINE_DATA_DIR: dataRoot,
    });

    const projectId = projectIdFor('app', root);
    expect(paths.location).toBe('external');
    expect(paths.projectId).toBe(projectId);
    expect(paths.artifactRoot).toBe(path.join(dataRoot, 'projects', projectId));
    expect(paths.lockDir).toBe(path.join(paths.artifactRoot, 'locks'));
    expect(paths.logDir).toBe(path.join(paths.artifactRoot, 'logs'));
  });

  it('lets the flag beat the environment, and --out beat both', () => {
    const dataRoot = path.join(base, 'data');
    const env = {
      [ARTIFACT_LOCATION_ENV_VAR]: 'in-root',
      SEMANTIC_ENGINE_DATA_DIR: dataRoot,
    };

    expect(
      artifactLocationFromArgs(parseArgs(['index', '--artifact-location', 'external']), env)
    ).toBe('external');

    const out = path.join(base, 'explicit');
    const paths = projectPathsFromArgs(
      parseArgs(['index', '--root', root, '--artifact-location', 'external', '--out', out]),
      root,
      env
    );
    expect(paths.artifactRoot).toBe(out);
  });

  it('prefers --data-dir over the environment', () => {
    const dataRoot = path.join(base, 'flag-data');
    const paths = projectPathsFromArgs(
      parseArgs(['index', '--root', root, '--artifact-location', 'external', '--data-dir', dataRoot]),
      root,
      { SEMANTIC_ENGINE_DATA_DIR: path.join(base, 'env-data') }
    );

    expect(paths.artifactRoot.startsWith(dataRoot)).toBe(true);
  });

  it('accepts a safe --project-id and falls back for anything else', () => {
    expect(projectIdFromArgs(parseArgs(['index', '--project-id', 'prj-a-12345678']), root)).toBe(
      'prj-a-12345678'
    );
    expect(projectIdFromArgs(parseArgs(['index', '--project-id', '../evil']), root)).toBe(
      projectIdFor('app', root)
    );
  });

  it('gives index and watch the same artifact root', () => {
    const env = {
      [ARTIFACT_LOCATION_ENV_VAR]: 'external',
      SEMANTIC_ENGINE_DATA_DIR: path.join(base, 'data'),
    };
    const forIndex = projectPathsFromArgs(parseArgs(['index', '--root', root]), root, env);
    const forWatch = projectPathsFromArgs(
      parseArgs(['watch', '--root', root, '--debounce', '250']),
      root,
      env
    );

    expect(forWatch.artifactRoot).toBe(forIndex.artifactRoot);
  });

  it('exposes the same choice to the index lookup', () => {
    const env = {
      [ARTIFACT_LOCATION_ENV_VAR]: 'external',
      SEMANTIC_ENGINE_DATA_DIR: path.join(base, 'data'),
    };
    const lookup = indexLookupFromArgs(parseArgs(['serve', '--root', root]), root, env);

    expect(lookup.location).toBe('external');
    expect(lookup.projectId).toBe(projectIdFor('app', root));

    /* The lookup carries the env through, so the reader resolves the data
       directory exactly where the writer put it. */
    expect(indexPathCandidates(root, lookup)[0]).toBe(
      path.join(base, 'data', 'projects', projectIdFor('app', root), 'project-index.json')
    );
    /* …with the legacy in-root locations kept as readable fallbacks. */
    expect(indexPathCandidates(root, lookup)[1]).toBe(
      path.join(root, '.semantic-engine', 'project-index.json')
    );
  });
});
