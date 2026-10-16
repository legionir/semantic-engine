/**
 * DetectArchitectureViolationsTool — AI-facing tool for detecting circular dependencies and layer bypassing.
 */

import { AiTool, AiToolInput, AiToolOutput } from './types';
import { ProjectIndexReader } from '../ProjectIndexReader';
import { buildIndexGraph, describeNode } from '../../services/analysis/buildIndexGraph';
import { ArchitectureRuleEngine } from '../../services/analysis/ArchitectureRuleEngine';

export class DetectArchitectureViolationsTool implements AiTool {
  readonly name = 'detect_architecture_violations';
  readonly description = 'Analyzes project dependencies to discover architectural rule violations, circular dependencies, and technical debt.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      checkCyclesOnly: {
        type: 'boolean',
        description: 'Whether to restrict analysis to circular dependency detection only',
      },
    },
  };

  constructor(private readonly reader: ProjectIndexReader) {}

  async execute(input: AiToolInput): Promise<AiToolOutput> {
    if (input.checkCyclesOnly !== undefined && typeof input.checkCyclesOnly !== 'boolean') {
      return { success: false, error: 'checkCyclesOnly must be a boolean', items: [] };
    }
    const checkCyclesOnly = input.checkCyclesOnly === true;
    const graph = buildIndexGraph(this.reader);
    const engine = new ArchitectureRuleEngine();
    const report = engine.analyzeArchitectureDebt(graph);
    const layerViolations = checkCyclesOnly ? [] : report.layerViolations;
    const totalViolations = report.circularDependencies.length + layerViolations.length;

    return {
      success: true,
      metadata: { report: { ...report, layerViolations, totalViolations } },
      items: [
        ...report.circularDependencies.map(c => {
          const readable = c.nodes.map(node => describeNode(graph, node));
          return {
            id: `cycle_${c.nodes.join('_')}`,
            name: `Circular dependency across ${c.nodes.length} files`,
            kind: 'architecture_cycle',
            path: readable[0],
            source: 'architecture-rules',
            excerpt: [...readable, readable[0]].join(' -> '),
            metadata: { nodeIds: c.nodes, cycleLength: c.nodes.length },
          };
        }),
        ...layerViolations.map(v => ({
          id: v.ruleId,
          name: v.ruleName,
          kind: 'layer_violation',
          source: 'architecture-rules',
          excerpt: `${v.description} (${v.severity})`,
        })),
      ],
      context: `Found ${totalViolations} architectural violation(s) (${report.circularDependencies.length} cycles, ${layerViolations.length} layer violations).`,
    };
  }
}
