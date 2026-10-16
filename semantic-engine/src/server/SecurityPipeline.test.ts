/**
 * SecurityPipeline — ماسک‌کردن اسرار و بررسی Origin.
 *
 * هر تست این‌جا یک یافتهٔ واقعی است که یک‌بار در حال اجرا بازتولید شد،
 * نه یک سناریوی فرضی.
 */

import * as http from 'http';
import { SecurityPipeline } from './SecurityPipeline';

function pipeline(overrides: Partial<{ token: string; allowRemote: boolean }> = {}) {
  return new SecurityPipeline({
    port: 0,
    host: '127.0.0.1',
    token: overrides.token ?? 'test-token',
    allowRemote: overrides.allowRemote ?? false,
  });
}

describe('maskSecrets', () => {
  /*
  | ── باگی که این‌جا بازتولید شد ─────────────────────────────────
  |
  | دو الگوی اول `/g` داشتند و با `test()` استفاده می‌شدند. یک regex
  | با پرچم `g` حالت‌دار است؛ `lastIndex` بین فراخوانی‌ها می‌ماند:
  |
  |   call 0 -> true   lastIndex: 32
  |   call 1 -> false  lastIndex: 0
  |
  | یعنی یک درخواست ماسک می‌شد و درخواست بعدی نه. چون آرایه در سطح
  | ماژول بود، این حالت بین درخواست‌ها هم می‌ماند.
  */
  it('یک شکل ثابت، هر بار یک نتیجه — بدون حالتِ باقی‌مانده', () => {
    const security = pipeline();

    /*
    | مقدار عمداً شبیه هیچ رازِ شناخته‌شده‌ای نیست: اگر `sk-…` بود،
    | لایهٔ دومِ ماسک (روی خودِ مقدار) آن را می‌گرفت و این تست حتی با
    | یک الگوی حالت‌دار هم سبز می‌ماند. تنها چیزی که این‌جا آن را
    | حساس می‌کند، *نامِ* کلید است — یعنی دقیقاً همان مسیری که باگ
    | در آن بود.
    */
    const results = Array.from(
      { length: 6 },
      () => security.maskSecrets({ apiKey: 'plain-value-not-a-known-shape' }).apiKey
    );

    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe('******');
  });

  it('هر کلیدِ حساسِ شناخته‌شده، بارها پشت سر هم، همیشه ماسک می‌شود', () => {
    const security = pipeline();

    for (const key of ['password', 'secret', 'token', 'apiKey', 'api_key', 'credential']) {
      for (let round = 0; round < 3; round += 1) {
        const masked = security.maskSecrets({ [key]: 'plain-value' }) as Record<string, unknown>;

        expect(masked[key]).toBe('******');
      }
    }
  });

  it('دو راز در یک پاسخ، هر دو ماسک می‌شوند', () => {
    const masked = pipeline().maskSecrets({
      apiKey: 'sk-aaaaaaaaaaaaaaaaaaaaaaaa',
      token: 'sk-bbbbbbbbbbbbbbbbbbbbbbbb',
      password: 'hunter2',
    });

    expect(masked).toEqual({ apiKey: '******', token: '******', password: '******' });
  });

  it('حالت بین دو نمونهٔ مستقل هم نشت نمی‌کند', () => {
    const first = pipeline().maskSecrets({ apiKey: 'sk-cccccccccccccccccccccccc' });
    const second = pipeline().maskSecrets({ apiKey: 'sk-cccccccccccccccccccccccc' });

    expect(first).toEqual(second);
    expect(second.apiKey).toBe('******');
  });

  it('رازی که در یک فیلد بی‌گناه پنهان شده هم پاک می‌شود', () => {
    const masked = pipeline().maskSecrets({
      note: 'deploy with sk-livekeyabcdefghijklmnop then ghp_abcdefghijklmnopqrstuvwx',
    });

    expect(masked.note).not.toMatch(/sk-livekey/);
    expect(masked.note).not.toMatch(/ghp_/);
    expect(masked.note).toContain('******');
  });

  it('کلید حساس با مقدار شیء کاملاً می‌رود، نه فرزند به فرزند', () => {
    const masked = pipeline().maskSecrets({
      credentials: { user: 'u', pass: 'p' },
      provider: { name: 'openai', api_key: 'zzz' },
    });

    expect(masked.credentials).toBe('******');
    expect((masked.provider as Record<string, unknown>).name).toBe('openai');
    expect((masked.provider as Record<string, unknown>).api_key).toBe('******');
  });

  it('آرایه‌ها و تودرتویی هم پیمایش می‌شوند', () => {
    const masked = pipeline().maskSecrets({
      keys: [{ token: 'aaa' }, { token: 'bbb' }],
    });

    expect(masked.keys).toEqual([{ token: '******' }, { token: '******' }]);
  });

  /*
  | تنها استثنا، و عمدی: کلید تازه‌ساخته دقیقاً یک‌بار نشان داده
  | می‌شود و بعد از آن فقط hash می‌ماند. `v2.routes.test.ts` روی همین
  | حساب می‌کند.
  */
  it('rawToken عمداً ماسک نمی‌شود، ولی این استثنا سرایت نمی‌کند', () => {
    const masked = pipeline().maskSecrets({
      rawToken: 'sk_plat_deadbeefdeadbeefdeadbeefdeadbeef',
      rawTokenBackup: 'sk_plat_deadbeefdeadbeefdeadbeefdeadbeef',
    });

    expect(masked.rawToken).toBe('sk_plat_deadbeefdeadbeefdeadbeefdeadbeef');
    expect(masked.rawTokenBackup).not.toContain('deadbeef');
  });

  it('مقادیر غیررشته‌ای دست‌نخورده می‌مانند', () => {
    const masked = pipeline().maskSecrets({ count: 3, ok: true, missing: null });

    expect(masked).toEqual({ count: 3, ok: true, missing: null });
  });
});

