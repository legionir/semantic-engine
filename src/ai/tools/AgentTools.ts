/**
 * The tool surface a model is shown.
 *
 * The engine grew one tool per capability and ended up offering near-duplicates
 * (three ways to search, three views of a file, two symbol lookups). A model
 * choosing between them mostly chose none. Each tool here covers one intent and
 * routes to the existing implementation, which stays registered under its
 * internal name for the HTTP routes and the CLI but is no longer listed.
 */

import { ProjectIndexReader } from '../ProjectIndexReader';
import { resolveSymbolId } from './resolveIndexEntity';
import { AiTool, AiToolInput, AiToolOutput } from './types';

/** Runs an internal tool by name with validation and caching (the registry's `execute`). */
export type ToolRunner = (name: string, input: AiToolInput) => Promise<AiToolOutput>;

/** Names listed to a model by default, in the order they are presented. */
export const AGENT_TOOL_NAMES: readonly string[] = [
  'project_info',
  'find_context',
  'search',
  'find_symbol',
  'explain_symbol',
  'file_outline',
  'read_code',
  'list_files',
  'impact',
  'find_tests',
  'git_history',
];

/** Specialist tools, listed only when the server is started with `--all-tools`. */
export const ADVANCED_TOOL_NAMES: readonly string[] = [
  'get_config_usage',
  'detect_architecture_violations',
  'diagnostics_get',
  'structural_rule_test',
  'syntax_tree_dump',
];

/** Implementations reached through the tools above; callable internally, never listed. */
export const INTERNAL_TOOL_NAMES: readonly string[] = [
  'get_dependencies',
  'get_file_summary',
  'semantic_search',
  'assemble_context',
  'discover_context',
  'impact_analysis',
  'get_recent_changes',
  'simulate_mutation',
  'get_git_hotspots',
  'code_read',
  'code_fold',
  'project_list_files',
  'search_text',
  'symbol_inspect',
  'gains_report',
  'code_outline',
  'symbol_find',
  'structural_search',
];

/** Lines returned by `read_code` when no range is given. */
export const DEFAULT_READ_LINES = 200;

function fail(error: string): AiToolOutput {
  return { success: false, error, items: [] };
}

function text(input: AiToolInput, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** Copies the listed keys that the caller actually sent. */
function pick(input: AiToolInput, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (input[key] !== undefined) out[key] = input[key];
  return out;
}

function withNote(result: AiToolOutput, note: string): AiToolOutput {
  return { ...result, metadata: { ...(result.metadata ?? {}), note } };
}

abstract class AgentTool implements AiTool {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly inputSchema: Record<string, unknown>;
  constructor(protected readonly run: ToolRunner, protected readonly reader: ProjectIndexReader) {}
  abstract execute(input: AiToolInput): Promise<AiToolOutput>;
}

class SearchTool extends AgentTool {
  readonly name = 'search';
  readonly description = 'Search the indexed code base by meaning, by exact text, or by syntax pattern.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      query: { type: 'string' },
      mode: { type: 'string', enum: ['meaning', 'text', 'pattern'], default: 'meaning' },
      path: { type: 'string' },
      language: { type: 'string' },
      kind: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 20 },
    },
    required: ['query'],
  };

  async execute(input: AiToolInput): Promise<AiToolOutput> {
    const mode = text(input, 'mode') ?? 'meaning';
    const limit = input['limit'] ?? 20;
    if (mode === 'text') {
      return this.run('search_text', { query: input['query'], ...pick(input, ['path']), limit });
    }
    if (mode === 'pattern') {
      if (!text(input, 'language')) return fail('INVALID_ARGUMENT: mode "pattern" needs `language` (e.g. "typescript")');
      return this.run('structural_search', {
        pattern: input['query'],
        language: input['language'],
        ...pick(input, ['path']),
        maxResults: limit,
      });
    }
    if (mode !== 'meaning') return fail(`INVALID_ARGUMENT: unknown mode "${mode}" (use "meaning", "text" or "pattern")`);
    const filters = pick(input, ['path', 'language', 'kind']);
    return this.run('semantic_search', {
      query: input['query'],
      limit,
      ...(Object.keys(filters).length > 0 ? { filters } : {}),
    });
  }
}

class FileOutlineTool extends AgentTool {
  readonly name = 'file_outline';
  readonly description = 'See what one file contains without reading all of it.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      path: { type: 'string' },
      detail: { type: 'string', enum: ['summary', 'symbols', 'folded'], default: 'summary' },
      maxTokens: { type: 'integer', minimum: 100, maximum: 20000 },
    },
    required: ['path'],
  };

  async execute(input: AiToolInput): Promise<AiToolOutput> {
    const detail = text(input, 'detail') ?? 'summary';
    const path = input['path'];
    if (detail === 'symbols') return this.run('code_outline', { path, compact: true });
    if (detail === 'folded') return this.run('code_fold', { path, ...pick(input, ['maxTokens']) });
    if (detail !== 'summary') return fail(`INVALID_ARGUMENT: unknown detail "${detail}" (use "summary", "symbols" or "folded")`);
    return this.run('get_file_summary', { path });
  }
}

class ReadCodeTool extends AgentTool {
  readonly name = 'read_code';
  readonly description = 'Read source lines from one indexed file.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      path: { type: 'string' },
      startLine: { type: 'integer', minimum: 1 },
      endLine: { type: 'integer', minimum: 1 },
    },
    required: ['path'],
  };

  async execute(input: AiToolInput): Promise<AiToolOutput> {
    const explicit = input['startLine'] !== undefined || input['endLine'] !== undefined;
    const startLine = typeof input['startLine'] === 'number' ? input['startLine'] : 1;
    const endLine = typeof input['endLine'] === 'number' ? input['endLine'] : startLine + DEFAULT_READ_LINES - 1;
    const result = await this.run('code_read', { path: input['path'], startLine, endLine });
    if (!result.success) return result;
    const lines = { startLine, endLine };
    const metadata = { ...(result.metadata ?? {}), ...lines };
    return explicit
      ? { ...result, metadata }
      : withNote(
          { ...result, metadata },
          `Showing at most the first ${DEFAULT_READ_LINES} lines; pass startLine/endLine for another range.`
        );
  }
}

