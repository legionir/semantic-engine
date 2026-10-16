/**
 * SecurityPipeline — Platform Core V1 Security & Guards Layer.
 */

import * as http from 'http';
import * as crypto from 'crypto';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { PlatformConfig } from './types';
import { isLoopbackHost } from '../cli/HttpGuard';

const ajv = new Ajv({ allErrors: true, coerceTypes: true });
addFormats(ajv);

/*
| نام کلیدهایی که مقدارشان هرگز نباید از سرور بیرون برود.
|
| ── سه اشکال که این‌جا بود ────────────────────────────────────────
|
| ۱. دو الگوی اول `/g` داشتند و با `test()` استفاده می‌شدند. یک regex
|    با پرچم `g` حالت‌دار است: `lastIndex` بین فراخوانی‌ها می‌ماند، پس
|    `test()` روی همان رشته یک‌بار true و یک‌بار false برمی‌گرداند.
|    اندازه‌گیری‌شده روی همان الگو:
|
|      call 0 -> true   lastIndex: 32
|      call 1 -> false  lastIndex: 0
|      call 2 -> true   lastIndex: 32
|
|    چون این آرایه در سطح ماژول است، حالت بین درخواست‌ها هم می‌ماند:
|    کلید دومی که در همان پاسخ (یا درخواست بعدی) می‌آمد ماسک نمی‌شد.
|
| ۲. آن دو الگو اصلاً به درد این کار نمی‌خوردند: این‌جا فقط *نامِ*
|    کلید بررسی می‌شود و هیچ نام فیلدی شبیه `sk-…` یا `ghp_…` نیست.
|    الگوی مقدارِ راز، جای دیگری لازم است — روی خودِ مقدار.
|
| ۳. بدون لنگر بودند، ولی چون فقط نام را می‌سنجیم زیررشته کافی است؛
|    `i` نگه داشته می‌شود تا `Token` و `APIKEY` هم بگیرد.
*/
const SECRET_KEY_PATTERNS = [
  /password/i,
  /passwd/i,
  /secret/i,
  /token/i,
  /apikey/i,
  /api_key/i,
  /credential/i,
  /private_?key/i,
  /authorization/i,
];

/*
| الگوی خودِ مقدار، برای وقتی که نام کلید بی‌گناه است ولی مقدار یک
| راز واقعی است — مثل `{"note": "use sk-live-…"}`.
|
| بدون `g` تعریف می‌شوند تا `test()` حالت‌دار نشود؛ جایی که جایگزینی
| سراسری لازم است، یک نسخهٔ تازه با `g` ساخته می‌شود.
*/
const SECRET_VALUE_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{20,}/,
  /ghp_[a-zA-Z0-9]{20,}/,
  /gho_[a-zA-Z0-9]{20,}/,
  /github_pat_[a-zA-Z0-9_]{20,}/,
  /sk_plat_[a-f0-9]{32,}/,
];

const MASK = '******';

function looksLikeSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some(pattern => pattern.test(key));
}

function redactSecretValues(value: string): string {
  let output = value;

  for (const pattern of SECRET_VALUE_PATTERNS) {
    output = output.replace(new RegExp(pattern.source, 'g'), MASK);
  }

  return output;
}

export class SecurityPipeline {
  private readonly ajvInstance = ajv;

  constructor(private readonly config: PlatformConfig) {}

  /**
   * بررسی اولیه ارتباط شبکه و محافظت از Loopback.
   */
  checkConnection(req: http.IncomingMessage): { ok: boolean; status?: number; error?: string } {
    if (this.config.allowRemote) {
      return { ok: true };
    }

    const remoteAddress = req.socket.remoteAddress;

    /*
    | ── Unix domain socket ────────────────────────────────────────────
    |
    | روی socket هیچ آدرس peer وجود ندارد: `remoteAddress` برابر `undefined`
    | است (اندازه‌گیری‌شده در همین مخزن). تا فاز ۶ این یعنی ۴۰۳ برای هر
    | درخواست Gateway، یعنی transport پیشنهادی معماری اساساً کار نمی‌کرد.
    |
    | دسترسی از socket فقط وقتی local حساب می‌شود که سرور *واقعاً* روی یک
    | socket path گوش بدهد؛ و در حالت gateway-managed، داشتن توکن داخلی هم
    | در همان لایهٔ احراز هویت اجباری است (هیچ سطح بدون توکن نمی‌ماند).
    */
    if ((remoteAddress === undefined || remoteAddress === '') && this.config.socketPath) {
      return { ok: true };
    }

    const remoteIp = remoteAddress || '';
    const isLocal = isLoopbackHost(remoteIp) || remoteIp === '::1' || remoteIp.startsWith('127.');

    if (!isLocal) {
      return {
        ok: false,
        status: 403,
        error: `Access denied from remote address ${remoteIp}. Pass allowRemote to enable external access.`,
      };
    }

    return { ok: true };
  }

