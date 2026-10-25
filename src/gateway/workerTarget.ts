/**
 * هدفِ اتصالِ gateway به worker — F-0007.
 *
 * ## چرا
 *
 * `WorkerTransport` دو مقدار دارد (`loopback` | `socket`) و `workerArgv` هم
 * از قبل `--host/--port` را می‌فرستد و `--socket` را فقط برای `socket`
 * اضافه می‌کند — ولی supervisor و هر دو سمتِ ارتباطی (proxy و WS upgrade)
 * بی‌قیدوشرط socketPath می‌ساختند و به آن وصل می‌شدند. یعنی گزینه‌ای که
 * در schema و در مستندات معماری (D5) اعلام شده بود هیچ مسیرِ اجرا نداشت:
 * پیکربندیِ `loopback` بی‌صدا روی سوکت می‌افتاد.
 *
 * ## شکل
 *
 * یک نوعِ جمعی به‌جای رشتهٔ socketPath، و یک تابع که گزینه‌های
 * `http.request` / `net.connect` را از روی transport می‌سازد؛ `socketEndpoint`
 * همان‌جا نگاشتِ ویندوز را انجام می‌دهد، پس هیچ مصرف‌کننده‌ای نسخهٔ خامِ
 * مسیر نمی‌بیند.
 */

import { socketEndpoint } from '../server/socketEndpoint';
import type { NetConnectOpts } from 'net';
import type { WorkerTransport } from './types';

export type WorkerTarget =
  | { readonly transport: 'socket'; readonly socketPath: string }
  | { readonly transport: 'loopback'; readonly host: string; readonly port: number };

/** گزینه‌هایی که `http.request` و `net.connect` هر دو می‌پذیرند. */
export function targetConnectOptions(
  target: WorkerTarget
): { socketPath?: string; host?: string; port?: number } {
  if (target.transport === 'loopback') {
    return { host: target.host, port: target.port };
  }
  return { socketPath: socketEndpoint(target.socketPath) };
}

/**
 * گزینه‌های `net.connect` — که برخلاف `http.request` برای سوکت کلید
 * `path` می‌خواهد نه `socketPath`.
 */
export function netConnectOptions(target: WorkerTarget): NetConnectOpts {
  if (target.transport === 'loopback') {
    return { host: target.host, port: target.port };
  }
  return { path: socketEndpoint(target.socketPath) };
}

/**
 * توضیحِ انسانیِ هدف، برای `/gateway/projects` و لاگ.
 *
 * نشانیِ واقعی worker را لو نمی‌دهد (توکن هرگز اینجا نمی‌آید)، فقط همان
 * چیزی که برای عیب‌یابی لازم است: «روی چه چیزی گوش می‌دهد».
 */
export function describeTarget(target: WorkerTarget): string {
  return target.transport === 'loopback'
    ? `${target.transport}:${target.host}:${target.port}`
    : `${target.transport}:${target.socketPath}`;
}

/** یک پورتِ آزادِ loopback رزرو می‌کند (فقط برای گرفتن شماره). */
export async function allocateLoopbackPort(host = '127.0.0.1'): Promise<number> {
  const net = require('net') as typeof import('net');
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, host, () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => {
        if (port > 0) resolve(port);
        else reject(new Error(`could not allocate a loopback port on ${host}`));
      });
    });
  });
}

/** transportِ اعلام‌شده؛ ناشناخته یعنی `socket` (رفتارِ تاریخی). */
export function normalizeTransport(value: WorkerTransport | string | undefined): 'socket' | 'loopback' {
  return value === 'loopback' ? 'loopback' : 'socket';
}
