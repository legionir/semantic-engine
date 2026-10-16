/**
 * SE-PIPE-001 (companion) — run-pipeline.js must fail on a workspace that does
 * not exist instead of emitting an empty index with exit code 0. An empty
 * "successful" run over a mistyped path is the §16 confusion of "no result was
 * found" with "no result exists": downstream benchmark/gate consumers would
 * read a zero-file project as a real, indexed workspace.
 *
 * The existence check runs BEFORE any dist require, so it executes on a bare
 * checkout (no `npm run build` needed) — this suite is therefore NOT gated.
 */

import * as path from 'path';
import { execFileSync } from 'child_process';

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'run-pipeline.js');

describe('SE-PIPE-001 — run-pipeline fails honestly', () => {
  it('a missing workspace exits non-zero with a clear error, not an empty success', () => {
    const missing = path.join('/tmp', `se-nonexistent-${process.pid}-${Date.now()}`);
    let status = 0;
    let stderr = '';
    try {
      execFileSync(process.execPath, [SCRIPT, missing, '/tmp/se-pipe-out'], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (error) {
      status = (error as { status?: number }).status ?? 0;
      stderr = String((error as { stderr?: Buffer }).stderr || '');
    }
    expect(status).toBe(1);
    expect(stderr).toMatch(/does not exist or is not a directory/);
  });

  it('no args exits non-zero with usage (never a silent 0)', () => {
    let status = 0;
    try {
      execFileSync(process.execPath, [SCRIPT], { stdio: 'ignore' });
    } catch (error) {
      status = (error as { status?: number }).status ?? 0;
    }
    expect(status).toBe(1);
  });
});
