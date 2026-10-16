/**
 * Platform Core V1 — OpenAPI Contract Sync Test.
 */

import * as fs from 'fs';
import * as path from 'path';

const CONTRACT_PATH = path.join(__dirname, '..', '..', '..', 'contracts', 'platform-v1.openapi.json');

describe('Platform Core V1 — OpenAPI Specification Sync', () => {
  it('contracts/platform-v1.openapi.json exists and is valid JSON', () => {
    expect(fs.existsSync(CONTRACT_PATH)).toBe(true);
    const content = fs.readFileSync(CONTRACT_PATH, 'utf8');
    const parsed = JSON.parse(content);
    expect(parsed.openapi).toBe('3.1.0');
    expect(parsed.info.title).toContain('Semantic Engine');
  });

  it('contains all core REST and LoD endpoints', () => {
    const content = fs.readFileSync(CONTRACT_PATH, 'utf8');
    const parsed = JSON.parse(content);
    const paths = Object.keys(parsed.paths);

    const requiredPaths = [
      '/api/v1/system',
      '/health',
      '/ready',
      '/metrics',
      '/api/v1/config',
      '/api/v1/projects',
      '/api/v1/projects/{id}',
      '/api/v1/projects/{id}/index',
      '/api/v1/projects/{id}/jobs/{jobId}',
      '/api/v1/projects/{id}/events',
      '/api/v1/projects/{id}/search',
      '/api/v1/projects/{id}/symbols/{symbolId}',
      '/api/v1/projects/{id}/context',
      '/api/v1/projects/{id}/visualization/architecture',
      '/api/v1/projects/{id}/visualization/module/{moduleId}',
      '/api/v1/projects/{id}/visualization/file/{fileId}',
      '/api/v1/projects/{id}/visualization/neighborhood',
    ];

    for (const p of requiredPaths) {
      expect(paths).toContain(p);
    }
  });
  /*
  | Phase 2 / step 2: the spec and the registered routes must be the same set.
  | Every route operation needs a spec entry and every spec entry needs a route,
  | so a route added (or a stub removed) without touching the contract fails here.
  */
  describe('route <-> contract parity', () => {
    const ROUTES_DIR = path.join(__dirname, '..', '..', 'server', 'routes');

    function routeOperations(): string[] {
      const ops: string[] = [];
      for (const file of fs.readdirSync(ROUTES_DIR)) {
        if (!file.endsWith('.ts') || file.includes('.test.')) continue;
        const source = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8');
        /*
        | F-0015 — the extractor must catch BOTH shapes: a route object written
        | across lines (method: … \n pattern: …) AND a single-line route literal
        | ({ method: 'POST', pattern: '/api/v1/…', handler: … }). The old regex
        | required a newline between `method` and `pattern`, so every one-line
        | route was invisible to the parity gate — undocmented routes "passed".
        |
        | `method` precedes `pattern` in every route file in this repo. A small
        | non-greedy gap tolerates intervening fields (requireAuth, permission,
        | schema) without letting one route's method grab the NEXT route's
        | pattern (patterns and methods alternate per object, and a route never
        | spans >~200 bytes before its pattern here).
        */
        const re =
          /method:\s*'(GET|POST|PATCH|PUT|DELETE)'[\s\S]{0,200}?pattern:\s*'([^']+)'/g;
        let match: RegExpExecArray | null;
        while ((match = re.exec(source)) !== null) {
          ops.push(`${match[1]} ${match[2].replace(/:([A-Za-z]+)/g, '{$1}')}`);
        }
      }
      return ops;
    }

    function specOperations(): string[] {
      const parsed = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
      const ops: string[] = [];
      for (const [p, item] of Object.entries<Record<string, unknown>>(parsed.paths)) {
        for (const method of Object.keys(item)) ops.push(`${method.toUpperCase()} ${p}`);
      }
      return ops;
    }

    it('documents every registered route operation', () => {
      const spec = new Set(specOperations());
      expect(routeOperations().filter(op => !spec.has(op))).toEqual([]);
    });

    it('has no spec operation without a registered route', () => {
      const routes = new Set(routeOperations());
      expect(specOperations().filter(op => !routes.has(op))).toEqual([]);
    });

    it('declares the request and response contract of the phase 2 mutations', () => {
      const parsed = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
      const patchProject = parsed.paths['/api/v1/projects/{id}'].patch;
      expect(Object.keys(patchProject.requestBody.content['application/json'].schema.properties).sort())
        .toEqual(['autoStart', 'enabled', 'name']);
      expect(Object.keys(patchProject.responses)).toEqual(expect.arrayContaining(['200', '400', '404']));
      expect(Object.keys(parsed.paths['/api/v1/projects/{id}'].delete.responses)).toEqual(
        expect.arrayContaining(['200', '404'])
      );
      const patchConfig = parsed.paths['/api/v1/config'].patch;
      expect(patchConfig.requestBody.content['application/json'].schema.properties.maxBodyBytes.minimum).toBe(1);
      expect(Object.keys(patchConfig.responses)).toEqual(expect.arrayContaining(['200', '400', '409']));
    });
  });
});