class ListFilesTool extends AgentTool {
  readonly name = 'list_files';
  readonly description = 'List the files in the index.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      path: { type: 'string' },
      language: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
    },
  };

  async execute(input: AiToolInput): Promise<AiToolOutput> {
    const limit = typeof input['limit'] === 'number' ? input['limit'] : 100;
    const prefix = text(input, 'path');
    if (!prefix) return this.run('project_list_files', { ...pick(input, ['language']), limit });

    /* the internal tool has no path filter: list everything, then narrow */
    const all = await this.run('project_list_files', { ...pick(input, ['language']), limit: 1000 });
    if (!all.success) return all;
    const matching = all.items.filter(item => item.path?.includes(prefix));
    return {
      ...all,
      items: matching.slice(0, limit),
      metadata: { ...(all.metadata ?? {}), matchCount: matching.length, truncated: matching.length > limit, limit },
    };
  }
}

class FindContextTool extends AgentTool {
  readonly name = 'find_context';
  readonly description = 'Find the files and symbols relevant to a task described in plain language.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      task: { type: 'string' },
      includeSource: { type: 'boolean', default: false },
      files: { type: 'array', items: { type: 'string' } },
      symbols: { type: 'array', items: { type: 'string' } },
      maxTokens: { type: 'integer', minimum: 500, maximum: 32000, default: 4000 },
      includeTests: { type: 'boolean' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    },
    required: ['task'],
  };

  async execute(input: AiToolInput): Promise<AiToolOutput> {
    const files = Array.isArray(input['files']) ? input['files'] : [];
    const symbols = Array.isArray(input['symbols']) ? input['symbols'] : [];
    const wantsSource = input['includeSource'] === true || files.length > 0 || symbols.length > 0;
    if (!wantsSource) {
      return this.run('discover_context', { task: input['task'], ...pick(input, ['limit', 'includeTests']) });
    }
    const targetSymbols = symbols.map(value => (typeof value === 'string' ? resolveSymbolId(this.reader, value) ?? value : value));
    return this.run('assemble_context', {
      task: input['task'],
      ...(files.length > 0 ? { targetFiles: files } : {}),
      ...(targetSymbols.length > 0 ? { targetSymbols } : {}),
      ...pick(input, ['maxTokens', 'includeTests']),
    });
  }
}

class ImpactTool extends AgentTool {
  readonly name = 'impact';
  readonly description = 'Show what a file or symbol is connected to, and what a change to it would break.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      target: { type: 'string' },
      direction: { type: 'string', enum: ['dependents', 'dependencies'], default: 'dependents' },
      change: { type: 'string', enum: ['rename', 'move', 'delete'] },
      newName: { type: 'string' },
      newPath: { type: 'string' },
      depth: { type: 'integer', minimum: 1, maximum: 3 },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 30 },
    },
    required: ['target'],
  };

  async execute(input: AiToolInput): Promise<AiToolOutput> {
    const target = text(input, 'target');
    if (!target) return fail('INVALID_ARGUMENT: `target` is required (a file path, a symbol name or an id)');

    const change = text(input, 'change');
    if (change) {
      const symbolId = resolveSymbolId(this.reader, target);
      if (!symbolId) {
        return fail(`NOT_FOUND: no single symbol matches "${target}"; use find_symbol and pass its id or "path::name"`);
      }
      return this.run('simulate_mutation', {
        actionType: `${change}_symbol`,
        targetSymbolId: symbolId,
        ...pick(input, ['newName', 'newPath']),
      });
    }

    if ((text(input, 'direction') ?? 'dependents') === 'dependencies') {
      const isSymbol = !this.reader.getFileByPath(target) && !this.reader.getFileById(target);
      return this.run('get_dependencies', {
        id: target,
        direction: 'forward',
        level: isSymbol ? 'symbol' : 'file',
        ...pick(input, ['depth', 'limit']),
      });
    }
    return this.run('impact_analysis', { id: target, level: 'any', ...pick(input, ['depth', 'limit']) });
  }
}

class GitHistoryTool extends AgentTool {
  readonly name = 'git_history';
  readonly description = 'Read git history: recent commits, or the files that change most often.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      view: { type: 'string', enum: ['recent', 'hotspots'], default: 'recent' },
      path: { type: 'string' },
      since: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
    },
  };

  async execute(input: AiToolInput): Promise<AiToolOutput> {
    const view = text(input, 'view') ?? 'recent';
    if (view === 'hotspots') return this.run('get_git_hotspots', pick(input, ['limit']));
    if (view !== 'recent') return fail(`INVALID_ARGUMENT: unknown view "${view}" (use "recent" or "hotspots")`);
    return this.run('get_recent_changes', pick(input, ['path', 'since', 'limit']));
  }
}

export function createAgentTools(run: ToolRunner, reader: ProjectIndexReader): AiTool[] {
  return [
    new SearchTool(run, reader),
    new FileOutlineTool(run, reader),
    new ReadCodeTool(run, reader),
    new ListFilesTool(run, reader),
    new FindContextTool(run, reader),
    new ImpactTool(run, reader),
    new GitHistoryTool(run, reader),
  ];
}
