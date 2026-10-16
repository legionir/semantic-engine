/**
 * SearchRoutes — Hybrid & semantic search endpoints.
 */

import { RouteDefinition } from '../types';
import { ProjectService } from '../../services/ProjectService';
import { SearchService } from '../../services/SearchService';

export function createSearchRoutes(
  projectService: ProjectService,
  searchService: SearchService
): RouteDefinition[] {
  return [
    {
      method: 'POST',
      pattern: '/api/v1/projects/:id/search',
      // F-0011 — search is a read; explicit semantic:query instead of the
      // POST method default (project:write).
      permission: 'semantic:query',
      schema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer' },
          mode: { type: 'string', enum: ['hybrid', 'keyword', 'vector'] },
          pathFilter: { type: 'string' },
          kindFilter: { type: 'string' },
        },
        required: ['query'],
      },
      handler: async ctx => {
        const project = projectService.getProject(ctx.params.id);
        if (!project) {
          return { status: 404, json: { error: `Project not found: ${ctx.params.id}` } };
        }

        const body = (ctx.body || {}) as {
          query: string;
          limit?: number;
          mode?: 'hybrid' | 'keyword' | 'vector';
          pathFilter?: string;
          kindFilter?: string;
        };

        const results = await searchService.search(project, body);
        return {
          status: 200,
          json: results,
        };
      },
    },
  ];
}
