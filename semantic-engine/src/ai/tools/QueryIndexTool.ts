/**
 * QueryIndexTool — SQL-like structured query روی SQLite project-index.
 *
 * فقط SELECT روی جداول allowed است. جداول allowed:
 * files, symbols, call_graph, type_graph, dependency_graph, reverse_dependency_graph
 */

import * as path from 'path';
import { AiTool, AiToolInput, AiToolOutput } from './types';
import { applyQueryPolicy, validateDatabasePath } from './queryPolicy';
import { openSqlite } from '../../export/sqlite/SqliteDriver';

export interface QueryIndexColumn {
  readonly name: string;
  readonly description: string;
}

/**
 * Public SQLite contract shown to MCP clients and the project chat model.
 * Keep this list in sync with SQLiteExporter.createTables(). `path` lives on
 * files, not symbols; spelling that out here prevents the most common query
 * error seen in real runs.
 */
export const QUERY_INDEX_TABLES: Readonly<Record<string, readonly QueryIndexColumn[]>> = {
  files: [
    { name: 'id', description: 'stable file id (primary key)' },
    { name: 'path', description: 'workspace-relative file path' },
    { name: 'language', description: 'detected language, nullable' },
    { name: 'size', description: 'file size in bytes' },
    { name: 'lines', description: 'line count' },
    { name: 'hash', description: 'content hash' },
    { name: 'modified', description: 'last modified timestamp' },
    { name: 'binary', description: '1 when the file is binary, otherwise 0' },
    { name: 'role', description: 'classified file role' },
    { name: 'entry_point', description: '1 when the file is an entry point, otherwise 0' },
    { name: 'test_file', description: '1 when the file is a test, otherwise 0' },
    { name: 'generated', description: '1 when the file is generated, otherwise 0' },
    { name: 'metrics_json', description: 'JSON encoded file metrics' },
    { name: 'git_metrics_json', description: 'JSON encoded Git metrics' },
    { name: 'config_usages_json', description: 'JSON encoded config/env usages' },
    { name: 'ai_metadata_json', description: 'JSON encoded AI metadata and scores' },
    { name: 'imports_json', description: 'JSON encoded imports' },
    { name: 'exports_json', description: 'JSON encoded exports' },
    { name: 'symbol_ids_json', description: 'JSON array of symbols declared by the file' },
    { name: 'outline_json', description: 'JSON encoded file outline' },
  ],
  symbols: [
    { name: 'id', description: 'stable symbol id (primary key)' },
    { name: 'file_id', description: 'owning files.id; join to files.path for the path' },
    { name: 'parent_id', description: 'containing symbol id, nullable' },
    { name: 'kind', description: 'class, function, method, property, interface, etc.' },
    { name: 'name', description: 'short symbol name' },
    { name: 'fully_qualified_name', description: 'workspace path and symbol name' },
    { name: 'signature', description: 'signature or compact declaration' },
    { name: 'visibility', description: 'visibility when known' },
    { name: 'line', description: 'start line' },
    { name: 'end_line', description: 'end line' },
    { name: 'documentation', description: 'documentation text, nullable' },
    { name: 'deprecated', description: '1 when deprecated, otherwise 0' },
    { name: 'exported', description: '1 when exported, otherwise 0' },
    { name: 'async', description: '1 when async, otherwise 0' },
    { name: 'generator', description: '1 when generator, otherwise 0' },
    { name: 'abstract', description: '1 when abstract, otherwise 0' },
    { name: 'static', description: '1 when static, otherwise 0' },
    { name: 'readonly', description: '1 when readonly, otherwise 0' },
    { name: 'parameters_json', description: 'JSON encoded parameters' },
    { name: 'return_type', description: 'return type, nullable' },
    { name: 'throws_json', description: 'JSON encoded thrown types' },
    { name: 'side_effects', description: '1 when side effects are known, otherwise 0' },
    { name: 'generics_json', description: 'JSON encoded generic parameters' },
    { name: 'extends_json', description: 'JSON encoded extended types' },
    { name: 'implements_json', description: 'JSON encoded implemented types' },
    { name: 'complexity', description: 'cyclomatic complexity, nullable' },
    { name: 'reference_count', description: 'indexed reference count, nullable' },
    { name: 'calls_json', description: 'JSON encoded called symbol ids' },
    { name: 'called_by_json', description: 'JSON encoded caller symbol ids' },
    { name: 'test_ids_json', description: 'JSON array of mapped test file ids' },
    { name: 'source', description: 'extraction source' },
    { name: 'confidence', description: 'symbol confidence score' },
  ],
  call_graph: [
    { name: 'id', description: 'stable edge id (primary key)' },
    { name: 'caller', description: 'caller symbol id' },
    { name: 'callee', description: 'callee symbol id or external name' },
    { name: 'kind', description: 'call relation kind' },
    { name: 'line', description: 'call site line, nullable' },
    { name: 'extractor', description: 'extractor that produced the edge' },
    { name: 'confidence', description: 'edge confidence score' },
    { name: 'basis', description: 'evidence basis for the edge' },
  ],
  type_graph: [
    { name: 'parent', description: 'parent/base symbol id' },
    { name: 'child', description: 'child/derived symbol id' },
    { name: 'kind', description: 'extends or implements' },
    { name: 'extractor', description: 'extractor that produced the edge' },
    { name: 'confidence', description: 'edge confidence score' },
    { name: 'basis', description: 'evidence basis for the edge' },
  ],
  dependency_graph: [
    { name: 'from_id', description: 'source file id' },
    { name: 'to_id', description: 'target file id or pkg:<name>' },
    { name: 'kind', description: 'import, package, or dynamic-import' },
    { name: 'extractor', description: 'extractor that produced the edge' },
    { name: 'confidence', description: 'edge confidence score' },
    { name: 'basis', description: 'evidence basis for the edge' },
  ],
  reverse_dependency_graph: [
    { name: 'from_id', description: 'target file/symbol id being depended on' },
    { name: 'to_id', description: 'dependent file/symbol id' },
    { name: 'kind', description: 'imported-by, called-by, extends, or implements' },
    { name: 'extractor', description: 'extractor that produced the edge' },
    { name: 'confidence', description: 'edge confidence score' },
    { name: 'basis', description: 'evidence basis for the edge' },
  ],
  vector_chunks: [
    { name: 'id', description: 'stable vector chunk id (primary key)' },
    { name: 'file_id', description: 'owning files.id' },
    { name: 'symbol_id', description: 'owning symbols.id, nullable' },
    { name: 'unit', description: 'chunk unit/type' },
    { name: 'content', description: 'chunk text' },
    { name: 'start_line', description: 'chunk start line' },
    { name: 'end_line', description: 'chunk end line' },
    { name: 'token_estimate', description: 'estimated token count' },
    { name: 'embedding_json', description: 'JSON encoded embedding vector' },
    { name: 'embedding_model', description: 'embedding model identifier' },
  ],
};

