import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StaticAssetServer } from './StaticAssetServer';

function fakeRes() {
  const state: { status?: number; body?: Buffer } = {};
  const res = {
    writeHead: (status: number) => { state.status = status; },
    end: (body?: Buffer) => { state.body = body; },
  };
  return { res: res as never, state };
}

describe('StaticAssetServer', () => {
  let base: string;
  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'se-static-'));
    fs.mkdirSync(path.join(base, 'public'));
    fs.mkdirSync(path.join(base, 'public-evil'));
    fs.writeFileSync(path.join(base, 'public', 'open.html'), '<h1>ok</h1>');
    fs.writeFileSync(path.join(base, 'public-evil', 'secret.txt'), 'secret');
  });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  it('serves the open page for / and refuses a sibling directory sharing the prefix', async () => {
    const server = new StaticAssetServer(path.join(base, 'public'));

    const ok = fakeRes();
    expect(await server.serve('/', ok.res)).toBe(true);
    expect(ok.state.status).toBe(200);

    const evil = fakeRes();
    expect(await server.serve('/../public-evil/secret.txt', evil.res)).toBe(false);
    expect(evil.state.status).toBeUndefined();
  });
});
