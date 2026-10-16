/**
 * SE-API-002 — Source Sync validation failures must surface as HTTP 400,
 * not fall through to the server's global 500 handler. A validation rejection
 * is a fact about the REQUEST; reporting it as 500 tells a consuming AI/client
 * the server broke (§15).
 */

import { createSourceRoutes } from './routes/sourceRoutes';
import { SourceSyncService } from '../services/source/SourceSyncService';
import type { ProjectService } from '../services/ProjectService';
import type { HttpRequestContext, RouteDefinition } from './types';

function routeFor(patternSuffix: string, method = 'POST'): RouteDefinition {
  const routes = createSourceRoutes(
    {} as ProjectService,
    new SourceSyncService(),
  );
  const route = routes.find(r => r.method === method && r.pattern.endsWith(patternSuffix));
  if (!route) throw new Error(`route not found: ${patternSuffix}`);
  return route;
}

describe('SE-API-002 — source sync validation returns 400, not 500', () => {
  // a project that resolves, so we reach the validation layer
  const projectService = {
    getProject: () => ({ id: 'p1', rootPath: '/tmp/se-synctest-p1' }),
  } as unknown as ProjectService;

  const syncRoutes = createSourceRoutes(projectService, new SourceSyncService());
  const syncGit = syncRoutes.find(r => r.pattern.endsWith('/source/sync'))!;

  it('an invalid repoUrl yields 400 with the validation message', async () => {
    const ctx = {
      params: { id: 'p1' },
      body: { repoUrl: 'not a valid url' },
    } as unknown as HttpRequestContext;

    const res = (await syncGit.handler(ctx)) as { status: number; json: { error: string } };
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/valid HTTPS or HTTP URL/);
  });

  it('an unsupported URL protocol yields 400', async () => {
    const ctx = {
      params: { id: 'p1' },
      body: { repoUrl: 'ext::sh -c id' },
    } as unknown as HttpRequestContext;

    const res = (await syncGit.handler(ctx)) as { status: number; json: { error: string } };
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/Unsupported Git URL protocol/);
  });

  it('the upload route maps a path-traversal bundle to 400, not 500', async () => {
    const upload = createSourceRoutes(projectService, new SourceSyncService()).find(
      r => r.pattern.endsWith('/source/upload'),
    )!;
    const ctx = {
      params: { id: 'p1' },
      body: { files: { '../../escape.txt': 'x' } },
    } as unknown as HttpRequestContext;

    const res = (await upload.handler(ctx)) as { status: number; json: { error: string } };
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/Security violation/);
  });

  // sanity: the helper above proves routes exist under the expected patterns
  it('routes are registered', () => {
    expect(routeFor('/source/sync').method).toBe('POST');
    expect(routeFor('/source/upload').method).toBe('POST');
  });
});
