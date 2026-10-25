/**
 * WebSocket upgrade proxy for `/ws/projects/:id`: authenticate at the Gateway,
 * then splice the client socket to the project's worker. The worker never sees
 * the client's credentials or origin.
 */

import * as http from 'http';
import * as net from 'net';
import type { Duplex } from 'stream';
import { GatewayAuth } from './GatewayAuth';
import { netConnectOptions } from './workerTarget';
import { ProjectRegistry } from '../core/config/ProjectRegistry';
import { WorkerSupervisor } from './WorkerSupervisor';

export interface GatewayUpgradeDeps {
  readonly auth: GatewayAuth;
  readonly registry: ProjectRegistry;
  readonly supervisor: WorkerSupervisor;
}

export function handleGatewayUpgrade(
  deps: GatewayUpgradeDeps,
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer
): void {
  const { auth: gatewayAuth, registry, supervisor } = deps;
  const fail = (status: number, reason: string): void => {
    if (!socket.destroyed) {
      socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    }
  };

  const url = new URL(req.url ?? '/', 'http://gateway.local');
  const match = /^\/ws\/projects\/([^/]+)$/.exec(url.pathname);
  if (!match) {
    fail(404, 'Not Found');
    return;
  }
  const projectId = match[1]!;

  const auth = gatewayAuth.verify(req, url.searchParams.get('token') ?? undefined);
  if (!auth.authenticated || !auth.record) {
    fail(401, 'Unauthorized');
    return;
  }
  if (!registry.get(projectId)) {
    fail(404, 'Not Found');
    return;
  }
  if (!gatewayAuth.canAccessProject(auth.record, projectId)) {
    fail(403, 'Forbidden');
    return;
  }

  const worker = supervisor.get(projectId);
  if (!worker || worker.pid === null || worker.exitCode !== null) {
    fail(502, 'Bad Gateway');
    return;
  }

  const workerToken = supervisor.workerToken(projectId) ?? '';

  /*
  | F-0007 — upgrade هم transport را محترم می‌شمارد: `loopback` با
  | host/port و وگرنه با نشانیِ سوکت (که خودش روی ویندوز به لولهٔ
  | نام‌دار نگاشت می‌شود).
  */
  const upstream = net.connect(netConnectOptions(worker.target), () => {
    const lines = [`${req.method ?? 'GET'} /ws HTTP/1.1`, 'Host: gateway'];

    for (const [name, value] of Object.entries(req.headers)) {
      const lower = name.toLowerCase();
      /* Origin و Authorization کلاینت forward نمی‌شوند؛ هدرهای hop-by-hop هم نه. */
      if (lower === 'origin' || lower === 'authorization' || lower === 'host') continue;
      if (lower === 'connection' || lower === 'keep-alive') continue;
      /*
      | `Upgrade` و `Connection` را خودمان و به‌شکل صحیح می‌فرستیم. حذف
      | `Connection: Upgrade` — که برای یک proxy معمولی درست است — باعث
      | می‌شود Node در worker اصلاً رویداد `upgrade` را نبیند و درخواست به
      | جدول روت‌ها بیفتد: اندازه‌گیری‌شده، worker مستقیم `101` می‌داد و
      | از پشت Gateway `404`.
      */
      if (lower === 'upgrade') continue;
      if (value === undefined) continue;
      lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`);
    }

    lines.push('Upgrade: websocket');
    lines.push('Connection: Upgrade');
    lines.push(`Authorization: Bearer ${workerToken}`);
    lines.push(`X-Forwarded-For: ${req.socket.remoteAddress ?? '127.0.0.1'}`);
    lines.push('X-Forwarded-Proto: http');
    lines.push(`X-Forwarded-Host: ${typeof req.headers['host'] === 'string' ? req.headers['host'] : 'gateway'}`);
    lines.push(`X-Semantic-Project-Id: ${projectId}`);
    lines.push('', '');

    upstream.write(lines.join('\r\n'));
    if (head.length > 0) upstream.write(head);

    /* از این لحظه به بعد فقط بایت جابه‌جا می‌شود. */
    socket.pipe(upstream);
    upstream.pipe(socket);
  });

  upstream.on('error', () => fail(502, 'Bad Gateway'));
  socket.on('error', () => upstream.destroy());
  /* بسته شدن هر طرف، طرف دیگر را هم می‌بندد: connection یتیم نمی‌ماند. */
  socket.on('close', () => upstream.destroy());
  upstream.on('close', () => {
    if (!socket.destroyed) socket.destroy();
  });
}
