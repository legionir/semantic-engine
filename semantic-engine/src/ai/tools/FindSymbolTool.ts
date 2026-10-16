/**
 * FindSymbolTool — پیدا کردن symbol بر اساس نام، امضا، یا مسیر.
 */

import { AiTool, AiToolInput, AiToolOutput } from './types';
import { ProjectIndexReader } from '../ProjectIndexReader';

export interface FindSymbolInput extends AiToolInput {
  readonly name?: string;
  readonly kind?: string | string[];
  readonly language?: string | string[];
  readonly path?: string;
  readonly exportedOnly?: boolean;
  readonly limit?: number;
}

export class FindSymbolTool implements AiTool<FindSymbolInput> {
  readonly name = 'find_symbol';
  readonly description = 'Find symbols by name, kind, language, or file path. Supports partial/fuzzy matching.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Symbol name (partial match supported)' },
      kind: {
        oneOf: [
          { type: 'string' },
          { type: 'array', items: { type: 'string' } },
        ],
        description: 'Symbol kind(s)',
      },
      language: {
        oneOf: [
          { type: 'string' },
          { type: 'array', items: { type: 'string' } },
        ],
        description: 'Language id(s)',
      },
      path: { type: 'string', description: 'File path prefix or substring' },
      exportedOnly: { type: 'boolean', default: false },
      limit: { type: 'integer', default: 20 },
    },
    required: ['name'],
  };

  constructor(private readonly reader: ProjectIndexReader) {}

  async execute(input: FindSymbolInput): Promise<AiToolOutput> {
    try {
      const kinds = input.kind ? (Array.isArray(input.kind) ? input.kind : [input.kind]) : [];
      const languages = input.language ? (Array.isArray(input.language) ? input.language : [input.language]) : [];
      const limit = input.limit ?? 20;

      let symbols = this.reader.getAllSymbols();
      if (input.name) {
        const query = input.name.toLowerCase();
        const scored = symbols.flatMap(symbol => {
          const name = symbol.name.toLowerCase();
          const qualified = symbol.fullyQualifiedName?.toLowerCase() ?? '';
          const signature = symbol.signature?.toLowerCase() ?? '';
          let score = 0;

          /* Prefer the symbol name over a path/name substring. A query such
             as `Engine` should start with `ExecutionEngine`, not properties
             from the first package tsconfig symbol encountered. */
          if (name === query) score = 1000;
          else if (name.startsWith(query)) score = 800;
          else if (name.includes(query)) score = 650;
          else if (qualified.includes(query)) score = 350;
          else if (signature.includes(query)) score = 250;

          return score > 0 ? [{ symbol, score }] : [];
        });

        scored.sort((left, right) =>
          right.score - left.score ||
          left.symbol.name.localeCompare(right.symbol.name) ||
          left.symbol.line - right.symbol.line
        );
        symbols = scored.map(entry => entry.symbol);
      }

      if (kinds.length > 0) {
        symbols = symbols.filter(s => kinds.includes(s.kind));
      }

      if (input.exportedOnly) {
        symbols = symbols.filter(s => s.exported);
      }

      if (languages.length > 0 || input.path) {
        symbols = symbols.filter(s => {
          const file = this.reader.getFileById(s.fileId);
          if (!file) return false;
          if (languages.length > 0 && file.language && !languages.includes(file.language)) return false;
          if (input.path && !file.path.toLowerCase().includes(input.path.toLowerCase())) return false;
          return true;
        });
      }

      const matched = symbols.length;
      const items = symbols.slice(0, limit).map(sym => {
        const file = this.reader.getFileById(sym.fileId);
        return {
          id: sym.id,
          name: sym.name,
          kind: sym.kind,
          path: file?.path,
          line: sym.line,
          source: sym.source,
          excerpt: sym.signature ?? sym.documentation ?? undefined,
        };
      });

      /*
      | SE-AI-HONESTY — a `limit` slice is not "all matches". Without a
      | truncation signal the AI reads `items` as the complete result set
      | and concludes the (uncounted) remainder does not exist. Report the
      | real match count and whether the slice dropped any.
      */
      return {
        success: true,
        items,
        metadata: { truncated: matched > limit, matchCount: matched, limit },
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