  /**
   * استخراج و اعتبارسنجی توکن احراز هویت.
   */
  authenticate(req: http.IncomingMessage, queryToken?: string): { authenticated: boolean; token?: string } {
    if (!this.config.token) {
      // حالت محلی بدون توکن (Standalone Local Profile)
      return { authenticated: true };
    }

    const authHeader = req.headers['authorization'] || '';
    let candidateToken: string | undefined;

    if (authHeader.startsWith('Bearer ')) {
      candidateToken = authHeader.slice(7).trim();
    } else if (req.headers['x-api-key']) {
      candidateToken = String(req.headers['x-api-key']).trim();
    } else if (queryToken) {
      candidateToken = queryToken.trim();
    }

    if (!candidateToken) {
      return { authenticated: false };
    }

    /*
    | F-0005 — مقایسهٔ زمان‌ثابت. `===` روی رشته با short-circuit
    | کار می‌کند و طولِ تطابقِ پیشازاولین اختلاف را از طریق زمان
    | بیرون می‌دهد؛ برای یک bearer/API-key که فقط hash‌شده ذخیره
    | می‌شود، این یک اوراکل قابل‌استفاده است. `timingSafeEqual` بافرهای
    | هم‌طول می‌خواهد، پس اول طول سنجیده می‌شود (نشت طول مجاز است —
    | توکن‌های هم‌طول از هم قابل‌تمدید نیستند) و در صورت اختلاف
    | بدون مقایسهٔ بایت‌به‌بایت رد می‌شود.
    */
    const expected = Buffer.from(this.config.token, 'utf8');
    const actual = Buffer.from(candidateToken, 'utf8');
    const isMatch =
      expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    return { authenticated: isMatch, token: candidateToken };
  }

  /**
   * اعتبارسنجی اسکیما برای بدنه درخواست با Ajv.
   */
  validateSchema(schema: object, data: unknown): { valid: boolean; errors?: string[] } {
    const validate = this.ajvInstance.compile(schema);
    const valid = validate(data);

    if (!valid) {
      const errors = (validate.errors || []).map(e => `${e.instancePath || 'root'} ${e.message}`);
      return { valid: false, errors };
    }

    return { valid: true };
  }

  /**
   * بررسی `Origin` — دفاع در برابر DNS-rebinding.
   *
   * ── چرا `checkConnection` کافی نبود ───────────────────────────────
   *
   * آن تابع IP طرف مقابل را می‌سنجد، و در این حمله IP طرف مقابل واقعاً
   * `127.0.0.1` است: مرورگرِ خودِ قربانی درخواست را می‌زند. یک صفحهٔ
   * مخرب نامی را به `127.0.0.1` resolve می‌کند، به سرور محلی درخواست
   * می‌دهد و — چون `Access-Control-Allow-Origin: *` بود — پاسخ را هم
   * می‌خواند.
   *
   * سرور MCP این بررسی را از SE-SEC-03 دارد؛ سرور پلتفرم نداشت. همان
   * دفاع، همان تابع `isLoopbackHost`.
   */
  checkOrigin(req: http.IncomingMessage): { ok: boolean; status?: number; error?: string } {
    const origin = req.headers['origin'];

    /*
    | نبودِ `Origin` یعنی درخواست از مرورگر نیامده (curl، یک اسکریپت،
    | یک کلاینت MCP). آن‌ها با توکن سنجیده می‌شوند، نه با این هدر.
    */
    if (typeof origin !== 'string' || origin === '') {
      return { ok: true };
    }

    if (this.config.allowRemote) {
      return { ok: true };
    }

    /*
    | پشت Gateway، مرورگر با Gateway حرف می‌زند و Gateway هدر `Origin` را
    | حذف می‌کند؛ اگر هم چیزی بماند، متعلق به میزبان عمومی Gateway است و
    | سنجیدنش روی worker فقط ۴۰۳ تولید می‌کند. نشانهٔ واقعیِ «از Gateway
    | آمده» هدرهای `X-Forwarded-*` است که Gateway ست می‌کند — درخواست
    | مستقیم آن‌ها را ندارد.
    */
    if (this.isTrustedGateway(req)) {
      return { ok: true };
    }

    let hostname: string;
    try {
      hostname = new URL(origin).hostname;
    } catch {
      return { ok: false, status: 403, error: 'Origin header is not a valid URL' };
    }

    if (!isLoopbackHost(hostname)) {
      return {
        ok: false,
        status: 403,
        error: `Cross-origin request from ${origin} is refused.`,
      };
    }

    return { ok: true };
  }