export const QUERY_INDEX_SCHEMA_DESCRIPTION = Object.entries(QUERY_INDEX_TABLES)
  .map(([table, columns]) =>
    `${table}: ${columns.map(column => `${column.name} (${column.description})`).join(', ')}`
  )
  .join('\n');

export interface QueryIndexInput extends AiToolInput {
  readonly sqlitePath?: string;
  readonly sql: string;
  readonly params?: readonly unknown[];
  readonly limit?: number;
}

export interface QueryIndexOptions {
  /** دایرکتوری‌ای که فایل دیتابیس باید داخلش باشد. بدون آن هیچ فایلی باز نمی‌شود. */
  readonly allowedRoot?: string;
  readonly maxRows?: number;
}

const DEFAULT_MAX_ROWS = 100;

/*
| بارگذاری sqlite3 اینجا مرده بود: مسیر زنده از `openSqlite` (لایهٔ
| درایور SE-BUILD-10) می‌گذرد که خود node:sqlite/sqlite3 را انتخاب
| می‌کند. F-0003 — typeهای بی‌مصرف بارگذاری هم حذف شدند.
*/
export class QueryIndexTool implements AiTool<QueryIndexInput> {
  readonly name = 'query_index';
  readonly description = `Run a read-only SQL query against project-index.sqlite. Only these tables and columns are allowed:\n${QUERY_INDEX_SCHEMA_DESCRIPTION}`;
  readonly inputSchema = {
    type: 'object',
    properties: {
      sqlitePath: { type: 'string', default: 'project-index.sqlite', description: 'Optional path relative to the project artifact directory; defaults to project-index.sqlite.' },
      sql: { type: 'string', description: 'Read-only SELECT. symbols uses file_id; join files on files.id = symbols.file_id when you need a path.' },
      params: { type: 'array', default: [], description: 'Query parameters' },
      limit: { type: 'integer', default: 100 },
    },
    required: ['sql'],
  };

  constructor(private readonly options: QueryIndexOptions = {}) {}

  async execute(input: QueryIndexInput): Promise<AiToolOutput> {
    const policy = {
      allowedRoot: this.options.allowedRoot,
      maxRows: Math.min(
        input.limit ?? DEFAULT_MAX_ROWS,
        this.options.maxRows ?? DEFAULT_MAX_ROWS
      ),
    };

    /* Paths coming from an MCP client are commonly relative to the
       artifact directory (for example `project-index.sqlite`). Resolving
       them before policy validation both makes that contract useful and
       keeps the security check on the final path, not on process.cwd(). */
    const requestedPath = input.sqlitePath?.trim() || 'project-index.sqlite';
    const databasePath = path.isAbsolute(requestedPath)
      ? requestedPath
      : policy.allowedRoot
        ? path.resolve(policy.allowedRoot, requestedPath)
        : requestedPath;

    const pathCheck = validateDatabasePath(databasePath, policy);
    if (!pathCheck.ok) {
      return { success: false, error: pathCheck.error, items: [] };
    }

    const queryCheck = applyQueryPolicy(input.sql, policy);
    if (!queryCheck.ok) {
      return { success: false, error: queryCheck.error, items: [] };
    }

    try {
      const db = await openSqlite(databasePath);
      try {
        const rows = await db.all(queryCheck.sql, input.params ?? []);
        const items = rows.map((row, index) => ({
          id: `row-${index}`,
          name: Object.values(row ?? {}).slice(0, 2).join(' | ') || `row-${index}`,
          kind: 'query-result',
          source: 'sqlite',
          excerpt: JSON.stringify(row),
        }));
        return {
          success: true,
          items,
          metadata: { returned: items.length, capped: policy.maxRows },
        };
      } finally {
        await db.close();
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        items: [],
      };
    }
  }
}
