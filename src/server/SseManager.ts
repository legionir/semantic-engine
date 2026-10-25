/**
 * SseManager — Server-Sent Events stream manager for real-time progress & updates.
 */

import * as http from 'http';

export interface SseClient {
  readonly id: string;
  readonly projectId: string;
  readonly res: http.ServerResponse;
  readonly connectedAt: number;
}

export interface SseEvent {
  readonly type: string;
  readonly data: unknown;
  readonly id?: string;
}

export class SseManager {
  private readonly clients = new Map<string, SseClient>();
  private heartbeatTimer?: NodeJS.Timeout;

  constructor() {
    this.startHeartbeat();
  }

  /**
   * افزودن یک کلاینت جدید به استریم SSE یک پروژه.
   */
  addClient(projectId: string, req: http.IncomingMessage, res: http.ServerResponse): SseClient {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const clientId = `sse-${Math.random().toString(36).slice(2, 9)}`;
    const client: SseClient = {
      id: clientId,
      projectId,
      res,
      connectedAt: Date.now(),
    };

    this.clients.set(clientId, client);

    // Initial handshake message
    this.sendToClient(client, {
      type: 'connected',
      data: { clientId, projectId, serverTime: Date.now() },
    });

    const cleanup = () => {
      this.clients.delete(clientId);
    };

    req.on('close', cleanup);
    req.on('end', cleanup);
    res.on('close', cleanup);

    return client;
  }

  /**
   * ارسال رویداد به تمام کلاینت‌های متصل به یک پروژه.
   */
  broadcast(projectId: string, event: SseEvent): void {
    const serialized = this.formatEvent(event);
    for (const client of this.clients.values()) {
      if (client.projectId === projectId || client.projectId === '*') {
        try {
          client.res.write(serialized);
        } catch {
          this.clients.delete(client.id);
        }
      }
    }
  }

  private sendToClient(client: SseClient, event: SseEvent): void {
    try {
      client.res.write(this.formatEvent(event));
    } catch {
      this.clients.delete(client.id);
    }
  }

  private formatEvent(event: SseEvent): string {
    const lines = [`event: ${event.type}`];
    if (event.id) {
      lines.push(`id: ${event.id}`);
    }
    const dataStr = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
    lines.push(`data: ${dataStr}`);
    return lines.join('\n') + '\n\n';
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const [id, client] of this.clients.entries()) {
        try {
          client.res.write(': ping\n\n');
        } catch {
          this.clients.delete(id);
        }
      }
    }, 15000);
    this.heartbeatTimer.unref();
  }

  close(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    for (const client of this.clients.values()) {
      try {
        client.res.end();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }

  get activeClientsCount(): number {
    return this.clients.size;
  }
}
