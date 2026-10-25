/**
 * Jest setup — keep test runs out of the developer's real data directory.
 *
 * Since فاز ۴ the default artifact location is `external`, which resolves to
 * `$XDG_DATA_HOME/semantic-engine` (or the platform equivalent). Any test that
 * drives `runIndex`, `runUi` or `HttpServer` without pinning a location would
 * otherwise write indexes, registries and manifests into `~/.local/share/…` —
 * measured while landing this phase: 209 KB of `projects/<id>/manifest.json`
 * from `cli.test.ts` workspaces ended up in the real home directory.
 *
 * A per-run temporary directory removes that whole class of surprise. Suites
 * that care about the exact location still set `SEMANTIC_ENGINE_DATA_DIR`
 * themselves and win, because this only fills an unset value.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

if (!process.env['SEMANTIC_ENGINE_DATA_DIR']) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'se-jest-data-'));
  process.env['SEMANTIC_ENGINE_DATA_DIR'] = dataRoot;

  /*
  | Belt and braces: a child process that somehow loses the explicit variable
  | (a spawn with a filtered environment) still resolves the platform default
  | from `XDG_DATA_HOME`, so it lands in a temporary directory too instead of
  | in the developer's home.
  */
  if (!process.env['XDG_DATA_HOME']) {
    process.env['XDG_DATA_HOME'] = path.join(dataRoot, 'xdg');
  }
}
