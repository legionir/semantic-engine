/**
 * F-0012 — the platform server must not reintroduce the dead job-queue surface.
 *
 * The server used to construct an `InMemoryQueueAdapter` (`jobQueue`) and an
 * `IndexingWorker` (`indexingWorker`) that were never started nor enqueued
 * into, and `/ready` advertised `checks.jobQueue: true` as if a live queue
 * existed. That was a dishonest health surface.
 *
 * These assertions lock the removal: if the fields, the readiness key, or the
 * wiring reappear, the structural test fails; the live test proves `/ready`
 * now reports the real `jobManager` and no longer the dead `jobQueue`.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HttpServer } from './HttpServer';

const SERVER = path.join(__dirname, 'HttpServer.ts');

describe('F-0012 — dead IndexingWorker/InMemoryQueueAdapter surface stays removed', () => {
  it('HttpServer does not import or construct the orphaned runtime classes', () => {
    const s = fs.readFileSync(SERVER, 'utf8');
    expect(s).not.toMatch(/import\s+\{[^}]*\bInMemoryQueueAdapter\b[^}]*\}\s+from/);
    expect(s).not.toMatch(/import\s+\{[^}]*\bIndexingWorker\b[^}]*\}\s+from/);
    expect(s).not.toMatch(/new\s+InMemoryQueueAdapter\(/);
    expect(s).not.toMatch(/new\s+IndexingWorker\(/);
  });

  it('HttpServer exposes no jobQueue / indexingWorker field', () => {
    const s = fs.readFileSync(SERVER, 'utf8');
    expect(s).not.toMatch(/readonly\s+jobQueue\b/);
    expect(s).not.toMatch(/readonly\s+indexingWorker\b/);
  });

  it('readiness reports the real jobManager, never the dead jobQueue key', () => {
    const s = fs.readFileSync(SERVER, 'utf8');
    expect(s).toMatch(/jobManager:\s*Boolean\(this\.jobs\)/);
    expect(s).not.toMatch(/jobQueue:\s*Boolean/);
  });

  it('a live server advertises jobManager and omits jobQueue on /ready', async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-ready-')));
    const server = new HttpServer({
      port: 0,
      host: '127.0.0.1',
      token: 'ready-token',
      projectsRoot: base,
      dataRoot: path.join(base, 'data'),
    });
    const { port } = await server.start();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/ready`);
      const json = (await res.json()) as { ready: boolean; checks: Record<string, boolean> };
      expect(json.ready).toBe(true);
      expect(json.checks.jobManager).toBe(true);
      expect(json.checks).not.toHaveProperty('jobQueue');
    } finally {
      await server.stop();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
