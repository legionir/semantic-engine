/**
 * WebSocket through the Gateway — فاز ۱۱, measured end to end.
 *
 * Real workers, real sockets, real frames: the test speaks RFC 6455 itself
 * (there is no `ws` dependency in this project, by design), so what is
 * exercised is the same handshake and framing a browser would use.
 *
 * Criteria:
 *   - projectId is resolved *before* the upgrade — an unknown project, a
 *     missing token and a token without the project never reach a worker;
 *   - messages stay inside their project;
 *   - closing one client does not close the others.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { GatewayServer } from './GatewayServer';
import { FrameDecoder, OPCODE, encodeFrame } from './wsProtocol';

const PACKAGE_ROOT = path.join(__dirname, '..', '..');
const built = fs.existsSync(path.join(PACKAGE_ROOT, 'dist', 'cli', 'main.js'));
const describeIfBuilt = built ? describe : describe.skip;

interface WsClient {
  readonly status: number;
  readonly headers: string;
  readonly messages: string[];
  send(text: string): void;
  close(): void;
  readonly socket: net.Socket;
}

function connectWs(port: number, urlPath: string, token?: string): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const key = crypto.randomBytes(16).toString('base64');
    const messages: string[] = [];
    const decoder = new FrameDecoder();
    let head = '';
    let status = 0;
    let handshakeDone = false;

    const client: WsClient = {
      get status() {
        return status;
      },
      get headers() {
        return head;
      },
      messages,
      socket,
      send(text: string) {
        /* کلاینت باید mask بزند؛ سرور بدون mask رد می‌کند. */
        socket.write(encodeFrame(OPCODE.TEXT, text, { mask: true }));
      },
      close() {
        socket.write(encodeFrame(OPCODE.CLOSE, Buffer.from([0x03, 0xe8]), { mask: true }));
        socket.end();
      },
    };

    socket.on('connect', () => {
      socket.write(
        [
          `GET ${urlPath} HTTP/1.1`,
          'Host: localhost',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          ...(token ? [`Authorization: Bearer ${token}`] : []),
          '',
          '',
        ].join('\r\n')
      );
    });

    socket.on('data', chunk => {
      if (!handshakeDone) {
        head += chunk.toString('binary');
        const split = head.indexOf('\r\n\r\n');
        if (split === -1) return;

        const statusLine = head.slice(0, head.indexOf('\r\n'));
        status = Number(statusLine.split(' ')[1]);
        handshakeDone = true;

        const rest = Buffer.from(head.slice(split + 4), 'binary');
        head = head.slice(0, split + 4);
        if (status !== 101) {
          resolve(client);
          return;
        }
        if (rest.length > 0) consume(rest);
        resolve(client);
        return;
      }
      consume(chunk as Buffer);
    });

    const consume = (bytes: Buffer): void => {
      let frames;
      try {
        frames = decoder.push(bytes);
      } catch {
        return;
      }
      for (const frame of frames) {
        if (frame.opcode === OPCODE.TEXT) messages.push(frame.payload.toString('utf8'));
      }
    };

    socket.on('error', reject);
    socket.setTimeout(30_000, () => reject(new Error('websocket timed out')));
  });
}

const received = async (client: WsClient, timeoutMs = 15_000): Promise<string> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (client.messages.length > 0) return client.messages.join('|');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return '';
};

describeIfBuilt('WebSocket through the Gateway', () => {
  let base: string;
  let gateway: GatewayServer;
  let port: number;
  let token: string;
  let idA: string;
  let idB: string;

  const makeProject = (name: string, marker: string): string => {
    const root = path.join(base, name);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'src', 'a.ts'),
      `export function ${marker}(): number { return 1; }\n`
    );
    return root;
  };

  const register = async (rootPath: string, name: string): Promise<string> => {
    const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const payload = JSON.stringify({ path: rootPath, name, autoStart: true });
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/v1/gateway/projects',
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        res => {
          const chunks: Buffer[] = [];
          res.on('data', chunk => chunks.push(chunk as Buffer));
          res.on('end', () =>
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
          );
        }
      );
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
    return String(reply['id']);
  };

  beforeAll(async () => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-gw-ws-')));

    gateway = new GatewayServer({
      dataRoot: path.join(base, 'data'),
      port: 0,
      host: '127.0.0.1',
      token: 'gateway-ws-token',
    });
    const info = await gateway.start();
    port = info.port;
    token = info.token;

    idA = await register(makeProject('app-a', 'alpha'), 'App A');
    idB = await register(makeProject('app-b', 'beta'), 'App B');
  }, 300_000);

  afterAll(async () => {
    await gateway.stop();
    fs.rmSync(base, { recursive: true, force: true });
  }, 120_000);

  it('completes the handshake and greets the client with its project', async () => {
    const client = await connectWs(port, `/ws/projects/${idA}`, token);

    expect(client.status).toBe(101);
    expect(client.headers).toContain('X-Semantic-Project-Id: ' + idA);

    const hello = await received(client);
    expect(hello).toContain('"type":"hello"');
    expect(hello).toContain(`"projectId":"${idA}"`);

    client.close();
  }, 60_000);

  it('keeps messages inside their project and survives one client leaving', async () => {
    const a1 = await connectWs(port, `/ws/projects/${idA}`, token);
    const a2 = await connectWs(port, `/ws/projects/${idA}`, token);
    const b = await connectWs(port, `/ws/projects/${idB}`, token);

    expect(a1.status).toBe(101);
    expect(a2.status).toBe(101);
    expect(b.status).toBe(101);

    /* Wait for the greetings so they are not mistaken for the test message. */
    await received(a2);
    await received(b);
    a2.messages.length = 0;
    b.messages.length = 0;

    a1.send(JSON.stringify({ type: 'agent.graph.command', targetNodes: ['n1'] }));

    const seenByA2 = await received(a2);
    expect(seenByA2).toContain('agent.graph.command');
    expect(seenByA2).toContain(`"projectId":"${idA}"`);

    /* B must see nothing at all. */
    await new Promise(resolve => setTimeout(resolve, 1_500));
    expect(b.messages).toHaveLength(0);

    /* Closing one client of A leaves the others connected. */
    a1.close();
    await new Promise(resolve => setTimeout(resolve, 1_000));
    expect(a2.socket.destroyed).toBe(false);
    expect(b.socket.destroyed).toBe(false);

    a2.close();
    b.close();
  }, 120_000);

  it('does not upgrade for an unknown project, a missing token, or a foreign project', async () => {
    const unknown = await connectWs(port, '/ws/projects/prj-nope-00000000', token);
    expect(unknown.status).toBe(404);

    const anonymous = await connectWs(port, `/ws/projects/${idA}`);
    expect(anonymous.status).toBe(401);

    const scoped = gateway.auth.issueToken({
      name: 'only-b',
      allowedProjects: [idB],
      permissions: ['project:read'],
    });
    const foreign = await connectWs(port, `/ws/projects/${idA}`, scoped.token);
    expect(foreign.status).toBe(403);

    const own = await connectWs(port, `/ws/projects/${idB}`, scoped.token);
    expect(own.status).toBe(101);
    own.close();
  }, 120_000);
});
