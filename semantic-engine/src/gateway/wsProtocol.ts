/**
 * Minimal RFC 6455 pieces — فاز ۱۱.
 *
 * Deliberately dependency-free (rule 14: no new dependency without a recorded
 * reason). What a project-scoped WebSocket channel needs is small: the
 * handshake accept key, frame encoding, and an incremental decoder that
 * survives a frame split across TCP segments.
 *
 * Scope on purpose: text, ping, pong and close. No fragmentation reassembly
 * beyond keeping continuation frames intact, no extensions, no compression —
 * and any of those, if ever needed, is a change here rather than a new
 * dependency.
 */

import * as crypto from 'crypto';
import * as http from 'http';

export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
} as const;

/** سقف اندازهٔ یک فریم؛ بزرگ‌تر از این یعنی اشتباه در طرف مقابل. */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

export function computeAcceptKey(secWebSocketKey: string): string {
  return crypto
    .createHash('sha1')
    .update(`${secWebSocketKey.trim()}${WS_GUID}`)
    .digest('base64');
}

export function isWebSocketUpgrade(req: http.IncomingMessage): boolean {
  const upgrade = String(req.headers['upgrade'] ?? '').toLowerCase();
  const connection = String(req.headers['connection'] ?? '').toLowerCase();
  return upgrade === 'websocket' && connection.split(',').some(part => part.trim() === 'upgrade');
}

/** پاسخ `101 Switching Protocols` به‌صورت متن خام. */
export function handshakeResponse(secWebSocketKey: string, projectId: string): string {
  return [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${computeAcceptKey(secWebSocketKey)}`,
    `X-Semantic-Project-Id: ${projectId}`,
    '',
    '',
  ].join('\r\n');
}

export function maskPayload(payload: Buffer, maskingKey: Buffer): Buffer {
  const out = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i += 1) {
    out[i] = payload[i]! ^ maskingKey[i % 4]!;
  }
  return out;
}

export interface EncodeFrameOptions {
  /** کلاینت‌ها باید mask بزنند؛ سرور نباید. */
  readonly mask?: boolean;
  readonly fin?: boolean;
}

export function encodeFrame(
  opcode: number,
  payload: Buffer | string = '',
  options: EncodeFrameOptions = {}
): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const fin = options.fin ?? true;
  const masked = options.mask ?? false;

  const parts: Buffer[] = [];

  const first = Buffer.alloc(2);
  first[0] = fin ? 0x80 | opcode : opcode;

  if (body.length < 126) {
    first[1] = (masked ? 0x80 : 0) | body.length;
    parts.push(first);
  } else if (body.length < 65536) {
    first[1] = (masked ? 0x80 : 0) | 126;
    const extended = Buffer.alloc(2);
    extended.writeUInt16BE(body.length, 0);
    parts.push(first, extended);
  } else {
    first[1] = (masked ? 0x80 : 0) | 127;
    const extended = Buffer.alloc(8);
    /* ۶۴ بیت؛ JS تا ۵۳ بیت دقیق است، پس نیمهٔ بالا از تقسیم به دست می‌آید. */
    extended.writeUInt32BE(Math.floor(body.length / 2 ** 32), 0);
    extended.writeUInt32BE(body.length >>> 0, 4);
    parts.push(first, extended);
  }

  const maskingKey = masked ? crypto.randomBytes(4) : Buffer.alloc(0);
  if (masked) parts.push(maskingKey);
  parts.push(masked ? maskPayload(body, maskingKey) : body);

  return Buffer.concat(parts);
}

export interface DecodedFrame {
  readonly fin: boolean;
  readonly opcode: number;
  readonly payload: Buffer;
}

/**
 * دیکدر تدریجی: هر chunk را می‌گیرد و هر فریم کامل را برمی‌گرداند. باقیمانده
 * نگه داشته می‌شود، چون یک فریم می‌تواند بین دو segment تقسیم شود.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): DecodedFrame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    const frames: DecodedFrame[] = [];
    for (;;) {
      const frame = this.tryReadFrame();
      if (!frame) break;
      frames.push(frame);
    }
    return frames;
  }

  private tryReadFrame(): DecodedFrame | null {
    const buf = this.buffer;
    if (buf.length < 2) return null;

    const fin = (buf[0]! & 0x80) !== 0;
    const opcode = buf[0]! & 0x0f;
    const masked = (buf[1]! & 0x80) !== 0;
    let length = buf[1]! & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (buf.length < offset + 2) return null;
      length = buf.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buf.length < offset + 8) return null;
      const high = buf.readUInt32BE(offset);
      const low = buf.readUInt32BE(offset + 4);
      length = high * 2 ** 32 + low;
      offset += 8;
    }

    if (length > MAX_FRAME_BYTES) {
      throw new Error(`websocket frame of ${length} bytes exceeds the ${MAX_FRAME_BYTES} limit`);
    }

    let maskingKey = Buffer.alloc(0);
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskingKey = Buffer.from(buf.subarray(offset, offset + 4));
      offset += 4;
    }

    if (buf.length < offset + length) return null;

    const raw = buf.subarray(offset, offset + length);
    const payload = masked ? maskPayload(Buffer.from(raw), maskingKey) : Buffer.from(raw);
    /*
    | `Buffer.from` یک کپی می‌سازد: `subarray` همان حافظه را نگه می‌دارد و
    | نوعش `ArrayBufferLike` است، پس به فیلد `Buffer` نمی‌خورد — و نگه‌داشتن
    | کل بافر قبلی زنده هم بی‌دلیل است.
    */
    this.buffer = Buffer.from(buf.subarray(offset + length));

    return { fin, opcode, payload };
  }
}
