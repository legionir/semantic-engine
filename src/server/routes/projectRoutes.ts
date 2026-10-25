/** Project and dashboard routes backed only by ProjectService data. */

import { RouteDefinition } from '../types';
import { ProjectService } from '../../services/ProjectService';

const unavailable = (reason: string) => ({ state: 'unavailable' as const, reason });

export function createProjectRoutes(projectService: ProjectService): RouteDefinition[] {
  const find = (id: string) => projectService.getProject(id);

  return [
    {
      method: 'GET',
      pattern: '/api/v1/projects',
      handler: async ctx => {
        // F-0020: a project-scoped API key must not enumerate other projects
        // (ids, names, stats, absolute rootPath). The list route derives no
        // :id, so the dispatcher's resource-scope check is skipped; enforce it
        // here against the caller's AuthContext.resourceScope ('*' = all).
        const scope = ctx.auth?.resourceScope ?? '*';
        const all = projectService.listProjects();
        const projects = scope === '*' ? all : all.filter(p => `project:${p.id}` === scope);
        return {
          status: 200,
          json: {
            total: projects.length,
            projects: projects.map(p => ({ id: p.id, name: p.name, rootPath: p.rootPath, status: p.status, stats: p.stats })),
          },
        };
      },
    },
    {
      method: 'POST',
      pattern: '/api/v1/projects',
      // F-0011 — registering a project mutates the registry: explicit
      // least-privilege admin permission, not the method-based default.
      requireAuth: true,
      permission: 'project:admin',
      schema: {
        type: 'object',
        properties: { path: { type: 'string' }, name: { type: 'string' }, id: { type: 'string' } },
        required: ['path'],
      },
      handler: async ctx => {
        const body = (ctx.body || {}) as { path: string; name?: string; id?: string };
        const project = projectService.registerProject(body.path, body.id, body.name);
        return {
          status: 201,
          json: { id: project.id, name: project.name, rootPath: project.rootPath, status: project.status, stats: project.stats },
        };
      },
    },
    {
      method: 'GET',
      pattern: '/api/v1/projects/:id',
      handler: async ctx => {
        const project = find(ctx.params.id);
        if (!project) return { status: 404, json: { error: `Project not found: ${ctx.params.id}` } };
        const files = project.reader?.getAllFiles() ?? [];
        return {
          status: 200,
          json: {
            id: project.id,
            name: project.name,
            status: project.status,
            indexStatus: project.status,
            languages: Array.from(new Set(files.map(f => f.language).filter((language): language is string => Boolean(language)))),
            files: project.stats.filesCount,
            symbols: project.stats.symbolsCount,
            dependencies: project.stats.dependenciesCount,
            chunks: Array.isArray(project.index?.vectorChunks) ? project.index.vectorChunks.length : unavailable('vector chunk index is not available'),
            rootPath: project.rootPath,
            indexPath: project.indexPath,
            stats: project.stats,
          },
        };
      },
    },
    {
      method: 'PATCH',
      pattern: '/api/v1/projects/:id',
      // F-0011 — registry mutation (enabled/autoStart/name): explicit admin
      // permission rather than the POST/PATCH method default.
      requireAuth: true,
      permission: 'project:admin',
      handler: async ctx => {
        if (!find(ctx.params.id)) return { status: 404, json: { error: `Project not found: ${ctx.params.id}` } };
        const project = find(ctx.params.id)!;
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const patch: { name?: string; enabled?: boolean; autoStart?: boolean } = {};
        if (body['name'] !== undefined) {
          if (typeof body['name'] !== 'string' || body['name'].trim() === '') {
            return { status: 400, json: { error: 'name must be a non-empty string' } };
          }
          patch.name = body['name'];
        }
        for (const key of ['enabled', 'autoStart'] as const) {
          if (body[key] !== undefined) {
            if (typeof body[key] !== 'boolean') {
              return { status: 400, json: { error: `${key} must be a boolean` } };
            }
            patch[key] = body[key] as boolean;
          }
        }
        const updated = projectService.updateProject(project.id, patch);
        if (!updated) return { status: 404, json: { error: `Project not found: ${ctx.params.id}` } };
        return { status: 200, json: { updated: true, id: updated.id, name: updated.name, status: updated.status } };
      },
    },
    {
      method: 'DELETE',
      pattern: '/api/v1/projects/:id',
      // F-0011 — deleting a project is destructive: explicit admin permission.
      requireAuth: true,
      permission: 'project:admin',
      handler: async ctx => {
        if (!find(ctx.params.id)) return { status: 404, json: { error: `Project not found: ${ctx.params.id}` } };
        const project = find(ctx.params.id)!;
        if (!projectService.removeProject(project.id)) {
          return { status: 404, json: { error: `Project not found: ${ctx.params.id}` } };
        }
        return { status: 200, json: { deleted: true, id: project.id } };
      },
    },
    {
      method: 'GET',
      pattern: '/api/v1/projects/:id/dashboard/overview',
      handler: async ctx => {
        const project = find(ctx.params.id);
        if (!project) return { status: 404, json: { error: `Project not found: ${ctx.params.id}` } };
        const files = project.reader?.getAllFiles() ?? [];
        const languages = Array.from(new Set(files.map(f => f.language).filter((language): language is string => Boolean(language))));
        const dependencyGraph = project.index?.graphs?.dependencyGraph ?? [];
        const chunks = Array.isArray(project.index?.vectorChunks)
          ? project.index.vectorChunks.length
          : unavailable('vector chunk index is not available');

        return {
          status: 200,
          json: {
            project: { id: project.id, name: project.name, rootPath: project.rootPath },
            // Index state is real; no health service is attached to this route.
            health: { ...unavailable('ProjectService does not expose runtime health metrics'), indexState: project.status },
            statistics: {
              files: project.stats.filesCount,
              symbols: project.stats.symbolsCount,
              dependencies: project.stats.dependenciesCount,
              chunks,
            },
            languages,
            topFiles: files.slice(0, 5).map(f => ({ path: f.path, size: f.size })),
            hotspots: unavailable('history service is not attached to dashboard routes'),
            recentChanges: unavailable('recent-change service is not attached to dashboard routes'),
            indexStatus: { state: project.status, lastIndexedAt: project.stats.lastIndexedAt },
            graphStats: { nodesCount: project.stats.symbolsCount + project.stats.filesCount, edgesCount: dependencyGraph.length },
          },
        };
      },
    },
    {
      method: 'GET',
      pattern: '/api/v1/projects/:id/dashboard/dependencies',
      handler: async ctx => {
        const project = find(ctx.params.id);
        if (!project) return { status: 404, json: { error: `Project not found: ${ctx.params.id}` } };
        return { status: 200, json: { projectId: project.id, dependencies: project.index?.graphs?.dependencyGraph ?? [] } };
      },
    },
    {
      method: 'GET',
      pattern: '/api/v1/projects/:id/dashboard/metrics',
      handler: async ctx => {
        const project = find(ctx.params.id);
        if (!project) return { status: 404, json: { error: `Project not found: ${ctx.params.id}` } };
        return { status: 200, json: { projectId: project.id, stats: project.stats } };
      },
    },
  ];
}
