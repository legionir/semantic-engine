/**
 * The version of this package, read once from its own `package.json`.
 *
 * One place, so `--version`, every start banner, the MCP `serverInfo` and the
 * gateway dashboard all report the same string.
 */

import * as fs from 'fs';
import * as path from 'path';

export const PRODUCT_NAME = 'Semantic Engine';

let cached: string | undefined;

export function packageVersion(): string {
  if (cached !== undefined) return cached;
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8');
    cached = (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    cached = '0.0.0';
  }
  return cached;
}
