/**
 * GetGitHotspotsTool — AI-facing tool for discovering high-churn and complex code hotspots.
 */

import { AiTool, AiToolInput, AiToolOutput } from './types';
import { ProjectIndexReader } from '../ProjectIndexReader';
import { GitHistoryMiner } from '../../services/history/GitHistoryMiner';
import { GitClient } from '../../core/git/GitClient';

export class GetGitHotspotsTool implements AiTool {
  readonly name = 'get_git_hotspots';
  readonly description = 'Identifies repository hotspots and high-risk files based on commit frequency, churn rate, and code complexity.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      limit: {
        type: 'integer',
        description: 'Maximum number of hotspots to return (default: 10)',
      },
    },
  };

  constructor(
    private readonly reader: ProjectIndexReader,
    private readonly workspaceRoot?: string
  ) {}

  async execute(input: AiToolInput): Promise<AiToolOutput> {
    const limit = (input.limit as number) || 10;

    if (this.workspaceRoot) {
      return this.executeFromRepository(limit);
    }

    /* Keep the in-memory mode for library callers that intentionally provide
       no workspace. It is deterministic test data, not a claim about the
       repository's real history. The MCP registry always supplies a root. */
    const miner = new GitHistoryMiner();
    const files = this.reader.getAllFiles();
    miner.recordCommit(files.slice(0, 10).map(f => f.path));
    const hotspots = miner.getHotspots(limit);

    return this.format(hotspots, 'in-memory', Math.min(files.length, 10));
  }

  private async executeFromRepository(limit: number): Promise<AiToolOutput> {
    try {
      const history = await new GitClient(this.workspaceRoot!).getRepositoryHistory();
      const complexityByPath = new Map(
        this.reader.getAllFiles().map(file => [
          file.path,
          Math.max(1, file.metrics?.cyclomaticComplexity ?? 1),
        ])
      );

      const ranked = [...history.statsByPath.entries()]
        .filter(([filePath]) => this.reader.getFileByPath(filePath) !== undefined)
        .map(([filePath, stats]) => {
          const complexity = complexityByPath.get(filePath) ?? 1;
          const churnScore = stats.commitCount;
          return {
            filePath,
            commitsCount: stats.commitCount,
            linesAdded: 0,
            linesDeleted: 0,
            churnScore,
            complexity,
            hotspotScore: churnScore * complexity,
          };
        })
        .sort((left, right) =>
          right.hotspotScore - left.hotspotScore ||
          right.commitsCount - left.commitsCount ||
          left.filePath.localeCompare(right.filePath)
        );

      /*
      | SE-AI-HONESTY — `ranked.length` (candidate count before the cap) is
      | passed to `format` so a sliced hotspot list reports itself as
      | truncated rather than the complete set.
      */
      return this.format(ranked.slice(0, limit), 'git-history', ranked.length);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        items: [],
      };
    }
  }

  private format(hotspots: readonly {
    filePath: string;
    commitsCount: number;
    linesAdded: number;
    linesDeleted: number;
    churnScore: number;
    complexity: number;
    hotspotScore: number;
  }[], source: string, candidateCount: number): AiToolOutput {
    return {
      success: true,
      /* SE-AI-HONESTY — `truncated` says the ranked list was capped. */
      metadata: { hotspots, source, truncated: candidateCount > hotspots.length, candidateCount },
      items: hotspots.map(h => ({
        id: h.filePath,
        name: h.filePath,
        kind: 'hotspot',
        path: h.filePath,
        source: source === 'git-history' ? 'git-history' : 'git-history-miner',
        relevanceScore: h.hotspotScore,
        excerpt: `Hotspot Score: ${h.hotspotScore} (Commits: ${h.commitsCount}, Churn: ${h.churnScore}, Complexity: ${h.complexity})`,
      })),
      context: `Identified ${hotspots.length} repository hotspot(s).`,
    };
  }
}
