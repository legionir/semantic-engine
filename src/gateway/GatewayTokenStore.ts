/**
 * A gateway token that survives restarts.
 *
 * A freshly generated token on every start meant every AI client's MCP config
 * and every bookmarked dashboard link went stale. Unless the operator pins one
 * (`--token`, `SEMANTIC_ENGINE_GATEWAY_TOKEN`), the first generated token is
 * kept in `<dataRoot>/gateway/token` and reused; `--rotate-token` replaces it.
 */

import * as fs from 'fs';
import * as path from 'path';
import { generateToken } from '../cli/HttpGuard';

export type GatewayTokenSource = 'provided' | 'stored' | 'generated' | 'rotated';

export interface ResolvedGatewayToken {
  readonly token: string;
  readonly source: GatewayTokenSource;
  /** Where the token is kept; undefined when it was provided and is not stored. */
  readonly file?: string;
}

export function gatewayTokenPath(dataRoot: string): string {
  return path.join(dataRoot, 'gateway', 'token');
}

export function resolveGatewayToken(options: {
  readonly dataRoot: string;
  readonly provided?: string | undefined;
  readonly rotate?: boolean;
}): ResolvedGatewayToken {
  const provided = options.provided?.trim();
  if (provided) return { token: provided, source: 'provided' };

  const file = gatewayTokenPath(options.dataRoot);
  if (!options.rotate) {
    try {
      const stored = fs.readFileSync(file, 'utf8').trim();
      if (stored.length >= 16) return { token: stored, source: 'stored', file };
    } catch {
      /* no stored token yet */
    }
  }

  const token = generateToken();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  } catch {
    /* A read-only data dir must not stop the gateway: the token just is not kept. */
    return { token, source: options.rotate ? 'rotated' : 'generated' };
  }
  return { token, source: options.rotate ? 'rotated' : 'generated', file };
}
