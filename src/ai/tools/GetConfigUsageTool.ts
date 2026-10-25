/**
 * GetConfigUsageTool — یافتن استفاده‌های config/env در پروژه.
 */

import { AiTool, AiToolInput, AiToolOutput } from './types';
import { ProjectIndexReader } from '../ProjectIndexReader';

export interface GetConfigUsageInput extends AiToolInput {
  readonly key?: string;
  readonly path?: string;
  readonly kind?: 'env' | 'config-get' | 'dotenv' | 'env-file-reference';
  readonly limit?: number;
}

export class GetConfigUsageTool implements AiTool<GetConfigUsageInput> {
  readonly name = 'get_config_usage';
  readonly description = 'Find environment variables and configuration key usages across the project.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Filter by variable/config key (substring match)' },
      path: { type: 'string', description: 'Filter by relative file path' },
      kind: { type: 'string', enum: ['env', 'config-get', 'dotenv', 'env-file-reference'] },
      limit: { type: 'integer', default: 50 },
    },
    anyOf: [{ required: ['key'] }, { required: ['path'] }, { required: ['kind'] }],
  };

  constructor(private readonly reader: ProjectIndexReader) {}

  async execute(input: GetConfigUsageInput): Promise<AiToolOutput> {
    try {
      const selectors = [input.key, input.path, input.kind];
      if (selectors.every(value => value === undefined)) return { success: false, error: 'At least one of key, path, or kind is required', items: [] };
      if (selectors.some(value => value !== undefined && (typeof value !== 'string' || value.trim().length === 0))) {
        return { success: false, error: 'key, path, and kind must be non-empty strings', items: [] };
      }
      if (input.kind !== undefined && !['env', 'config-get', 'dotenv', 'env-file-reference'].includes(input.kind)) {
        return { success: false, error: 'kind is invalid', items: [] };
      }
      if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1)) {
        return { success: false, error: 'limit must be a positive integer', items: [] };
      }
      const limit = input.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1) return { success: false, error: 'limit must be a positive integer', items: [] };
      const keyFilter = input.key?.toLowerCase();
      const pathFilter = input.path?.toLowerCase();
      const files = pathFilter ? this.reader.getAllFiles().filter(f => f.path.toLowerCase().includes(pathFilter)) : this.reader.getAllFiles();
      const items: { id: string; name: string; kind: string; path: string; line: number; source: string; relevanceScore: number; excerpt?: string }[] = [];
      for (const file of files) {
        for (const usage of file.configUsages ?? []) {
          if (input.kind && usage.kind !== input.kind) continue;
          if (keyFilter && !usage.key.toLowerCase().includes(keyFilter)) continue;
          items.push({ id: `${file.id}:${usage.kind}:${usage.key}:${usage.line}`, name: usage.key, kind: usage.kind, path: file.path, line: usage.line, source: `${file.path}:${usage.line}`, relevanceScore: keyFilter && usage.key.toLowerCase() === keyFilter ? 1 : 0.7, excerpt: usage.context });
        }
      }
      items.sort((a, b) => b.relevanceScore - a.relevanceScore);
      /* SE-AI-HONESTY — flag the limit slice (see FindSymbolTool). */
      return { success: true, items: items.slice(0, limit), metadata: { truncated: items.length > limit, matchCount: items.length, limit } };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error), items: [] }; }
  }
}
