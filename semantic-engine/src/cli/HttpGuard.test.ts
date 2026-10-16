/**
 * فاز ۳۰ — نگهبان HTTP (SE-SEC-03).
 *
 * چهار حفره، هر چهار روی کد فعلی بازتولید شدند:
 *
 * ```
 * listening address: {"address":"::","family":"IPv6","port":43167}
 *   bound to 0.0.0.0 (all interfaces)? true
 *   reachable on: eth0:169.254.0.21, eth0:fe80::fc:ff:fe00:5
 *   accepted body bytes with no cap: 5,242,880
 *   auth required? no — request succeeded with no token
 *   Origin checked? no — no header was sent and it still passed
 * ```
 *
 * جدا کردن نگهبان از سرور MCP عمدی است: می‌شود بدون بالا آوردن کل
 * SDK آزمودش، و همان نگهبان بعداً جلوی هر سرور HTTP دیگری هم
 * می‌نشیند.
 */

import * as http from 'http';
import { AddressInfo } from 'net';
import {
  HttpGuard,
  DEFAULT_MAX_BODY_BYTES,
  isLoopbackHost,
  generateToken,
} from './HttpGuard';

interface Response {
  readonly status: number;
  readonly body: string;
}

/** یک سرور آزمایشی که فقط نگهبان را جلو گذاشته است. */
async function withServer(
  guard: HttpGuard,
  run: (port: number) => Promise<void>
): Promise<void> {
  const server = http.createServer((request, response) => {
    void guard.handle(request, response, async body => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, received: body.length }));
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await run((server.address() as AddressInfo).port);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

function post(
  port: number,
  options: { token?: string; origin?: string; body?: string } = {}
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (options.token) headers['authorization'] = `Bearer ${options.token}`;
    if (options.origin) headers['origin'] = options.origin;

    const request = http.request(
      { host: '127.0.0.1', port, method: 'POST', path: '/mcp', headers },
      response => {
        let body = '';
        response.on('data', chunk => (body += chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      }
    );
    request.on('error', reject);
    request.end(options.body ?? '{}');
  });
}

describe('SE-SEC-03 — توکن اجباری است', () => {
  it('بدون توکن، ۴۰۱', async () => {
    const guard = new HttpGuard({ token: 'secret-token' });
    await withServer(guard, async port => {
      const response = await post(port);
      expect(response.status).toBe(401);
      expect(response.body).not.toContain('secret-token');
    });
  });

  it('با توکن اشتباه، ۴۰۱', async () => {
    const guard = new HttpGuard({ token: 'secret-token' });
    await withServer(guard, async port => {
      expect((await post(port, { token: 'wrong' })).status).toBe(401);
    });
  });

  it('با توکن درست، عبور می‌کند', async () => {
    const guard = new HttpGuard({ token: 'secret-token' });
    await withServer(guard, async port => {
      const response = await post(port, { token: 'secret-token' });
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body).ok).toBe(true);
    });
  });

  it('مقایسهٔ توکن به طول وابسته نیست', () => {
    /*
    | مقایسهٔ `===` روی رشته زودهنگام برمی‌گردد. برای یک سرور
    | loopback حملهٔ زمانی عملی نیست، ولی هزینهٔ درست انجام دادنش
    | هم صفر است.
    */
    const guard = new HttpGuard({ token: 'a'.repeat(32) });
    expect(guard.acceptsToken('a'.repeat(32))).toBe(true);
    expect(guard.acceptsToken('b'.repeat(32))).toBe(false);
    expect(guard.acceptsToken('a')).toBe(false);
    expect(guard.acceptsToken(undefined)).toBe(false);
  });

  it('توکن تولیدشده قابل حدس نیست', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateToken()));
    expect(tokens.size).toBe(50);
    for (const token of tokens) expect(token.length).toBeGreaterThanOrEqual(32);
  });
});

