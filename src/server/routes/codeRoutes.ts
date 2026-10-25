/**
 * CodeRoutes — Code intelligence, symbol 360, impact, and diagnostics endpoints.
 */

import { RouteDefinition } from '../types';
import { ProjectService } from '../../services/ProjectService';
import { CodeIntelligenceService } from '../../services/CodeIntelligenceService';
import { ContextService } from '../../services/ContextService';

export function createCodeRoutes(
  projectService: ProjectService,
  codeService: CodeIntelligenceService,
  contextService: ContextService
): RouteDefinition[] {
  return [
    {
      method: 'GET',
      pattern: '/api/v1/projects/:id/symbols/:symbolId',
      handler: async ctx => {
        const project = projectService.getProject(ctx.params.id);
        if (!project) {
          return { status: 404, json: { error: `Project not found: ${ctx.params.id}` } };
        }

        const explanation = await codeService.explainSymbol(project, ctx.params.symbolId);
        return {
          status: 200,
          json: explanation,
        };
      },
    },
    {
      method: 'POST',
      pattern: '/api/v1/projects/:id/impact',
      // F-0011 — impact is a read; explicit semantic:query instead of the
      // POST method default (project:write), so a query-only token can use it
      // and a mutation token is not required.
      permission: 'semantic:query',
      schema: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          maxDepth: { type: 'integer' },
        },
        required: ['symbol'],
      },
      handler: async ctx => {
        const project = projectService.getProject(ctx.params.id);
        if (!project) {
          return { status: 404, json: { error: `Project not found: ${ctx.params.id}` } };
        }

        const body = (ctx.body || {}) as { symbol: string; maxDepth?: number };
        const impact = await codeService.analyzeImpact(project, body.symbol, body.maxDepth);
        return {
          status: 200,
          json: impact,
        };
      },
    },
    {
      method: 'GET',
      pattern: '/api/v1/projects/:id/diagnostics',
      handler: async ctx => {
        const project = projectService.getProject(ctx.params.id);
        if (!project) {
          return { status: 404, json: { error: `Project not found: ${ctx.params.id}` } };
        }

        const paths = ctx.query.paths ? ctx.query.paths.split(',') : undefined;
        const diagnostics = await codeService.getDiagnostics(project, paths);
        return {
          status: 200,
          json: { diagnostics },
        };
      },
    },
    {
      method: 'POST',
      pattern: '/api/v1/projects/:id/context',
      // F-0011 — context assembly is a read; explicit semantic:context.
      permission: 'semantic:context',
      schema: {
        type: 'object',
        properties: {
          task: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          maxTokens: { type: 'integer' },
        },
        required: ['task'],
      },
      handler: async ctx => {
        const project = projectService.getProject(ctx.params.id);
        if (!project) {
          return { status: 404, json: { error: `Project not found: ${ctx.params.id}` } };
        }

        const body = (ctx.body || {}) as { task: string; files?: string[]; maxTokens?: number };
        const bundle = await contextService.assembleContext(project, body);
        return {
          status: 200,
          json: bundle,
        };
      },
    },
  ];
}