  /** آیا این حالت، worker پشت Gateway است؟ */
  get gatewayManaged(): boolean {
    return Boolean(this.config.gatewayManaged);
  }

  /**
   * `true` یعنی proxy بودن Gateway پذیرفته شده. خودِ این flag کافی نیست:
   * نبودِ `X-Forwarded-*` یعنی درخواست مستقیم زده شده، که دقیقاً همان چیزی
   * است که حالت managed باید رد کند.
   */
  isTrustedGateway(req: http.IncomingMessage): boolean {
    const trusted = this.config.trustedGateway ?? this.gatewayManaged;
    if (!trusted) return false;

    return (
      req.headers['x-forwarded-for'] !== undefined ||
      req.headers['x-forwarded-proto'] !== undefined ||
      req.headers['x-forwarded-host'] !== undefined
    );
  }

  /**
   * تنظیم هدرهای امنیتی و CORS.
   */
  applySecurityHeaders(res: http.ServerResponse, req?: http.IncomingMessage): void {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    /*
    | SE-UI-02: قبلاً `X-Frame-Options: DENY` بود که هر embed داخل
    | iframe را می‌بست — از جمله live preview محیط توسعه. چون این یک
    | ابزار محلی است و دسترسی شبکه‌ای پشت `checkConnection`/token است،
    | embedding را آزاد می‌گذاریم تا UI در preview دیده شود.
    */
    res.setHeader('X-XSS-Protection', '1; mode=block');

    /*
    | قبلاً این هدر همیشه `*` بود، یعنی هر صفحه‌ای در هر دامنه‌ای
    | می‌توانست پاسخ را بخواند. حالا فقط همان Origin ای بازتاب داده
    | می‌شود که `checkOrigin` قبولش کرده؛ در حالت `allowRemote` که
    | اپراتور صریحاً شبکه را باز کرده، رفتار قبلی حفظ می‌شود.
    */
    const origin = req?.headers['origin'];

    if (this.config.allowRemote) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (typeof origin === 'string' && origin !== '' && this.checkOrigin(req!).ok) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  }

  /**
   * پنهان‌سازی مقادیر حساس در اشیاء قبل از خروج.
   */
  maskSecrets<T>(data: T): T {
    if (typeof data === 'string') {
      return redactSecretValues(data) as unknown as T;
    }

    if (!data || typeof data !== 'object') {
      return data;
    }

    if (Array.isArray(data)) {
      return data.map(item => this.maskSecrets(item)) as unknown as T;
    }

    const masked: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      /*
      | `rawToken` تنها استثناست و عمدی: کلید تازه‌ساخته‌شده دقیقاً
      | یک‌بار به کاربر نشان داده می‌شود و بعد از آن فقط hash آن
      | می‌ماند. ماسک کردنش یعنی کلید برای همیشه گم می‌شود.
      |
      | این استثنا فقط برای پاسخِ همان endpoint ساخت کلید معنا دارد،
      | پس عمداً به نام دقیق محدود است و به `rawTokenBackup` یا
      | چیزهای شبیه آن سرایت نمی‌کند.
      */
      if (key === 'rawToken') {
        masked[key] = value;
        continue;
      }

      if (typeof value === 'string') {
        masked[key] =
          looksLikeSecretKey(key) && value.length > 0
            ? MASK
            : redactSecretValues(value);
        continue;
      }

      if (typeof value === 'object' && value !== null) {
        /*
        | یک کلید حساس که مقدارش شیء است (مثل `credentials: {...}`)
        | باید کاملاً برود، نه اینکه فرزندانش تک‌تک بررسی شوند.
        */
        masked[key] = looksLikeSecretKey(key) ? MASK : this.maskSecrets(value);
        continue;
      }

      masked[key] = value;
    }

    return masked as T;
  }
}
