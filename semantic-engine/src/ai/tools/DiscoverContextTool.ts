/**
 * DiscoverContextTool — `discover_context`.
 *
 * GAP-04 می‌گفت این باید از `assemble_context` **جدا** باشد، و دلیلش
 * فقط تمیزی معماری نیست:
 *
 * - `assemble_context` متن می‌سازد و بودجه مصرف می‌کند. مدل گاهی فقط
 *   می‌خواهد بداند «کجاها را نگاه کنم» و بعد خودش تصمیم بگیرد چه
 *   چیزی را کامل بخواند.
 * - خروجی کشف **قابل بازرسی** است: هر نامزد `origin`، `hops` و
 *   `reason` دارد. متنِ سرهم‌شده این‌ها را از دست می‌دهد.
 * - کشف را می‌شود کش کرد و دوباره با بودجه‌های مختلف مونتاژ کرد.
 */

import { AiTool, AiToolInput, AiToolOutput } from './types';
import { ProjectIndexReader } from '../ProjectIndexReader';
import {
  ContextDiscoverer,
  ContextDiscovererOptions,
  DiscoverInput,
} from '../discovery/ContextDiscoverer';

export interface DiscoverContextInput extends AiToolInput, DiscoverInput {
  readonly task: string;
}

export class DiscoverContextTool implements AiTool<DiscoverContextInput> {
  readonly name = 'discover_context';
  readonly description =
    'Find the files and symbols relevant to a plain-language task, without being given any paths. Combines semantic search and blueprint module matching for seeds, expands through the dependency and call graphs, then ranks. Returns candidates with provenance rather than assembled text.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Plain-language description of the coding task' },
      limit: { type: 'integer', default: 20, description: 'Maximum candidates to return' },
      expansionDepth: { type: 'integer', default: 2, description: 'How many hops to expand from the seeds' },
      seedLimit: { type: 'integer', default: 8, description: 'How many search hits to use as seeds' },
      filesPerModule: { type: 'integer', default: 3, description: 'Files taken from each matching blueprint module' },
      maxNodes: { type: 'integer', default: 200, description: 'Node ceiling for graph expansion' },
      maxPerFile: { type: 'integer', default: 2, description: 'Maximum candidates from any single file, so one crowded file cannot take the whole budget' },
      includeTests: { type: 'boolean', default: false },
    },
    required: ['task'],
  };

  private readonly discoverer: ContextDiscoverer;

  constructor(reader: ProjectIndexReader, options: ContextDiscovererOptions = {}) {
    this.discoverer = new ContextDiscoverer(reader, options);
  }

  async execute(input: DiscoverContextInput): Promise<AiToolOutput> {
    try {
      const result = await this.discoverer.discover(input);

      return {
        success: true,
        items: result.candidates.map(c => ({
          id: c.id,
          name: c.name,
          kind: c.kind,
          ...(c.path ? { path: c.path } : {}),
          ...(c.line !== undefined ? { line: c.line } : {}),
          relevanceScore: c.score,
          source: c.origin,
          excerpt: c.reason,
          metadata: {
            origin: c.origin,
            graphHops: c.hops,
            ...(c.moduleId ? { moduleId: c.moduleId } : {}),
          },
        })),
        metadata: {
          seeds: result.seeds.length,
          modules: result.modules.map(m => ({ id: m.id, score: m.score, reason: m.reason })),
          truncated: result.truncated,
          ...result.stats,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        items: [],
      };
    }
  }
}
