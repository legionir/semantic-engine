/**
 * HttpGuard — لایهٔ محافظ جلوی سرور HTTP — SE-SEC-03.
 *
 * ── چه چیزی خراب بود ──────────────────────────────────────────────
 *
 * `ai/mcp/cli.ts` سرور HTTP را این‌طور بالا می‌آورد. هر چهار حفره
 * روی همان کد بازتولید شدند:
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
 * روی هم با SE-SEC-01 یعنی هرکسی در همان شبکه می‌توانست کل ایندکس
 * پروژه را بخواند و از طریق `get_recent_changes` فرمان اجرا کند.
 *
 * ── چرا جدا از سرور MCP ───────────────────────────────────────────
 *
 * جدا بودن یعنی می‌شود بدون بالا آوردن کل SDK آزمودش — که تفاوت بین
 * «چند تست امنیتی» و «هیچ تست امنیتی» است. و همان نگهبان جلوی هر
 * سرور HTTP دیگری هم می‌نشیند.
 */

import * as crypto from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';

/**
 * سقف پیش‌فرض بدنه.
 *
 * یک درخواست MCP معمولی چند کیلوبایت است؛ ۴MB جای کافی برای یک
 * فراخوان پرمحتوا می‌دهد و هنوز آن‌قدر کوچک است که هزار درخواست
 * هم‌زمان حافظه را نبرد.
 */
export const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

/** میزبان پیش‌فرض — هرگز `0.0.0.0`. */
export const DEFAULT_HOST = '127.0.0.1';

export interface HttpGuardOptions {
  /** توکن لازم در `Authorization: Bearer …`. */
  readonly token: string;
  readonly maxBodyBytes?: number;
  /** مسیری که پذیرفته می‌شود. پیش‌فرض `/mcp`. */
  readonly path?: string;
}

/** آیا این میزبان فقط روی همین ماشین گوش می‌دهد؟ */
export function isLoopbackHost(host: string): boolean {
  const bare = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return bare === 'localhost' || bare === '127.0.0.1' || bare === '::1' || bare.startsWith('127.');
}

/** توکنی که حدس زدنش عملی نباشد. */
export function generateToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

/**
 * آیا این `Origin` از همین ماشین می‌آید؟
 *
 * اسپک MCP بررسی Origin را برای دفاع در برابر DNS-rebinding توصیه
 * می‌کند: یک صفحهٔ وب مخرب می‌تواند نامی را به `127.0.0.1` resolve
 * کند و از مرورگر قربانی به سرور محلی درخواست بزند. مرورگر همیشه
 * `Origin` را می‌فرستد، پس همین یک بررسی جلویش را می‌گیرد.
 */
