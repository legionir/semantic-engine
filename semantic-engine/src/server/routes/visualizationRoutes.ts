/** Visualization routes with explicit empty/failed states and contract bounds. */

import { RouteDefinition, HttpRequestContext, SubgraphResponse } from '../types';
import { ProjectService } from '../../services/ProjectService';
import { LodService } from '../../services/visualization/LodService';
import {
  DEFAULT_GRAPH_DEPTH,
  DEFAULT_GRAPH_MIN_CONFIDENCE,
  validateGraphTraversalOptions,
} from '../../graphs/GraphQueryEngine';

function projectOr404(projectService: ProjectService, ctx: HttpRequestContext) {
  const project = projectService.getProject(ctx.params.id);
  return project;
}

function viewResponse(view: SubgraphResponse) {
  const state = view.state ?? (view.nodes.length > 0 || view.edges.length > 0 ? 'ready' : 'empty');
  return { status: 200, json: { ...view, state } };
}

function failedResponse(level: SubgraphResponse['level'], error: unknown) {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    status: 500,
    json: {
      level,
      state: 'failed' as const,
      reason,
      nodes: [],
      edges: [],
      summary: { totalNodes: 0, totalEdges: 0, confidentRatio: 1 },
    },
  };
}

function invalidRequest(message: string) {
  return { status: 400, json: { state: 'failed' as const, reason: message, error: message } };
}

function projectUnavailable(id: string) {
  return { status: 404, json: { state: 'unavailable' as const, reason: `Project not found: ${id}`, error: `Project not found: ${id}` } };
}

export function createVisualizationRoutes(
  projectService: ProjectService,
  lodService: LodService
): RouteDefinition[] {
  return [
    {
      method: 'GET',
      pattern: '/api/v1/projects/:id/visualization/architecture',
      handler: async ctx => {
        const project = projectOr404(projectService, ctx);
        if (!project) return projectUnavailable(ctx.params.id);
        try { return viewResponse(lodService.getArchitectureView(project)); }
        catch (error) { return failedResponse('architecture', error); }
      },
    },
    {
      method: 'GET',
      pattern: '/api/v1/projects/:id/visualization/dependencies',
      handler: async ctx => {
        const project = projectOr404(projectService, ctx);
        if (!project) return projectUnavailable(ctx.params.id);
        try { return viewResponse(lodService.getDependenciesView(project)); }
        catch (error) { return failedResponse('file', error); }
      },
    },
    {
      method: 'GET',
      pattern: '/api/v1/projects/:id/visualization/module/:moduleId',
      handler: async ctx => {
        const project = projectOr404(projectService, ctx);
        if (!project) return projectUnavailable(ctx.params.id);
        try { return viewResponse(lodService.getModuleView(project, ctx.params.moduleId)); }
        catch (error) { return failedResponse('module', error); }
      },
    },
    {
      method: 'GET',
      pattern: '/api/v1/projects/:id/visualization/file/:fileId',
      handler: async ctx => {
        const project = projectOr404(projectService, ctx);
        if (!project) return projectUnavailable(ctx.params.id);
        try { return viewResponse(lodService.getFileView(project, ctx.params.fileId)); }
        catch (error) { return failedResponse('file', error); }
      },
    },
    {
      method: 'GET',
      pattern: '/api/v1/projects/:id/visualization/workflow/:workflowId',
      handler: async ctx => {
        const project = projectOr404(projectService, ctx);
        if (!project) return projectUnavailable(ctx.params.id);
        try { return viewResponse(lodService.getWorkflowView(project, ctx.params.workflowId)); }
        catch (error) { return failedResponse('workflow', error); }
      },
    },
    {
      method: 'GET',
      pattern: '/api/v1/projects/:id/visualization/business-mapping',
      handler: async ctx => {
        const project = projectOr404(projectService, ctx);
        if (!project) return projectUnavailable(ctx.params.id);
        try { return viewResponse(lodService.getBusinessMappingView(project)); }
        catch (error) { return failedResponse('architecture', error); }
      },
    },
    {
      method: 'GET',
      pattern: '/api/v1/projects/:id/visualization/test-map',
      handler: async ctx => {
        const project = projectOr404(projectService, ctx);
        if (!project) return projectUnavailable(ctx.params.id);
        try { return viewResponse(lodService.getTestIntelligenceView(project)); }
        catch (error) { return failedResponse('file', error); }
      },
    },
    {
      method: 'POST',
      pattern: '/api/v1/projects/:id/visualization/neighborhood',
      // F-0011 — graph reads; explicit semantic:query instead of the POST
      // method default (project:write).
      permission: 'semantic:query',
      schema: {
        type: 'object',
        properties: {
          seedId: { type: 'string', minLength: 1 },
          depth: { type: 'integer', minimum: 0 },
          minConfidence: { type: 'number', minimum: 0 },
        },
        required: ['seedId'],
      },
      handler: async ctx => {
        const project = projectOr404(projectService, ctx);
        if (!project) return projectUnavailable(ctx.params.id);
        const body = (ctx.body ?? {}) as { seedId?: unknown; depth?: unknown; minConfidence?: unknown };
        if (typeof body.seedId !== 'string' || body.seedId.trim() === '') return invalidRequest('seedId is required');
        const depth = body.depth ?? DEFAULT_GRAPH_DEPTH;
        const minConfidence = body.minConfidence ?? DEFAULT_GRAPH_MIN_CONFIDENCE;
        if (typeof depth !== 'number' || typeof minConfidence !== 'number') {
          return invalidRequest('depth and minConfidence must be numbers');
        }
        try {
          validateGraphTraversalOptions({ depth, minConfidence });
        } catch (error) {
          return invalidRequest(error instanceof Error ? error.message : String(error));
        }
        try {
          return viewResponse(lodService.getNeighborhoodView(project, body.seedId, depth, minConfidence));
        } catch (error) { return failedResponse('neighborhood', error); }
      },
    },
    {
      method: 'POST',
      pattern: '/api/v1/projects/:id/visualization/path',
      // F-0011 — read; explicit semantic:query.
      permission: 'semantic:query',
      schema: {
        type: 'object',
        properties: { from: { type: 'string', minLength: 1 }, to: { type: 'string', minLength: 1 } },
        required: ['from', 'to'],
      },
      handler: async ctx => {
        const project = projectOr404(projectService, ctx);
        if (!project) return projectUnavailable(ctx.params.id);
        const body = (ctx.body ?? {}) as { from?: unknown; to?: unknown };
        if (typeof body.from !== 'string' || body.from.trim() === '') return invalidRequest('from is required');
        if (typeof body.to !== 'string' || body.to.trim() === '') return invalidRequest('to is required');
        try { return viewResponse(lodService.getPathView(project, body.from, body.to)); }
        catch (error) { return failedResponse('neighborhood', error); }
      },
    },
  ];
}
