import {
  FrameDecoder,
  MAX_FRAME_BYTES,
  OPCODE,
  computeAcceptKey,
  encodeFrame,
  handshakeResponse,
  isWebSocketUpgrade,
  maskPayload,
} from './wsProtocol';
import * as http from 'http';

function upgradeRequest(headers: Record<string, string> = {}): http.IncomingMessage {
  return {
    headers: {
      upgrade: 'websocket',
      connection: 'Upgrade',
      ...headers,
    },
  } as unknown as http.IncomingMessage;
}

describe('wsProtocol — RFC 6455 pieces', () => {
  it('computes the accept key from the RFC example', () => {
    /* RFC 6455 §1.3: this pair is the normative example. */
    expect(computeAcceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });

  it('recognizes an upgrade request and rejects the rest', () => {
    expect(isWebSocketUpgrade(upgradeRequest())).toBe(true);
    expect(isWebSocketUpgrade(upgradeRequest({ connection: 'keep-alive, Upgrade' }))).toBe(true);
    expect(isWebSocketUpgrade(upgradeRequest({ upgrade: 'h2c' }))).toBe(false);
    expect(isWebSocketUpgrade(upgradeRequest({ connection: 'keep-alive' }))).toBe(false);
    expect(isWebSocketUpgrade({ headers: {} } as unknown as http.IncomingMessage)).toBe(false);
  });

  it('answers with 101 and the project header', () => {
    const response = handshakeResponse('dGhlIHNhbXBsZSBub25jZQ==', 'prj-app-12345678');

    expect(response.startsWith('HTTP/1.1 101 Switching Protocols\r\n')).toBe(true);
    expect(response).toContain('Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
    expect(response).toContain('X-Semantic-Project-Id: prj-app-12345678');
    expect(response.endsWith('\r\n\r\n')).toBe(true);
  });

  it('masks and unmasks a payload symmetrically', () => {
    const key = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);
    const payload = Buffer.from('Hello');
    const masked = maskPayload(payload, key);

    expect(masked.equals(payload)).toBe(false);
    expect(maskPayload(masked, key).equals(payload)).toBe(true);
  });

  it('round-trips a text frame through the decoder', () => {
    const decoder = new FrameDecoder();
    const frames = decoder.push(encodeFrame(OPCODE.TEXT, '{"hello":1}'));

    expect(frames).toHaveLength(1);
    expect(frames[0]!.opcode).toBe(OPCODE.TEXT);
    expect(frames[0]!.fin).toBe(true);
    expect(frames[0]!.payload.toString('utf8')).toBe('{"hello":1}');
  });

  it('round-trips a masked frame, as a client sends it', () => {
    const decoder = new FrameDecoder();
    const frames = decoder.push(encodeFrame(OPCODE.TEXT, 'masked payload', { mask: true }));

    expect(frames).toHaveLength(1);
    expect(frames[0]!.payload.toString('utf8')).toBe('masked payload');
  });

  it.each([
    ['short', 10],
    ['16-bit length', 1000],
    ['64-bit length', 70_000],
  ])('round-trips a %s payload', (_name, size) => {
    const payload = Buffer.alloc(size, 0x61);
    const frames = new FrameDecoder().push(encodeFrame(OPCODE.TEXT, payload));

    expect(frames).toHaveLength(1);
    expect(frames[0]!.payload.length).toBe(size);
    expect(frames[0]!.payload.equals(payload)).toBe(true);
  });

  it('reassembles a frame split across two chunks', () => {
    const encoded = encodeFrame(OPCODE.TEXT, 'split across segments');
    const decoder = new FrameDecoder();

    expect(decoder.push(encoded.subarray(0, 5))).toHaveLength(0);

    const frames = decoder.push(encoded.subarray(5));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.payload.toString('utf8')).toBe('split across segments');
  });

  it('returns two frames that arrive in one chunk', () => {
    const both = Buffer.concat([
      encodeFrame(OPCODE.TEXT, 'first'),
      encodeFrame(OPCODE.PING, 'ping'),
    ]);

    const frames = new FrameDecoder().push(both);
    expect(frames.map(frame => frame.opcode)).toEqual([OPCODE.TEXT, OPCODE.PING]);
    expect(frames[0]!.payload.toString('utf8')).toBe('first');
  });

  it('keeps control opcodes distinguishable', () => {
    const frames = new FrameDecoder().push(encodeFrame(OPCODE.CLOSE, Buffer.alloc(2)));
    expect(frames[0]!.opcode).toBe(OPCODE.CLOSE);
  });

  it('refuses a frame larger than the limit', () => {
    /* A hand-built header claiming more than MAX_FRAME_BYTES. */
    const header = Buffer.alloc(10);
    header[0] = 0x80 | OPCODE.TEXT;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(MAX_FRAME_BYTES + 1, 6);

    expect(() => new FrameDecoder().push(header)).toThrow(/exceeds the/);
  });
});
