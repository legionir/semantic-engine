/**
 * analysisRoutes — REST Endpoints for Deep Impact Analysis, Architecture Debt, and Mutation Simulation (Domain 11).
 */

import { RouteDefinition, HttpRequestContext } from '../types';
import { ProjectService } from '../../services/ProjectService';
import { ImpactAnalysisEngine } from '../../services/analysis/ImpactAnalysisEngine';
import { ArchitectureRuleEngine } from '../../services/analysis/ArchitectureRuleEngine';
import { MutationSimulator, MutationAction } from '../../services/analysis/MutationSimulator';

export function createAnalysisRoutes(
  projectService: ProjectService,
  impactEngine: ImpactAnalysisEngine,
  archEngine: ArchitectureRuleEngine,
  mutationSimulator: MutationSimulator
): RouteDefinition[] {
  const impactHandler = async (ctx: HttpRequestContext) => {
    const projectId = ctx.params.id;
    const project = projectService.getProject(projectId);
    if (!project) return { status: 404, json: { error: `Project '${projectId}' not found` } };

    const body = (ctx.body || {}) as { symbolId?: string; maxDepth?: number };
    if (!body.symbolId) return { status: 400, json: { error: 'symbolId is required' } };

    const graph = projectService.getProjectGraph(projectId);
    const result = impactEngine.analyzeImpact(graph, body.symbolId, body.maxDepth || 3);
    return { status: 200, json: result };
  };

  const violationsHandler = async (ctx: HttpRequestContext) => {
    const projectId = ctx.params.id;
    const project = projectService.getProject(projectId);
    if (!project) return { status: 404, json: { error: `Project '${projectId}' not found` } };

    const graph = projectService.getProjectGraph(projectId);
    const violations = archEngine.detectLayerViolations(graph);
    return { status: 200, json: { projectId, totalViolations: violations.length, violations } };
  };

  const cyclesHandler = async (ctx: HttpRequestContext) => {
    const projectId = ctx.params.id;
    const project = projectService.getProject(projectId);
    if (!project) return { status: 404, json: { error: `Project '${projectId}' not found` } };

    const graph = projectService.getProjectGraph(projectId);
    const cycles = archEngine.findCircularDependencies(graph);
    return { status: 200, json: { projectId, totalCycles: cycles.length, cycles } };
  };

  const mutationHandler = async (ctx: HttpRequestContext) => {
    const projectId = ctx.params.id;
    const project = projectService.getProject(projectId);
    if (!project) return { status: 404, json: { error: `Project '${projectId}' not found` } };

    const body = (ctx.body || {}) as MutationAction;
    if (!body.type || !body.targetSymbolId) {
      return { status: 400, json: { error: 'type and targetSymbolId are required for mutation simulation' } };
    }

    const graph = projectService.getProjectGraph(projectId);
    const diff = mutationSimulator.simulate(graph, body);
    return { status: 200, json: diff };
  };

  return [
    // F-0011 — explicit intent-based permission instead of the method default.
    // Impact is a read: semantic:query. Simulate-mutation is a dry-run of a
    // mutation: gated behind semantic:mutate.
    { method: 'POST', pattern: '/api/v1/projects/:id/analysis/impact', requireAuth: true, permission: 'semantic:query', handler: impactHandler },
    { method: 'POST', pattern: '/api/v2/projects/:id/analysis/impact', requireAuth: true, permission: 'semantic:query', handler: impactHandler },
    { method: 'GET', pattern: '/api/v1/projects/:id/analysis/architecture-violations', requireAuth: true, handler: violationsHandler },
    { method: 'GET', pattern: '/api/v2/projects/:id/analysis/architecture-violations', requireAuth: true, handler: violationsHandler },
    { method: 'GET', pattern: '/api/v1/projects/:id/analysis/dependency-cycles', requireAuth: true, handler: cyclesHandler },
    { method: 'GET', pattern: '/api/v2/projects/:id/analysis/dependency-cycles', requireAuth: true, handler: cyclesHandler },
    { method: 'POST', pattern: '/api/v1/projects/:id/analysis/simulate-mutation', requireAuth: true, permission: 'semantic:mutate', handler: mutationHandler },
    { method: 'POST', pattern: '/api/v2/projects/:id/analysis/simulate-mutation', requireAuth: true, permission: 'semantic:mutate', handler: mutationHandler },
  ];
}
