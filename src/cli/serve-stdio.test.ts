/**
 * `serve --stdio` in a real process: the server must keep answering after
 * `initialize` and exit cleanly once the client closes stdin.
 *
 * Regression: `start()` used to return as soon as the transport was attached,
 * so the command closed the server right after the handshake and an MCP
 * client (Claude Code, Cursor, ...) never received a tool list.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawn, ChildProcess } from 'child_process';

const PACKAGE_ROOT = path.join(__dirname, '..', '..');
const BIN = path.join(PACKAGE_ROOT, 'bin', 'semantic-engine.js');

const built = fs.existsSync(path.join(PACKAGE_ROOT, 'dist', 'cli', 'main.js'));
const describeIfBuilt = built ? describe : describe.skip;

interface RpcReply {
  readonly id?: number;
  readonly result?: Record<string, unknown>;
  readonly error?: unknown;
}

/** Collects newline-delimited JSON-RPC replies and resolves waiters by id. */
function replyReader(child: ChildProcess): (id: number, timeoutMs?: number) => Promise<RpcReply> {
  const replies = new Map<number, RpcReply>();
  const waiters = new Map<number, (reply: RpcReply) => void>();
  let buffer = '';
  child.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (line === '') continue;
      const reply = JSON.parse(line) as RpcReply;
      if (typeof reply.id !== 'number') continue;
      replies.set(reply.id, reply);
      waiters.get(reply.id)?.(reply);
    }
  });
  return (id, timeoutMs = 20000) =>
    new Promise((resolve, reject) => {
      const ready = replies.get(id);
      if (ready) return resolve(ready);
      const timer = setTimeout(() => reject(new Error(`no reply to request ${id}`)), timeoutMs);
      waiters.set(id, reply => {
        clearTimeout(timer);
        resolve(reply);
      });
    });
}

describeIfBuilt('serve --stdio (real process)', () => {
  let root: string;
  let dataDir: string;
  let child: ChildProcess | undefined;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'se-stdio-root-'));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-stdio-data-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(
      path.join(root, 'src', 'math.ts'),
      'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
      'utf8'
    );
    execFileSync(process.execPath, [BIN, 'index', '--root', root], {
      env: { ...process.env, SEMANTIC_ENGINE_DATA_DIR: dataDir },
      stdio: 'ignore',
    });
  });

  afterAll(() => {
    child?.kill('SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('answers tools/list and tools/call after initialize, then exits when stdin closes', async () => {
    child = spawn(process.execPath, [BIN, 'serve', '--stdio', '--root', root, '--no-watch'], {
      env: { ...process.env, SEMANTIC_ENGINE_DATA_DIR: dataDir },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const exited = new Promise<number | null>(resolve => child!.once('exit', code => resolve(code)));
    const reply = replyReader(child);
    const send = (message: Record<string, unknown>): void => {
      child!.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    };

    send({
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'jest', version: '1' } },
    });
    const init = await reply(1);
    expect((init.result?.serverInfo as { name: string }).name).toBe('semantic-engine');
    send({ method: 'notifications/initialized' });

    /* the old server was already gone by now */
    await new Promise(resolve => setTimeout(resolve, 1500));

    send({ id: 2, method: 'tools/list' });
    const tools = (await reply(2)).result?.tools as readonly { name: string }[];
    expect(tools.length).toBeGreaterThan(0);

    send({ id: 3, method: 'tools/call', params: { name: 'find_symbol', arguments: { name: 'add' } } });
    const call = await reply(3);
    expect(call.error).toBeUndefined();
    expect(JSON.stringify(call.result)).toContain('add');

    child.stdin!.end();
    expect(await exited).toBe(0);
  }, 60000);
});