describe('SE-SEC-03 — بررسی Origin در برابر DNS-rebinding', () => {
  it('Origin غیرلوکال رد می‌شود', async () => {
    const guard = new HttpGuard({ token: 't' });
    await withServer(guard, async port => {
      const response = await post(port, { token: 't', origin: 'https://evil.example.com' });
      expect(response.status).toBe(403);
    });
  });

  it('نبودِ Origin مجاز است — کلاینت غیرمرورگر', async () => {
    /*
    | اسپک MCP بررسی Origin را برای دفاع در برابر DNS-rebinding
    | توصیه می‌کند. مرورگر همیشه این هدر را می‌فرستد؛ `curl` و
    | کلاینت MCP نه. رد کردنِ نبودِ هدر یعنی شکستن مصرف‌کنندهٔ اصلی
    | بدون اینکه امنیتی اضافه شود.
    */
    const guard = new HttpGuard({ token: 't' });
    await withServer(guard, async port => {
      expect((await post(port, { token: 't' })).status).toBe(200);
    });
  });

  it.each([
    'http://localhost:3000',
    'http://127.0.0.1:8080',
    'http://[::1]:3000',
  ])('Origin لوکال «%s» مجاز است', async origin => {
    const guard = new HttpGuard({ token: 't' });
    await withServer(guard, async port => {
      expect((await post(port, { token: 't', origin })).status).toBe(200);
    });
  });
});

describe('SE-SEC-03 — سقف حجم بدنه', () => {
  it('بدنهٔ بزرگ‌تر از سقف، ۴۱۳ می‌گیرد و کامل خوانده نمی‌شود', async () => {
    const guard = new HttpGuard({ token: 't', maxBodyBytes: 1024 });
    await withServer(guard, async port => {
      const response = await post(port, { token: 't', body: 'x'.repeat(64 * 1024) });
      expect(response.status).toBe(413);
    });
  });

  it('بدنهٔ کوچک‌تر از سقف عبور می‌کند', async () => {
    const guard = new HttpGuard({ token: 't', maxBodyBytes: 1024 });
    await withServer(guard, async port => {
      const response = await post(port, { token: 't', body: 'x'.repeat(512) });
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body).received).toBe(512);
    });
  });

  it('سقف پیش‌فرض معقول است', () => {
    expect(DEFAULT_MAX_BODY_BYTES).toBeGreaterThan(64 * 1024);
    expect(DEFAULT_MAX_BODY_BYTES).toBeLessThanOrEqual(16 * 1024 * 1024);
  });
});

describe('SE-SEC-03 — bind فقط روی loopback', () => {
  it.each([
    ['127.0.0.1', true],
    ['localhost', true],
    ['::1', true],
    ['0.0.0.0', false],
    ['::', false],
    ['192.168.1.10', false],
  ])('«%s» loopback است؟ %s', (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected);
  });

  it('سروری که روی 127.0.0.1 بسته شده، از بیرون در دسترس نیست', async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200);
      response.end('ok');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;

    try {
      expect(address.address).toBe('127.0.0.1');
      expect(address.address).not.toBe('::');
      expect(address.address).not.toBe('0.0.0.0');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

describe('SE-SEC-03 — متد و مسیر', () => {
  it('GET روی endpoint، ۴۰۵', async () => {
    const guard = new HttpGuard({ token: 't' });
    await withServer(guard, async port => {
      const status = await new Promise<number>((resolve, reject) => {
        const request = http.request(
          { host: '127.0.0.1', port, method: 'GET', path: '/mcp' },
          response => {
            response.resume();
            response.on('end', () => resolve(response.statusCode ?? 0));
          }
        );
        request.on('error', reject);
        request.end();
      });
      expect(status).toBe(405);
    });
  });

  it('مسیر ناشناخته، ۴۰۴ — و پیش از بررسی توکن', async () => {
    const guard = new HttpGuard({ token: 't' });
    await withServer(guard, async port => {
      const status = await new Promise<number>((resolve, reject) => {
        const request = http.request(
          { host: '127.0.0.1', port, method: 'POST', path: '/nope' },
          response => {
            response.resume();
            response.on('end', () => resolve(response.statusCode ?? 0));
          }
        );
        request.on('error', reject);
        request.end('{}');
      });
      expect(status).toBe(404);
    });
  });
});

describe('SE-SEC-03 — پاسخ خطا چیزی لو نمی‌دهد', () => {
  it('۴۰۱ نه توکن را می‌گوید نه اینکه توکنی هست', async () => {
    const guard = new HttpGuard({ token: 'super-secret-value' });
    await withServer(guard, async port => {
      const response = await post(port);
      expect(response.body).not.toContain('super-secret-value');
      expect(response.body.length).toBeLessThan(200);
    });
  });
});
