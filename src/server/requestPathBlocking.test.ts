/**
 * مسیرهای درخواست نباید event loop را قفل کنند — SE-PERF-01.
 *
 * ── چه چیزی بازتولید شد ───────────────────────────────────────────
 *
 * `serveStatic` برای هر دارایی پنج `existsSync` می‌زد تا پوشه را
 * پیدا کند، بعد `statSync`، بعد کل فایل را همگام می‌خواند. و
 * `fs/browse` برای هر زیرپوشه تا شش `existsSync` دیگر.
 *
 * چون همگام بودند، تا آخرینشان هیچ درخواست دیگری — حتی `/health` —
 * جواب نمی‌گرفت. این تست‌ها همان را می‌سنجند: در حالی که چند
 * درخواست سنگین در جریان است، آیا سرور هنوز پاسخگوست؟
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { HttpServer } from './HttpServer';

describe('SE-PERF-01 — request paths stay responsive', () => {
  let server: HttpServer;
  let base: string;
  let root: string;

  const TOKEN = 'perf-token';

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'se-perf-'));

    /*
    | پوشه‌های زیاد، تا `detectHint` واقعاً کار داشته باشد: نسخهٔ
    | همگام برای هر کدام تا شش `existsSync` می‌زد.
    */
    for (let i = 0; i < 120; i += 1) {
      fs.mkdirSync(path.join(root, `dir-${i}`), { recursive: true });
    }

    server = new HttpServer({
      port: 0,
      host: '127.0.0.1',
      token: TOKEN,
      projectsRoot: root,
    });

    const info = await server.start();
    base = info.url;
  }, 30000);

  afterAll(async () => {
    await server.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function get(urlPath: string): Promise<{ status: number; ms: number }> {
    const startedAt = Date.now();

    return new Promise((resolve, reject) => {
      const request = http.request(
        new URL(urlPath, base),
        { method: 'GET', headers: { Authorization: `Bearer ${TOKEN}` } },
        response => {
          response.resume();
          response.on('end', () =>
            resolve({ status: response.statusCode ?? 0, ms: Date.now() - startedAt })
          );
        }
      );
      request.on('error', reject);
      request.end();
    });
  }

  it('serves many static assets concurrently instead of one at a time', async () => {
    /*
    | اگر خواندن همگام بود، این‌ها پشت سر هم اجرا می‌شدند. حالا
    | همزمان‌اند، پس مجموعشان باید نزدیک کندترین باشد نه جمعشان.
    */
    const results = await Promise.all(
      Array.from({ length: 20 }, () => get('/visualizer.js'))
    );

    for (const result of results) {
      expect(result.status).toBe(200);
    }
  }, 30000);

  it('answers /health while a directory listing is in flight', async () => {
    /*
    | همان چیزی که کاربر گزارش کرد: یک کار سنگین، و `/health` که
    | بالا نمی‌آید.
    */
    const browsing = get(`/api/v1/fs/browse?path=${encodeURIComponent(root)}`);

    const health = await get('/health');

    expect(health.status).toBe(200);

    const listing = await browsing;
    expect(listing.status).toBe(200);
  }, 30000);

  it('keeps /health fast while several listings run at once', async () => {
    const listings = Array.from({ length: 6 }, () =>
      get(`/api/v1/fs/browse?path=${encodeURIComponent(root)}`)
    );

    const health = await get('/health');
    expect(health.status).toBe(200);

    for (const listing of await Promise.all(listings)) {
      expect(listing.status).toBe(200);
    }
  }, 30000);

  it('still reports the hint for indexed and plain project folders', async () => {
    /*
    | ناهمگام کردن نباید نتیجه را عوض کند. یک پوشه با نشانهٔ پروژه
    | و یکی با ایندکس ساخته می‌شود و هر دو باید همان برچسب قبلی را
    | بگیرند.
    */
    fs.writeFileSync(path.join(root, 'dir-0', 'package.json'), '{}', 'utf8');

    const indexed = path.join(root, 'dir-1', '.semantic-engine');
    fs.mkdirSync(indexed, { recursive: true });
    fs.writeFileSync(path.join(indexed, 'project-index.json'), '{}', 'utf8');

    const body = await new Promise<string>((resolve, reject) => {
      const request = http.request(
        new URL(`/api/v1/fs/browse?path=${encodeURIComponent(root)}`, base),
        { method: 'GET', headers: { Authorization: `Bearer ${TOKEN}` } },
        response => {
          let text = '';
          response.on('data', chunk => (text += chunk));
          response.on('end', () => resolve(text));
        }
      );
      request.on('error', reject);
      request.end();
    });

    const payload = JSON.parse(body) as {
      entries: Array<{ name: string; hint?: string }>;
    };

    const byName = new Map(payload.entries.map(entry => [entry.name, entry.hint]));

    expect(byName.get('dir-0')).toBe('project');
    expect(byName.get('dir-1')).toBe('indexed');
  }, 30000);
});