function isLocalOrigin(origin: string): boolean {
  try {
    return isLoopbackHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export type BodyHandler = (body: string) => Promise<void>;

export class HttpGuard {
  private readonly token: Buffer;
  private readonly maxBodyBytes: number;
  private readonly path: string;

  constructor(options: HttpGuardOptions) {
    this.token = Buffer.from(options.token, 'utf8');
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.path = options.path ?? '/mcp';
  }

  /**
   * مقایسهٔ توکن در زمان ثابت.
   *
   * `===` روی رشته زودهنگام برمی‌گردد. برای یک سرور loopback حملهٔ
   * زمانی عملی نیست، ولی هزینهٔ درست انجام دادنش هم صفر است.
   */
  acceptsToken(candidate: string | undefined): boolean {
    if (!candidate) return false;
    const given = Buffer.from(candidate, 'utf8');
    if (given.length !== this.token.length) return false;
    return crypto.timingSafeEqual(given, this.token);
  }

  /**
   * بررسی درخواست و — در صورت عبور — تحویل بدنه به `handler`.
   */
  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    handler: BodyHandler
  ): Promise<void> {
    const url = (request.url ?? '').split('?')[0];

    /*
    | مسیر پیش از توکن بررسی می‌شود: یک ۴۰۴ روی مسیر اشتباه هیچ‌چیز
    | دربارهٔ اعتبار توکن لو نمی‌دهد، و برعکسش کاوشگر را به مسیر
    | درست راهنمایی می‌کند.
    */
    if (url !== this.path) return deny(response, 404, 'not found');
    if (request.method !== 'POST') return deny(response, 405, 'method not allowed');

    const origin = header(request, 'origin');
    if (origin !== undefined && !isLocalOrigin(origin)) {
      return deny(response, 403, 'forbidden');
    }

    const authorization = header(request, 'authorization') ?? '';
    const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1];
    if (!this.acceptsToken(bearer)) {
      /*
      | پیام عمداً بی‌محتواست: نه می‌گوید توکن لازم است، نه اینکه
      | توکنِ داده‌شده نزدیک بود.
      */
      return deny(response, 401, 'unauthorized');
    }

    let body: string;
    try {
      body = await this.readBody(request);
    } catch (error) {
      /*
      | بستنِ سوکت پیش از رسیدن پاسخ، به کلاینت `ECONNRESET` می‌دهد
      | نه `413` — یعنی همان اطلاعاتی که باید منتقل شود، نمی‌شود.
      | اول پاسخ، بعد بستن.
      */
      if (error instanceof BodyTooLarge) return deny(response, 413, 'payload too large', true, request);
      return deny(response, 400, 'bad request', true, request);
    }

    /*
    | یک استثنا در handler نباید پروسه را بکشد.
    |
    | هر دو فراخوان‌کننده با `void guard.handle(...)` صدا می‌زنند، پس
    | یک throw این‌جا به unhandled rejection تبدیل می‌شد و کل سرور را
    | پایین می‌آورد — یعنی یک درخواست بدشکل از راه دور، DoS. اندازه‌گیری
    | شد: یک ایندکس بدون کلید `graphs` کافی بود.
    |
    | متن خطا به بیرون نمی‌رود: مسیر فایل و stack همان چیزهایی‌اند که
    | یک کاوشگر دنبالشان است.
    */
    try {
      await handler(body);
    } catch (error) {
      process.stderr.write(
        `mcp request failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`
      );
      deny(response, 500, 'internal error');
    }
  }

  /**
   * خواندن بدنه با سقف.
   *
   * نسخهٔ قبلی `body += chunk` بود، بدون هیچ سقفی — یک درخواست
   * می‌توانست هر چقدر بخواهد حافظه بگیرد. این‌جا به‌محض رد شدن از
   * سقف، اتصال بسته می‌شود؛ ادامهٔ خواندن یعنی همان DoS با تأخیر.
   */
  private readBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const declared = Number(header(request, 'content-length'));
      if (Number.isFinite(declared) && declared > this.maxBodyBytes) {
        request.pause();
        reject(new BodyTooLarge());
        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;

      let rejected = false;
      request.on('data', (chunk: Buffer) => {
        if (rejected) return;
        size += chunk.length;
        if (size > this.maxBodyBytes) {
          rejected = true;
          /*
          | خواندن متوقف می‌شود ولی سوکت باز می‌ماند تا پاسخ ۴۱۳
          | برسد. چیزی هم دیگر بافر نمی‌شود، پس همان مهار DoS
          | برقرار است.
          */
          request.pause();
          reject(new BodyTooLarge());
          return;
        }
        chunks.push(chunk);
      });
      request.on('error', reject);
      request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  }
}

class BodyTooLarge extends Error {
  constructor() {
    super('payload too large');
    this.name = 'BodyTooLarge';
  }
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** How much of a rejected request body is read and thrown away before giving up. */
const DRAIN_LIMIT_BYTES = 32 * 1024 * 1024;
const DRAIN_TIMEOUT_MS = 5000;

function deny(
  response: ServerResponse,
  status: number,
  message: string,
  closeConnection = false,
  request?: IncomingMessage
): void {
  if (response.headersSent) return;

  const headers: Record<string, string> = { 'content-type': 'text/plain' };
  /*
  | `Connection: close` makes Node destroy the socket as soon as the response is
  | flushed. A client that is still writing its (rejected) body then gets EPIPE
  | or ECONNRESET and may never surface the status. When the request is known we
  | instead keep the connection, read-and-discard the remainder within a byte and
  | time budget, and only then drop it.
  */
  const drain = closeConnection && request !== undefined;
  if (closeConnection && !drain) headers['connection'] = 'close';

  /* Node detaches `response.socket` on 'finish', so it has to be captured first. */
  const socket = response.socket ?? request?.socket;

  response.writeHead(status, headers);
  response.end(message, () => {
    if (!closeConnection || !socket) return;

    if (!drain || !request) {
      socket.end();
      setTimeout(() => socket.destroy(), 2000).unref();
      return;
    }

    let drained = 0;
    const abandon = (): void => {
      socket.destroy();
    };
    const timer = setTimeout(abandon, DRAIN_TIMEOUT_MS);
    timer.unref();
    request.on('data', (chunk: Buffer) => {
      drained += chunk.length;
      if (drained > DRAIN_LIMIT_BYTES) abandon();
    });
    request.once('end', () => clearTimeout(timer));
    socket.once('close', () => clearTimeout(timer));
    request.resume();
  });
}
