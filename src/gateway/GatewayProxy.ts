/**
 * Request proxying to a worker — فاز ۹.
 *
 * Streaming, not buffering: the body is piped in both directions, so a large
 * upload, a long `tools/call` answer and an SSE event stream all behave the
 * same way they would against the worker directly.
 *
 * Header rules (D6):
 *
 *   - the inbound `Origin` is dropped — the worker must not judge the
 *     browser's origin, it faces the Gateway;
 *   - `X-Forwarded-For/Proto/Host` are set, which is also how the worker
 *     recognizes a request that really came through the Gateway;
 *   - `Authorization` is replaced with the worker's internal token, so the
 *     public token never reaches a worker;
 *   - hop-by-hop headers are not forwarded.
 *
 * Every proxied response carries `X-Semantic-Project-Id`, which is how a
 * client tells whose answer it is reading without buffering the body.
 */

import * as http from 'http';
import { targetConnectOptions, WorkerTarget } from './workerTarget';

export const PROJECT_ID_HEADER = 'x-semantic-project-id';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export interface ProxyTarget {
  /** F-0007 — هدفِ worker دیگر یک رشتهٔ socketPath نیست: transport خودش را دارد. */
  readonly worker: WorkerTarget;
  readonly token: string;
}

export interface ProxyOptions {
  readonly projectId: string;
  /** مسیر مقصد روی worker؛ پیش‌فرض همان مسیر ورودی است (بدون بازنویسی). */
  readonly targetPath?: string;
  readonly onUpstream?: (info: { projectId: string; status: number }) => void;
  readonly onError?: (info: { projectId: string; error: string }) => void;
}

function clientIp(req: http.IncomingMessage): string {
  const address = req.socket.remoteAddress;
  return address ?? '127.0.0.1';
}

function buildHeaders(req: http.IncomingMessage, target: ProxyTarget): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};

  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === 'origin' || lower === 'host' || lower === 'authorization') continue;
    headers[name] = value;
  }

  headers['authorization'] = `Bearer ${target.token}`;
  headers['x-forwarded-for'] = clientIp(req);
  headers['x-forwarded-proto'] = 'http';
  headers['x-forwarded-host'] = typeof req.headers['host'] === 'string' ? req.headers['host'] : 'gateway';

  return headers;
}

/**
 * پروکسی یک درخواست. هرگز reject نمی‌شود: خرابی upstream به `502` ترجمه
 * می‌شود تا یک worker مرده کل Gateway را پایین نیاورد.
 */
export function proxyRequest(
  target: ProxyTarget,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: ProxyOptions
): Promise<void> {
  const targetPath = options.targetPath ?? req.url ?? '/';

  return new Promise(resolve => {
    const upstream = http.request(
      {
        ...targetConnectOptions(target.worker),
        path: targetPath,
        method: req.method ?? 'GET',
        headers: buildHeaders(req, target),
      },
      upstreamRes => {
        const status = upstreamRes.statusCode ?? 502;
        const headers: http.OutgoingHttpHeaders = {};
        for (const [name, value] of Object.entries(upstreamRes.headers)) {
          if (!HOP_BY_HOP.has(name.toLowerCase())) headers[name] = value;
        }
        headers[PROJECT_ID_HEADER] = options.projectId;

        res.writeHead(status, headers);
        options.onUpstream?.({ projectId: options.projectId, status });

        /*
        | pipe یعنی بدون buffering: هم برای بدنهٔ بزرگ درست است هم برای
        | SSE، که باید تا پایان stream باز بماند.
        */
        upstreamRes.pipe(res);
        upstreamRes.on('end', resolve);
        upstreamRes.on('error', () => {
          res.end();
          resolve();
        });
      }
    );

    upstream.on('error', error => {
      const message = error instanceof Error ? error.message : String(error);
      options.onError?.({ projectId: options.projectId, error: message });
      if (!res.headersSent) {
        res.writeHead(502, {
          'Content-Type': 'application/json',
          [PROJECT_ID_HEADER]: options.projectId,
        });
      }
      res.end(JSON.stringify({ error: `worker ${options.projectId} is unreachable`, detail: message }));
      resolve();
    });

    /* قطع کلاینت باید به worker برسد، وگرنه connection یتیم می‌ماند. */
    res.on('close', () => {
      if (!upstream.destroyed) upstream.destroy();
    });

    req.pipe(upstream);
  });
}
