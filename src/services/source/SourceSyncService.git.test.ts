/**
 * F-09 — `syncFromGit` against a real git smart-HTTP server on localhost.
 * Skipped when `git http-backend` is not installed.
 */

import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { SourceSyncService, SourceValidationError } from './SourceSyncService';

function gitBackend(): string | null {
  try {
    const exec = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
    const candidate = path.join(exec, process.platform === 'win32' ? 'git-http-backend.exe' : 'git-http-backend');
    return fs.existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

const BACKEND = gitBackend();
const maybe = BACKEND ? describe : describe.skip;

function serveGit(root: string, requireAuth: boolean): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    if (requireAuth) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git"' });
      res.end('auth required');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://local');
    const child = spawn(BACKEND!, [], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        REQUEST_METHOD: req.method ?? 'GET',
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: String(req.headers['content-type'] ?? ''),
        REMOTE_ADDR: '127.0.0.1',
      },
    });
    req.pipe(child.stdin);
    let head = '';
    let started = false;
    child.stdout.on('data', (chunk: Buffer) => {
      if (started) {
        res.write(chunk);
        return;
      }
      head += chunk.toString('latin1');
      const split = head.indexOf('\r\n\r\n');
      if (split === -1) return;
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of head.slice(0, split).split('\r\n')) {
        const [k, ...v] = line.split(':');
        if (k!.toLowerCase() === 'status') status = parseInt(v.join(':').trim(), 10);
        else headers[k!] = v.join(':').trim();
      }
      res.writeHead(status, headers);
      res.write(Buffer.from(head.slice(split + 4), 'latin1'));
      started = true;
    });
    child.on('close', () => res.end());
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port })));
}

maybe('SourceSyncService.syncFromGit over HTTP', () => {
  let base: string;
  const servers: http.Server[] = [];

  beforeAll(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-gitsync-')));
    const work = path.join(base, 'work');
    fs.mkdirSync(work);
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: work, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(work, 'a.ts'), 'export const a = 1;\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    fs.mkdirSync(path.join(base, 'repos'));
    execFileSync('git', ['clone', '-q', '--bare', work, path.join(base, 'repos', 'demo.git')]);
  });

  afterAll(async () => {
    await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve))));
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('clones a public repository into the project root', async () => {
    const { server, port } = await serveGit(path.join(base, 'repos'), false);
    servers.push(server);
    const target = path.join(base, 'target-ok');
    const result = await new SourceSyncService().syncFromGit('p', target, { repoUrl: `http://127.0.0.1:${port}/demo.git` });
    expect(result.source).toBe('git');
    expect(result.commitHash).toMatch(/^[0-9a-f]{40}$/);
    expect(fs.readFileSync(path.join(target, 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
  }, 30_000);

  it('fails fast with 502 when the repository needs credentials, instead of waiting on a prompt', async () => {
    const { server, port } = await serveGit(path.join(base, 'repos'), true);
    servers.push(server);
    const started = Date.now();
    const failure = await new SourceSyncService()
      .syncFromGit('p', path.join(base, 'target-auth'), { repoUrl: `http://user:hunter2@127.0.0.1:${port}/demo.git` })
      .then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(SourceValidationError);
    expect((failure as SourceValidationError).status).toBe(502);
    expect((failure as SourceValidationError).message).not.toContain('hunter2');
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);
});
