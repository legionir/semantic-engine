/**
 * Static UI of the Gateway: the dashboard and the visualizer, served from a
 * fixed alias table so no request path can reach outside `uiDir`.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

const ALIASES: Readonly<Record<string, string>> = {
  '/': 'gateway.html',
  '/gateway': 'gateway.html',
  '/gateway.html': 'gateway.html',
  '/gateway.js': 'gateway.js',
  '/gateway.css': 'gateway.css',
  '/visualizer': 'visualizer.html',
  '/visualizer.html': 'visualizer.html',
  '/visualizer.js': 'visualizer.js',
  '/visualizer.css': 'visualizer.css',
  '/app.css': 'app.css',
};

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Returns true when the request was answered here. */
export function serveGatewayUi(uiDir: string, pathname: string, res: http.ServerResponse): boolean {
  const deepLink = /^\/projects\/([^/]+)$/.exec(pathname);
  if (deepLink) {
    res.writeHead(302, { Location: `/visualizer?project=${encodeURIComponent(deepLink[1]!)}` });
    res.end();
    return true;
  }

  const asset = ALIASES[pathname];
  if (!asset) return false;

  const target = path.resolve(uiDir, asset);
  /* هیچ مسیری بیرون از پوشهٔ assetها خوانده نمی‌شود. */
  if (!target.startsWith(path.resolve(uiDir) + path.sep)) {
    sendJson(res, 403, { error: 'forbidden' });
    return true;
  }

  let body: Buffer;
  try {
    body = fs.readFileSync(target);
  } catch {
    sendJson(res, 404, { error: `asset not found: ${asset}` });
    return true;
  }

  const type = asset.endsWith('.html')
    ? 'text/html; charset=utf-8'
    : asset.endsWith('.js')
      ? 'application/javascript; charset=utf-8'
      : 'text/css; charset=utf-8';

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
  });
  res.end(body);
  return true;
}
