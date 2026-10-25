/**
 * Path, workflow, business-mapping and test-intelligence views of the LOD
 * service. Pure functions of a managed project; `LodService` delegates here.
 */
import { ManagedProject } from '../ProjectService';
import { SubgraphResponse, GraphNode, GraphEdge } from '../../server/types';
import { GraphViewModelMapper } from './GraphViewModelMapper';
import { GraphQueryEngine } from '../../graphs/GraphQueryEngine';
import { WorkflowStep } from '../../core/types/blueprint.types';
import { summaryForGraph, GRAPH_BASES } from './lodShared';

/**
 * مسیر دو نود در گراف (Path Finding View).
 */
export function getPathView(project: ManagedProject, fromId: string, toId: string): SubgraphResponse {
  if (!project.index) {
    return { level: 'neighborhood', nodes: [], edges: [], summary: { totalNodes: 0, totalEdges: 0, confidentRatio: 1 } };
  }

  const engine = new GraphQueryEngine(project.index);
  const pathResult = engine.path(fromId, toId, { depth: 6 });

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  if (pathResult.path) {
    for (const step of pathResult.path) {
      const sym = project.reader?.getSymbolById(step.node);
      if (sym) {
        const f = project.reader?.getFileById(sym.fileId);
        nodes.push(GraphViewModelMapper.fromSymbolEntry(sym, f?.path));
      } else {
        nodes.push(GraphViewModelMapper.createNode(step.node, 'function', step.node));
      }

      if (step.via && GRAPH_BASES.has(step.via.basis as GraphEdge['metadata']['basis'])) {
        edges.push(
          GraphViewModelMapper.createEdge(
            `edge-path-${edges.length}`,
            step.via.from,
            step.via.to,
            'calls',
            {
              confidence: step.via.confidence,
              basis: step.via.basis as GraphEdge['metadata']['basis'],
              sourceKind: 'compiler',
            }
          )
        );
      }
    }
  }

  return {
    level: 'neighborhood',
    nodes,
    edges,
    summary: summaryForGraph(nodes, edges),
  };
}

/**
 * نمای جریان اجرای ورک‌فلو (Workflow Execution View).
 */
export function getWorkflowView(project: ManagedProject, workflowId?: string): SubgraphResponse {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const workflows = project.blueprint?.blueprint.workflowExecutionMap ?? [];
  const target = workflowId
    ? workflows.find(w => w.workflowId === workflowId)
    : workflows[0];

  if (!target) {
    return { level: 'workflow', nodes: [], edges: [], summary: { totalNodes: 0, totalEdges: 0, confidentRatio: 1 } };
  }

  nodes.push(
    GraphViewModelMapper.createNode(`wf-${target.workflowId}`, 'workflow', target.workflowId, {
      importance: 95,
    })
  );

  let prevNodeId = `wf-${target.workflowId}`;

  for (const [idx, step] of target.steps.entries()) {
    const stepItem = step as WorkflowStep;
    const stepNodeId = `step-${idx}-${stepItem.symbolId || idx}`;
    nodes.push(
      GraphViewModelMapper.createNode(stepNodeId, 'function', `Step ${stepItem.order || idx + 1}`, {
        path: stepItem.symbolId,
        importance: 80,
      })
    );

    edges.push(
      GraphViewModelMapper.createEdge(
        `wf-edge-${idx}`,
        prevNodeId,
        stepNodeId,
        'executes',
        { confidence: 100, basis: 'blueprint', sourceKind: 'inferred' }
      )
    );

    prevNodeId = stepNodeId;
  }

  return {
    level: 'workflow',
    nodes,
    edges,
    summary: summaryForGraph(nodes, edges),
  };
}

/**
 * سطح پیشرفته: نگاشت بیزینس به سورس کد (Business -> Code Mapping View).
 */
export function getBusinessMappingView(project: ManagedProject): SubgraphResponse {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const blueprint = project.blueprint?.blueprint;
  const entityMappings = blueprint?.entityTechnicalMapping ?? [];

  for (const [idx, em] of entityMappings.entries()) {
    const bizNodeId = `biz-${em.modelName || em.conceptualEntityId || idx}`;
    nodes.push(
      GraphViewModelMapper.createNode(bizNodeId, 'business_entity', em.modelName || `Entity ${idx}`, {
        role: 'domain-entity',
        importance: 90,
      })
    );

    if (em.symbolId) {
      const symNodeId = `sym-${em.symbolId}`;
      nodes.push(
        GraphViewModelMapper.createNode(symNodeId, 'function', em.symbolId, {
          path: em.tableOrCollectionName || undefined,
          importance: 80,
        })
      );

      edges.push(
        GraphViewModelMapper.createEdge(
          `biz-edge-${edges.length}`,
          bizNodeId,
          symNodeId,
          'implements',
          { confidence: 95, basis: 'blueprint', sourceKind: 'compiler' }
        )
      );
    }
  }

  return {
    level: 'architecture',
    nodes,
    edges,
    summary: summaryForGraph(nodes, edges),
  };
}

/**
 * سطح پیشرفته: ماتریس هوش تست‌ها (Test Intelligence Map).
 */
export function getTestIntelligenceView(project: ManagedProject): SubgraphResponse {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const allFiles = project.reader?.getAllFiles() ?? [];
  const testFiles = allFiles.filter(f => f.path.includes('.test.') || f.path.includes('.spec.'));
  const sourceFiles = allFiles.filter(f => !f.path.includes('.test.') && !f.path.includes('.spec.')).slice(0, 40);

  for (const f of sourceFiles) {
    nodes.push(GraphViewModelMapper.fromFileEntry(f));
  }

  for (const tf of testFiles.slice(0, 20)) {
    nodes.push(
      GraphViewModelMapper.createNode(tf.id, 'file', tf.path, {
        path: tf.path,
        role: 'test-suite',
        importance: 70,
      })
    );

    // Link test file to source file if name matches
    const targetSourcePath = tf.path.replace(/\.(test|spec)\./, '.');
    const target = sourceFiles.find(s => s.path === targetSourcePath);
    if (target) {
      edges.push(
        GraphViewModelMapper.createEdge(
          `test-edge-${edges.length}`,
          tf.id,
          target.id,
          'references',
          { confidence: 100, basis: 'resolved', sourceKind: 'compiler' }
        )
      );
    }
  }

  return {
    level: 'file',
    nodes,
    edges,
    summary: summaryForGraph(nodes, edges),
  };
}
