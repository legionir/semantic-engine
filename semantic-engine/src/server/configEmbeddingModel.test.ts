/**
 * F-0021 — GET /api/v1/config must report the real configured embedding model,
 * not a hardcoded literal.
 *
 * The route used to always answer `embedding.model: "Qwen3-Embedding-0.6B"`
 * regardless of how the server was actually configured — a fabricated value.
 * The honest contract: report the model threaded into PlatformConfig, or
 * `null` when none was configured. This test locks both sides of that.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HttpServer } from './HttpServer';

const TOKEN = 'f21-token';

async function makeServer(config: { embeddingModel?: string | null }): Promise<{ url: string; stop: () => Promise<void> }> {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-f21-')));
  const server = new HttpServer({ port: 0, host: '127.0.0.1', token: TOKEN, projectsRoot: base, ...config });
  const { url } = await server.start();
  return { url, stop: async () => { await server.stop(); fs.rmSync(base, { recursive: true, force: true }); } };
}

function getConfig(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL('/api/v1/config', url), { method: 'GET', headers: { Authorization: `Bearer ${TOKEN}` } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c as Buffer));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('F-0021 — /config reports the real embedding model', () => {
  it('returns null (not a fabricated literal) when no embedding model is configured', async () => {
    const { url, stop } = await makeServer({});
    try {
      const cfg = await getConfig(url);
      expect(cfg.embedding.model).toBeNull();
    } finally {
      await stop();
    }
  });

  it('returns the configured model when one is provided', async () => {
    const { url, stop } = await makeServer({ embeddingModel: 'bge-m3' });
    try {
      const cfg = await getConfig(url);
      expect(cfg.embedding.model).toBe('bge-m3');
    } finally {
      await stop();
    }
  });

  it('never fabricates Qwen3-Embedding-0.6B', async () => {
    const { url, stop } = await makeServer({});
    try {
      const cfg = await getConfig(url);
      expect(cfg.embedding.model).not.toBe('Qwen3-Embedding-0.6B');
    } finally {
      await stop();
    }
  });
});
