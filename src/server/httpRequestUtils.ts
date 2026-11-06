/**
 * Request helpers of the platform HTTP server: route-pattern matching and
 * size-limited JSON body reading.
 */
import * as crypto from 'crypto';
import * as http from 'http';

/**
 * `new URL(target, base)` that never throws. A request target such as `//` or
 * `//%` is not a valid URL; callers answer 400 instead of crashing on it — in
 * an 'upgrade' listener a synchronous throw is an uncaught exception.
 */
export function parseUrlSafely(target: string | undefined, base: string): URL | null {
  try {
    return new URL(target ?? '/', base);
  } catch {
    return null;
  }
}

/** `decodeURIComponent` that leaves a malformed escape as typed; the lookup then simply fails. */
export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Answer an unexpected failure without handing its message to the client: a
 * thrown error carries file-system paths and internals. The detail goes to
 * stderr under a request id the client can quote.
 */
export function respondInternalError(res: http.ServerResponse, error: unknown): void {
  const requestId = crypto.randomBytes(6).toString('hex');
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`[http] internal error ${requestId}: ${detail}\n`);
  if (res.writableEnded) return;
  if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'internal error', requestId }));
}

export function matchPattern(pattern: string, pathname: string): Record<string, string> | null {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = pathname.split('/').filter(Boolean);

  if (patternParts.length !== pathParts.length) {
    return null;
  }

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const pPart = patternParts[i]!;
    const aPart = pathParts[i]!;

    if (pPart.startsWith(':')) {
      try {
        params[pPart.slice(1)] = decodeURIComponent(aPart);
      } catch {
        /* a malformed %-escape cannot name any resource */
        return null;
      }
    } else if (pPart !== aPart) {
      return null;
    }
  }

  return params;
}

export function readBody(req: http.IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`Payload too large. Limit is ${maxBytes} bytes.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON payload'));
      }
    });

    req.on('error', reject);
  });
}

/**
 * Splits a request target into pathname and query without normalising the path.
 */
export function parseRequestTarget(url: string | undefined): { pathname: string; query: Record<string, string> } {
  /*
  | `url.parse` is deprecated (DEP0169). `new URL(req.url, base)` is not a
  | drop-in: it normalises `..` and treats `//host/x` as a host. The request
  | target is split by hand instead, so the pathname stays exactly as sent
  | (as before) and only the query goes through URLSearchParams.
  */
  /* Absolute-form targets (`GET http://host/x`, sent by proxies) reduce to their path. */
  const rawTarget = (url || '/').split('#')[0]!.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?]*/, '') || '/';
  const queryStart = rawTarget.indexOf('?');
  const pathname = (queryStart === -1 ? rawTarget : rawTarget.slice(0, queryStart)) || '/';
  const query: Record<string, string> = {};
  if (queryStart !== -1) {
    const search = new URLSearchParams(rawTarget.slice(queryStart + 1));
    for (const key of new Set(search.keys())) query[key] = search.get(key) ?? '';
  }
  return { pathname, query };
}

/** Writes a route handler's result as the HTTP response. */
export function writeRouteResponse(
  res: http.ServerResponse,
  data: { status?: number; headers?: Record<string, string>; json?: unknown; text?: string },
  maskSecrets: (value: unknown) => unknown
): void {
  const status = data.status || 200;
  if (data.headers) {
    for (const [name, value] of Object.entries(data.headers)) res.setHeader(name, value);
  }

  if (data.json !== undefined) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(maskSecrets(data.json)));
  } else if (data.text !== undefined) {
    res.writeHead(status, { 'Content-Type': 'text/plain' });
    res.end(data.text);
  } else {
    res.writeHead(status);
    res.end();
  }
}
