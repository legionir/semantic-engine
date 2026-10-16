/**
 * Jest globalSetup — keep the *real* process environment away from the
 * developer's data directory.
 *
 * Why this is not (only) `setupFiles`: inside a jest sandbox `process.env` is a
 * copy, so a value assigned there never reaches `child_process`. Measured while
 * landing فاز ۴:
 *
 * ```text
 * PROBE in-process=/tmp/se-jest-data-PolunM child=(unset)
 * ```
 *
 * Suites that spawn the real CLI (`cli.test.ts`, `serve-watch.test.ts`)
 * therefore ran `doctor`/`ui`/`watch` against `~/.local/share/semantic-engine`.
 * `globalSetup` runs in the parent process, before workers are forked, so both
 * the workers and their children inherit the temporary directory.
 *
 * `setupFiles` stays as the in-sandbox half of the same guard.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

export default async function globalSetupDataDir(): Promise<void> {
  /*
  | Honest notice about suite-level skips (SE-F-049 companion): about ten
  | e2e/gateway/cli suites gate themselves on `dist/` existing and skip the
  | whole suite when it does not. On a bare `npx jest` (no prior `npm run
  | build`) jest reports them as "skipped" and the remaining suites pass, so
  | the run LOOKS complete while the gateway/CLI surface was never executed.
  | Print the fact loudly once, in the parent, before workers fork — a green
  | summary must never be silently weaker than it reads.
  */
  const distEntry = path.join(__dirname, '..', '..', 'dist', 'cli', 'main.js');
  if (!fs.existsSync(distEntry)) {
    process.stderr.write(
      '[globalSetup] NOTICE: dist/ is not built. ~10 dist-gated suites ' +
      '(gateway e2e, CLI, LSP client) will be SKIPPED, not run. This is not ' +
      'a failure — but the green summary below covers fewer suites than ' +
      '`npm run build && npx jest` would. Run the build for the full suite.\n'
    );
  }

  /*
  | The on-disk test fixture is generated, not committed (scripts/gen-fixture
  | -js). `npm test` makes it via `pretest`, but a direct `jest`/`npx jest`
  | invocation skipped that step and several suites (cli, scanner, export,
  | blueprint) then failed with empty indexes — a broken first impression
  | that looks like product regressions. Generate it here, which every jest
  | entry point runs.
  */
  const fixtureRoot = path.resolve(__dirname, '..', '..', 'test-fixture');
  if (!fs.existsSync(path.join(fixtureRoot, 'src', 'app.ts'))) {
    execFileSync(process.execPath, [
      path.resolve(__dirname, '..', '..', 'scripts', 'gen-fixture.js'),
    ], { stdio: 'inherit' });
  }

  if (process.env['SEMANTIC_ENGINE_DATA_DIR']) return;

  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'se-jest-data-'));
  process.env['SEMANTIC_ENGINE_DATA_DIR'] = dataRoot;

  if (!process.env['XDG_DATA_HOME']) {
    process.env['XDG_DATA_HOME'] = path.join(dataRoot, 'xdg');
  }
}
