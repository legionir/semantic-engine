import * as http from 'http';
import { AddressInfo } from 'net';
import { HttpGuard } from './HttpGuard';

describe('HttpGuard — rejected oversized body', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    const guard = new HttpGuard({ token: 't', path: '/mcp', maxBodyBytes: 1024 });
    server = http.createServer((req, res) => {
      void guard.handle(req, res, async () => {
        res.writeHead(200);
        res.end('ok');
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  const post = (body: string): Promise<number> =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/mcp',
          method: 'POST',
          headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
        },
        res => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });

  it('answers 413 and the same keep-alive connection still serves the next request', async () => {
    expect(await post('x'.repeat(2 * 1024 * 1024))).toBe(413);
    expect(await post('{}')).toBe(200);
  }, 15000);
});
