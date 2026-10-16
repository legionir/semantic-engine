/**
 * نشانیِ socketِ قابل‌حمل — SE-PORT-02 (فاز C-2، یافته‌های F-0001/F-0007).
 *
 * ## چرا لازم شد
 *
 * Node روی Windows «`socketPath`» را فقط به شکلِ **لولهٔ نام‌دار**
 * (`\\.\pipe\<name>`) می‌پذیرد. یک مسیر فایل مثل
 * `<dataRoot>/gateway/sockets/<id>.sock` — که روی POSIX درست کار می‌کند —
 * آن‌جا یا رد می‌شود یا بی‌سروصدا چیزی نمی‌سازد که بشود به آن وصل شد.
 * نتیجه‌اش این بود که کل gateway روی Windows بالا نمی‌آمد و سه suite تا
 * `timeout` جلو می‌رفتند، و گزینهٔ `transport: 'loopback'` هم که هیچ‌وقت
 * وصل نبود (F-0007).
 *
 * ## قاعده
 *
 * یک تابعِ واحد که هر دو سمت (listen و connect) یک نشانی می‌بینند، پس
 * قراردادِ worker و proxy شاخهٔ جدا نمی‌خواهد: نشانی داده‌شده اگر لوله باشد
 * دست‌نخورده می‌ماند، اگر مسیر فایل باشد روی ویندوز به یک لوله با نامی
 * کوتاه و بی‌وابستگی به طولِ مسیر نگاشت می‌شود. همان مسیر همیشه به همان
 * لوله نگاشت می‌شود، پس دو فرآیندِ مستقل همدیگر را پیدا می‌کنند.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';

const PIPE_PREFIX = '\\\\.\\pipe\\';

/** آیا این نشانی یک لولهٔ نام‌دار است؟ */
export function isNamedPipe(socketPath: string): boolean {
  return socketPath.startsWith(PIPE_PREFIX);
}

/**
 * نشانی‌ای که باید به `listen`/`connect` داده شود.
 *
 * روی POSIX همان مسیرِ داده‌شده است. روی ویندوز، اگر لوله نبود، به
 * `\\.\pipe\se-<name>-<hash12>` نگاشت می‌شود؛ هشِ ۱۲ رقمی از خودِ مسیر، تا
 * دو پروژه با نامِ یکسان دو لولهٔ جدا بگیرند و مسیرهایِ بلندِ mkdirنشده هم
 * جا بشوند.
 */
export function socketEndpoint(socketPath: string): string {
  if (process.platform !== 'win32') return socketPath;
  if (isNamedPipe(socketPath)) return socketPath;

  const digest = crypto.createHash('sha256').update(socketPath).digest('hex').slice(0, 12);
  const base = socketPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? 'socket';
  const label = base.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 32) || 'socket';
  return `${PIPE_PREFIX}se-${label}-${digest}`;
}

/**
 * آیا نشانی «حضور» دارد؟
 *
 * لولهٔ نام‌دار فایلی نیست که بشود `stat` کرد؛ نشانهٔ باز بودنش فقط همین
 * است که یک درخواست روی آن جواب می‌دهد. پس برای لوله `true` برمی‌گردد و
 * قضاوت به اتصالِ واقعی واگذار می‌شود — وگرنه حلقه‌هایِ انتظار تا ابد
 * صبر می‌کنند (همان چیزی که در `worker did not come up` دیده شد).
 */
export function socketEndpointExists(socketPath: string): boolean {
  const endpoint = socketEndpoint(socketPath);
  return isNamedPipe(endpoint) || fs.existsSync(endpoint);
}