describe('checkOrigin', () => {
  function requestWith(headers: Record<string, string>): http.IncomingMessage {
    return { headers } as unknown as http.IncomingMessage;
  }

  /*
  | `checkConnection` این حمله را نمی‌گرفت: IP طرف مقابل واقعاً
  | loopback است، چون مرورگرِ قربانی درخواست را می‌زند.
  */
  it('Origin بیرونی رد می‌شود', () => {
    const result = pipeline().checkOrigin(requestWith({ origin: 'http://evil.example.com' }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
  });

  it('Origin محلی می‌گذرد', () => {
    for (const origin of ['http://127.0.0.1:4000', 'http://localhost:8080', 'http://[::1]:3000']) {
      expect(pipeline().checkOrigin(requestWith({ origin })).ok).toBe(true);
    }
  });

  it('نبودِ Origin یعنی درخواست از مرورگر نیامده', () => {
    expect(pipeline().checkOrigin(requestWith({})).ok).toBe(true);
  });

  it('Origin بی‌ریخت رد می‌شود، نه اینکه استثنا بدهد', () => {
    expect(pipeline().checkOrigin(requestWith({ origin: 'not a url' })).ok).toBe(false);
  });

  it('allowRemote یعنی اپراتور صریحاً شبکه را باز کرده', () => {
    const result = pipeline({ allowRemote: true }).checkOrigin(
      requestWith({ origin: 'http://evil.example.com' })
    );

    expect(result.ok).toBe(true);
  });
});

describe('authenticate — F-0005 (مقایسهٔ زمان‌ثابت)', () => {
  function bearer(token: string): http.IncomingMessage {
    return { headers: { authorization: `Bearer ${token}` } } as unknown as http.IncomingMessage;
  }

  it('توکن درست می‌پذیرد', () => {
    const security = pipeline({ token: 'sk_plat_0123456789abcdef0123456789abcdef' });
    expect(security.authenticate(bearer('sk_plat_0123456789abcdef0123456789abcdef')).authenticated).toBe(true);
  });

  it('توکن هم‌طولِ اشتباه رد می‌شود', () => {
    const security = pipeline({ token: 'sk_plat_0123456789abcdef0123456789abcdef' });
    expect(security.authenticate(bearer('sk_plat_ffffffffffffffffffffffffffffffff')).authenticated).toBe(false);
  });

  it('توکن کوتاه‌تر رد می‌شود و به timingSafeEqual نمی‌رسد', () => {
    const security = pipeline({ token: 'sk_plat_0123456789abcdef0123456789abcdef' });
    expect(security.authenticate(bearer('sk_plat_0123456789')).authenticated).toBe(false);
  });

  it('بدون هدر احراز، توکن تهی رد می‌شود', () => {
    const security = pipeline({ token: 'x' });
    const req = { headers: {} } as unknown as http.IncomingMessage;
    expect(security.authenticate(req).authenticated).toBe(false);
  });
});
