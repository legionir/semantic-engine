/**
 * Phase 1 / step 4 — executable shared invariants for semantic-engine.
 *
 * These pin the contracts that structured-ai also relies on (see
 * docs/contracts/shared-invariants.md): project identity, ownership, graph
 * traversal defaults, cancellation and the API error format. Each test runs
 * against real code; nothing here is mocked.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { assertProjectRoot, canonicalizeRoot, isSafeProjectId, projectIdFor } from '../config/ProjectIdentity';
import { resolveProjectPaths } from '../config/ProjectPaths';
import { ProjectRegistry } from '../config/ProjectRegistry';
import { CancellationTokenSource } from '../../host/Cancellation';
import {
  DEFAULT_GRAPH_DEPTH,
  DEFAULT_GRAPH_DIRECTION,
  DEFAULT_GRAPH_MAX_NODES,
  DEFAULT_GRAPH_MIN_CONFIDENCE,
  DEFAULT_GRAPH_PATH_DEPTH,
  validateGraphTraversalOptions,
} from '../../graphs/GraphQueryEngine';
import { HttpServer } from '../../server/HttpServer';

let base: string;

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-contracts-')));
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function makeRoot(...parts: string[]): string {
  const root = path.join(base, ...parts);
  fs.mkdirSync(root, { recursive: true });
  return fs.realpathSync(root);
}

describe('contract: project identity (projectId + workspaceRoot)', () => {
  it('derives a different id for two roots that share a directory name, and the same id for the same root', () => {
    const a = makeRoot('a', 'app');
    const b = makeRoot('b', 'app');
    expect(projectIdFor('app', canonicalizeRoot(a))).not.toBe(projectIdFor('app', canonicalizeRoot(b)));
    expect(projectIdFor('app', canonicalizeRoot(a))).toBe(projectIdFor('app', canonicalizeRoot(a)));
  });

  it('refuses ids that could escape the data root and roots that do not exist', () => {
    for (const bad of ['', '..', '../x', 'a/b', 'a\\b', '.hidden']) {
      expect(isSafeProjectId(bad)).toBe(false);
    }
    expect(() => assertProjectRoot(path.join(base, 'does-not-exist'))).toThrow();
    expect(() =>
      resolveProjectPaths({ projectId: '../evil', workspaceRoot: makeRoot('w'), dataRoot: path.join(base, 'data') })
    ).toThrow();
  });

  it('keeps each project artifact root separate and outside the other project', () => {
    const dataRoot = path.join(base, 'data-iso');
    const one = resolveProjectPaths({ projectId: 'one', workspaceRoot: makeRoot('one'), dataRoot, location: 'external' });
    const two = resolveProjectPaths({ projectId: 'two', workspaceRoot: makeRoot('two'), dataRoot, location: 'external' });
    expect(one.artifactRoot).not.toBe(two.artifactRoot);
    expect(path.relative(one.artifactRoot, two.artifactRoot).startsWith('..')).toBe(true);
    expect(one.workspaceRoot).not.toBe(two.workspaceRoot);
  });
});

describe('contract: ownership validation', () => {
  it('resolves ids to the owning project only, and never to another', () => {
    const registry = new ProjectRegistry({ dataRoot: path.join(base, 'data-own') });
    const a = registry.register({ rootPath: makeRoot('own-a'), name: 'a', id: 'alpha' });
    const b = registry.register({ rootPath: makeRoot('own-b'), name: 'b', id: 'beta' });
    expect(registry.get('alpha')?.rootPath).toBe(a.rootPath);
    expect(registry.get('beta')?.rootPath).toBe(b.rootPath);
    expect(registry.get('gamma')).toBeUndefined();
    expect(registry.getByRoot(a.rootPath)?.id).toBe('alpha');
  });

  it('removing one project never touches the other', () => {
    const registry = new ProjectRegistry({ dataRoot: path.join(base, 'data-rm') });
    registry.register({ rootPath: makeRoot('rm-a'), name: 'a', id: 'rm-alpha' });
    registry.register({ rootPath: makeRoot('rm-b'), name: 'b', id: 'rm-beta' });
    expect(registry.remove('rm-alpha')).toBe(true);
    expect(registry.get('rm-beta')).toBeDefined();
    expect(registry.list()).toHaveLength(1);
  });
});

describe('contract: graph traversal defaults and validation', () => {
  it('exposes one set of defaults shared by the traversals', () => {
    expect(DEFAULT_GRAPH_DEPTH).toBe(2);
    expect(DEFAULT_GRAPH_PATH_DEPTH).toBeGreaterThan(DEFAULT_GRAPH_DEPTH);
    expect(DEFAULT_GRAPH_DIRECTION).toBe('out');
    expect(DEFAULT_GRAPH_MAX_NODES).toBeGreaterThan(0);
    expect(DEFAULT_GRAPH_MIN_CONFIDENCE).toBeGreaterThan(0);
  });

  it('rejects invalid options loudly instead of clamping them', () => {
    expect(() => validateGraphTraversalOptions({ depth: -1 })).toThrow();
    expect(() => validateGraphTraversalOptions({ depth: 1.5 })).toThrow();
    expect(() => validateGraphTraversalOptions({ maxNodes: -1 })).toThrow();
    expect(() => validateGraphTraversalOptions({ minConfidence: -0.1 })).toThrow();
    expect(() => validateGraphTraversalOptions({ direction: 'sideways' as never })).toThrow();
  });

  it('keeps zero as a real value (0 is not "unset")', () => {
    expect(() => validateGraphTraversalOptions({ depth: 0, maxNodes: 0, minConfidence: 0 })).not.toThrow();
  });
});

describe('contract: cancellation state', () => {
  it('cancel is sticky and idempotent, and dispose does not fake a cancellation', () => {
    const source = new CancellationTokenSource();
    let calls = 0;
    source.token.onCancellationRequested(() => {
      calls += 1;
    });
    expect(source.token.isCancellationRequested).toBe(false);
    source.cancel();
    source.cancel();
    expect(source.token.isCancellationRequested).toBe(true);
    expect(calls).toBe(1);

    const released = new CancellationTokenSource();
    released.dispose();
    expect(released.token.isCancellationRequested).toBe(false);
  });

  it('a linked source is cancelled by its parent', () => {
    const parent = new CancellationTokenSource();
    const child = CancellationTokenSource.link(parent.token);
    parent.cancel();
    expect(child.token.isCancellationRequested).toBe(true);
  });
});

describe('contract: API error format', () => {
  let server: HttpServer;
  let url: string;
  const TOKEN = 'contract-token';

  beforeAll(async () => {
    server = new HttpServer({ port: 0, host: '127.0.0.1', token: TOKEN, projectsRoot: base });
    url = (await server.start()).url;
  });

  afterAll(async () => {
    await server.stop();
  });

  function call(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
      const headers: http.OutgoingHttpHeaders = { Authorization: `Bearer ${TOKEN}` };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const req = http.request(new URL(p, url), { method, headers }, res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c as Buffer));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null });
        });
      });
      req.on('error', reject);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  }

  it('answers every 4xx with a JSON body that carries a non-empty string `error`', async () => {
    const responses = [
      await call('GET', '/api/v1/projects/nope'),
      await call('PATCH', '/api/v1/projects/nope', { name: 'x' }),
      await call('DELETE', '/api/v1/projects/nope'),
      await call('PATCH', '/api/v1/config', { maxBodyBytes: 0 }),
      await call('PATCH', '/api/v1/config', { port: 1 }),
    ];
    for (const res of responses) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(typeof res.json.error).toBe('string');
      expect(res.json.error.length).toBeGreaterThan(0);
    }
  });
});
