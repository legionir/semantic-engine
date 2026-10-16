/**
 * SearchService — Hybrid Vector & Keyword Search Service.
 */

import { ManagedProject } from './ProjectService';
import { SemanticSearchTool } from '../ai/tools/SemanticSearchTool';

export interface SearchQueryOptions {
  readonly query: string;
  readonly limit?: number;
  readonly mode?: 'hybrid' | 'keyword' | 'vector';
  readonly minScore?: number;
  readonly pathFilter?: string;
  readonly kindFilter?: string;
}

export class SearchService {
  /**
   * اجرای جستجوی هیبریدی روی پروژه.
   */
  async search(project: ManagedProject, options: SearchQueryOptions): Promise<{ query: string; mode: string; total: number; items: unknown[] }> {
    if (!project.reader) {
      throw new Error(`Project ${project.id} is not indexed or index is not loaded.`);
    }

    const tool = new SemanticSearchTool(project.reader);

    const result = await tool.execute({
      query: options.query,
      limit: options.limit ?? 20,
      mode: options.mode ?? 'hybrid',
      minScore: options.minScore,
      filters: {
        path: options.pathFilter,
        kind: options.kindFilter,
      },
    });

    if (!result.success) {
      throw new Error(result.error || 'Search failed');
    }

    const items = [...result.items];
    return {
      query: options.query,
      mode: options.mode ?? 'hybrid',
      total: items.length,
      items: items.map(item => ({
        id: item.id,
        name: item.name,
        kind: item.kind,
        path: item.path,
        // SemanticSearchTool's public score is relevanceScore; preserve it
        // under the service-level `score` contract.
        score: item.relevanceScore,
        excerpt: item.excerpt,
        line: item.line,
      })),
    };
  }
}
