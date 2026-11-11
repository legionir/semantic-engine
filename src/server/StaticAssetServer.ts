/**
 * Static UI assets — the one file server behind both the Gateway console and
 * the platform (worker) server.
 *
 * Everything is served from a fixed table, so no request path can name a file:
 * a path that is not in the table is simply not answered here. The only
 * difference between the two servers is the page `/` opens, given as `home`.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

/** The page `/` opens: the Gateway console or the settings page. */
export type HomePage = 'gateway.html' | 'open.html';

export interface StaticAssetOptions {
  readonly home?: HomePage;
  /** `/projects/:id` → the visualizer for that project (Gateway deep link). */
  readonly projectDeepLinks?: boolean;
}

const ASSETS: Readonly<Record<string, string>> = {
  '/gateway': 'gateway.html',
  '/gateway.html': 'gateway.html',
  '/gateway.js': 'gateway.js',
  '/gateway.css': 'gateway.css',
  '/worker-console.js': 'worker-console.js',
  '/visualizer': 'visualizer.html',
  '/visualizer.html': 'visualizer.html',
  '/visualizer.js': 'visualizer.js',
  '/visualizer.css': 'visualizer.css',
  '/open': 'open.html',
  '/open.html': 'open.html',
  '/open.js': 'open.js',
  '/open.css': 'open.css',
  '/app.css': 'app.css',
  '/api.js': 'api.js',
};

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
};

export class StaticAssetServer {
  private dirCache: string | null | undefined;
  private readonly home: HomePage;
  private readonly projectDeepLinks: boolean;

  constructor(
    private readonly configuredDir?: string,
    options: StaticAssetOptions = {}
  ) {
    this.home = options.home ?? 'open.html';
    this.projectDeepLinks = options.projectDeepLinks ?? false;
  }

  private async resolveDir(): Promise<string | null> {
    if (this.dirCache !== undefined) return this.dirCache;

    const candidates = [
      this.configuredDir,
      path.join(__dirname, '..', '..', 'public'),
      path.join(__dirname, '..', 'public'),
      path.join(__dirname, 'public'),
    ].filter((p): p is string => Boolean(p));

    for (const candidate of candidates) {
      try {
        await fs.promises.access(candidate);
        this.dirCache = candidate;
        return candidate;
      } catch {
        /* try the next one */
      }
    }

    this.dirCache = null;
    return null;
  }

  private assetFor(pathname: string): string | undefined {
    if (pathname === '/' || pathname === '/index.html') return this.home;
    return Object.prototype.hasOwnProperty.call(ASSETS, pathname) ? ASSETS[pathname] : undefined;
  }

  /** Returns true when the request was answered here. */
  async serve(pathname: string, res: http.ServerResponse): Promise<boolean> {
    if (this.projectDeepLinks) {
      const deepLink = /^\/projects\/([^/]+)$/.exec(pathname);
      if (deepLink) {
        res.writeHead(302, { Location: `/visualizer?project=${encodeURIComponent(deepLink[1]!)}` });
        res.end();
        return true;
      }
    }

    const asset = this.assetFor(pathname);
    if (!asset) return false;

    const staticDir = await this.resolveDir();
    if (!staticDir) return false;

    let content: Buffer;
    try {
      content = await fs.promises.readFile(path.join(staticDir, asset));
    } catch {
      return false;
    }

    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(asset)] ?? 'application/octet-stream',
      'Content-Length': content.length,
      'Cache-Control': 'no-cache',
    });
    res.end(content);
    return true;
  }
}
