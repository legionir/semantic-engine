/**
 * Static UI assets of the platform server (open page, visualizer, scripts).
 * The directory is resolved once; no request path can leave it.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export class StaticAssetServer {
  private dirCache: string | null | undefined;

  constructor(private readonly configuredDir?: string) {}

  private async resolveDir(): Promise<string | null> {
    if (this.dirCache !== undefined) return this.dirCache;

    const candidates = [
      this.configuredDir,
      path.join(__dirname, '..', '..', 'public'),
      path.join(__dirname, '..', 'public'),
      path.join(__dirname, 'public'),
      path.join(__dirname, '..', '..', '..', 'web', 'public'),
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

  /** Returns true when the request was answered with a file. */
  async serve(pathname: string, res: http.ServerResponse): Promise<boolean> {
    const staticDir = await this.resolveDir();
    if (!staticDir) return false;

    let targetFile = pathname;
    // SE-UI-07: صفحهٔ ورود حالا «باز کردن/پیکربندی پروژه» است تا کاربر
    // بتواند بدون ایندکس قبلی هم پروژه را باز و ایندکس کند. Visualizer
    // با /visualizer یا /visualizer.html در دسترس است.
    if (targetFile === '/' || targetFile === '/index.html' || targetFile === '/open') {
      targetFile = '/open.html';
    } else if (targetFile === '/visualizer') {
      targetFile = '/visualizer.html';
    }

    const root = path.resolve(staticDir);
    const resolved = path.resolve(root, targetFile.replace(/^\//, ''));
    /* `+ path.sep`: a sibling such as `<dir>-evil` must not pass a prefix test. */
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return false;
    }

    try {
      const stat = await fs.promises.stat(resolved);
      if (!stat.isFile()) return false;

      const ext = path.extname(resolved).toLowerCase();
      const mime = MIME_TYPES[ext] || 'application/octet-stream';
      const content = await fs.promises.readFile(resolved);

      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': content.length,
        'Cache-Control': 'no-cache',
      });
      res.end(content);
      return true;
    } catch {
      return false;
    }
  }
}
