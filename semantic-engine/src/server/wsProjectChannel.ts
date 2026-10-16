/**
 * Per-project WebSocket channel — فاز ۱۱, worker side.
 *
 * What this replaces: `WebSocketManager` writes SSE frames into an
 * `http.ServerResponse` and nothing in the codebase performs a WebSocket
 * handshake, so "WebSocket" was a name without a protocol behind it. That
 * manager is left alone (it still serves the visualizer over SSE); this module
 * is the real channel.
 *
 * The worker is single-project, so binding is structural: one channel, one
 * `projectId`, and every frame it sends carries that id. Messages are
 * broadcast to the *other* clients of the same project, which is what the
 * agent-graph commands need and what makes cross-project leakage impossible.
 */

import * as http from 'http';
import type { Duplex } from 'stream';
import {
  FrameDecoder,
  OPCODE,
  encodeFrame,
  handshakeResponse,
  isWebSocketUpgrade,
} from '../gateway/wsProtocol';

export interface ProjectWebSocketChannelOptions {
  readonly projectId: string;
  /** حداکثر کلاینت هم‌زمان؛ بیشتر یعنی رد کردن اتصال جدید. */
  readonly maxClients?: number;
  readonly onEvent?: (event: { type: string; projectId: string; detail?: string }) => void;
}

export const DEFAULT_MAX_WS_CLIENTS = 32;

interface Client {
  readonly socket: Duplex;
  readonly decoder: FrameDecoder;
}

export class ProjectWebSocketChannel {
  private readonly clients = new Set<Client>();
  private closed = false;

  constructor(private readonly options: ProjectWebSocketChannelOptions) {}

  get projectId(): string {
    return this.options.projectId;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  private emit(type: string, detail?: string): void {
    this.options.onEvent?.({
      type,
      projectId: this.options.projectId,
      ...(detail !== undefined ? { detail } : {}),
    });
  }

  /**
   * هندل کردن یک رویداد `upgrade`. اگر مسیر یا هدرها درست نباشند، سوکت
   * بسته می‌شود — یک upgrade نیمه‌انجام‌شده بدترین حالت ممکن است.
   */
  handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    if (this.closed) {
      socket.destroy();
      return;
    }
    if (!isWebSocketUpgrade(req)) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string' || key.trim() === '') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const maxClients = this.options.maxClients ?? DEFAULT_MAX_WS_CLIENTS;
    if (this.clients.size >= maxClients) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      this.emit('rejected', `client limit ${maxClients} reached`);
      return;
    }

    socket.write(handshakeResponse(key, this.options.projectId));

    const client: Client = { socket, decoder: new FrameDecoder() };
    this.clients.add(client);
    this.emit('connected', `${this.clients.size} client(s)`);

    this.send(socket, { type: 'hello', projectId: this.options.projectId });

    if (head.length > 0) this.onBytes(client, head);
    socket.on('data', chunk => this.onBytes(client, chunk as Buffer));
    socket.on('error', () => this.remove(client));
    socket.on('close', () => this.remove(client));
  }

  private onBytes(client: Client, chunk: Buffer): void {
    let frames;
    try {
      frames = client.decoder.push(chunk);
    } catch (error) {
      this.emit('protocol-error', error instanceof Error ? error.message : String(error));
      this.closeClient(client, 1002, 'protocol error');
      return;
    }

    for (const frame of frames) {
      switch (frame.opcode) {
        case OPCODE.PING:
          this.writeFrame(client.socket, OPCODE.PONG, frame.payload);
          break;
        case OPCODE.PONG:
          break;
        case OPCODE.CLOSE:
          this.closeClient(client, 1000, 'closing');
          break;
        case OPCODE.TEXT:
          this.onText(client, frame.payload.toString('utf8'));
          break;
        default:
          /* باینری و continuation جایی در این کانال ندارند. */
          this.closeClient(client, 1003, 'unsupported frame');
      }
    }
  }

  private onText(client: Client, raw: string): void {
    let parsed: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(raw);
      parsed = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : { value };
    } catch {
      parsed = { text: raw };
    }

    /*
    | projectId از خودِ کانال می‌آید، نه از پیام: یک کلاینت نمی‌تواند با
    | نوشتن `projectId` در پیام، پروژهٔ دیگری را هدف نمی‌گیرد.
    */
    const envelope = { ...parsed, projectId: this.options.projectId };
    this.broadcast(envelope, client);
  }

  /** فرستادن به همهٔ کلاینت‌ها به‌جز `except`. */
  broadcast(message: unknown, except?: Client): void {
    const frame = encodeFrame(OPCODE.TEXT, JSON.stringify(message));
    for (const client of this.clients) {
      if (client === except) continue;
      if (!client.socket.destroyed) client.socket.write(frame);
    }
  }

  private send(socket: Duplex, message: unknown): void {
    if (!socket.destroyed) socket.write(encodeFrame(OPCODE.TEXT, JSON.stringify(message)));
  }

  private writeFrame(socket: Duplex, opcode: number, payload: Buffer): void {
    if (!socket.destroyed) socket.write(encodeFrame(opcode, payload));
  }

  private closeClient(client: Client, code: number, reason: string): void {
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    this.writeFrame(client.socket, OPCODE.CLOSE, payload);
    client.socket.end();
    this.remove(client);
  }

  private remove(client: Client): void {
    if (!this.clients.delete(client)) return;
    if (!client.socket.destroyed) client.socket.destroy();
    this.emit('disconnected', `${this.clients.size} client(s) left`);
  }

  /** بستن کل کانال؛ هیچ سوکتی باز نمی‌ماند. */
  close(): void {
    this.closed = true;
    for (const client of [...this.clients]) {
      this.closeClient(client, 1001, 'worker shutting down');
    }
    this.clients.clear();
  }
}
