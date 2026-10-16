/**
 * فاز ۳, گام ۵ — `query_index` must confine SQLite to the *artifact* root,
 * which is no longer necessarily inside the workspace.
 *
 * Until now `AiToolRegistry` derived that directory from
 * `resolveProjectIndexPath(workspaceRoot)`, i.e. always `<root>/.semantic-engine`.
 * With artifacts in the data directory that guess points at a directory with no
 * database in it, so the registry now receives `artifactRoot` explicitly
 * (`services/ProjectService.ts` passes `dirname(actualIndexPath)`).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { QueryIndexTool } from './QueryIndexTool';

describe('query_index — database confinement follows the artifact root', () => {
  let dataRoot: string;
  let artifactRoot: string;

  beforeEach(() => {
    dataRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-query-index-')));
    artifactRoot = path.join(dataRoot, 'projects', 'prj-app-12345678');
    fs.mkdirSync(artifactRoot, { recursive: true });
    fs.writeFileSync(path.join(artifactRoot, 'project-index.sqlite'), 'not a real database');
  });

  afterEach(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  it('resolves a relative name against the artifact root', async () => {
    const tool = new QueryIndexTool({ allowedRoot: artifactRoot });
    const result = await tool.execute({
      sqlitePath: 'project-index.sqlite',
      sql: 'SELECT id FROM symbols LIMIT 1',
    });

    /* It may still fail (no sqlite3 module, or an invalid file) — but it must
       not fail the *policy* check, which is what the old workspace-rooted
       allowedRoot did in external mode. */
    expect(result.error ?? '').not.toMatch(/outside the configured output directory/);
  });

  it('refuses a path that escapes the artifact root', async () => {
    const tool = new QueryIndexTool({ allowedRoot: artifactRoot });

    const escaping = await tool.execute({
      sqlitePath: '../../../../etc/passwd.sqlite',
      sql: 'SELECT id FROM symbols LIMIT 1',
    });
    expect(escaping.success).toBe(false);
    expect(escaping.error).toMatch(/outside the configured output directory/);

    const absolute = await tool.execute({
      sqlitePath: '/tmp/somewhere-else.sqlite',
      sql: 'SELECT id FROM symbols LIMIT 1',
    });
    expect(absolute.success).toBe(false);
    expect(absolute.error).toMatch(/outside the configured output directory/);
  });

  it('opens nothing when no artifact root is configured', async () => {
    const tool = new QueryIndexTool({});
    const result = await tool.execute({ sql: 'SELECT id FROM symbols LIMIT 1' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No database directory is configured/);
  });
});
