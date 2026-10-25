/**
 * GetDependenciesTool — forward/backward dependencies برای file یا symbol.
 */

import { AiTool, AiToolInput, AiToolOutput } from './types';
import { ProjectIndexReader } from '../ProjectIndexReader';
import { resolveFileOrSymbolId } from './resolveIndexEntity';

export interface GetDependenciesInput extends AiToolInput {
  readonly id: string;
  readonly direction: 'forward' | 'backward';
  readonly level?: 'file' | 'symbol';
  readonly depth?: number;
  readonly kind?: 'import' | 'package' | 'dynamic-import' | 'called-by' | 'all';
  readonly limit?: number;
}

const MAX_DEPTH = 3;

export class GetDependenciesTool implements AiTool<GetDependenciesInput> {
  readonly name = 'get_dependencies';
  readonly description = 'Get forward or backward dependencies for a file or symbol.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'fileId, symbolId, or indexed relative file path' },
      direction: { enum: ['forward', 'backward'], description: 'forward = this depends on others; backward = others depend on this' },
      level: { enum: ['file', 'symbol'], default: 'file', description: 'Resolution level' },
      depth: { type: 'integer', default: 1, minimum: 1, maximum: 3, description: 'How many hops to traverse' },
      kind: { enum: ['import', 'package', 'dynamic-import', 'called-by', 'all'], default: 'all' },
      limit: { type: 'integer', default: 50 },
    },
    required: ['id', 'direction'],
  };

  constructor(private readonly reader: ProjectIndexReader) {}

  async execute(input: GetDependenciesInput): Promise<AiToolOutput> {
    try {
      if (typeof input.id !== 'string' || input.id.trim().length === 0) return { success: false, error: 'id is required and must be a non-empty string', items: [] };
      if (input.direction !== 'forward' && input.direction !== 'backward') return { success: false, error: 'direction must be forward or backward', items: [] };
      if (input.level !== undefined && input.level !== 'file' && input.level !== 'symbol') return { success: false, error: 'level must be file or symbol', items: [] };
      if (input.kind !== undefined && !['import', 'package', 'dynamic-import', 'called-by', 'all'].includes(input.kind)) return { success: false, error: 'kind is invalid', items: [] };
      const depth = input.depth ?? 1;
      if (input.depth !== undefined && (!Number.isInteger(input.depth) || input.depth < 1 || input.depth > MAX_DEPTH)) {
        return { success: false, error: `depth must be an integer between 1 and ${MAX_DEPTH}`, items: [] };
      }
      if (!Number.isInteger(depth) || depth < 1 || depth > MAX_DEPTH) {
        return { success: false, error: `depth must be an integer between 1 and ${MAX_DEPTH}`, items: [] };
      }
      const limit = input.limit ?? 50;
      if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1)) {
        return { success: false, error: 'limit must be a positive integer', items: [] };
      }
      if (!Number.isInteger(limit) || limit < 1) {
        return { success: false, error: 'limit must be a positive integer', items: [] };
      }
      const direction = input.direction;
      const kind = input.kind ?? 'all';
      const level = input.level ?? 'file';
      const resolvedId = resolveFileOrSymbolId(this.reader, input.id);
      if (!resolvedId) return { success: false, error: `No file or symbol found for id or path: ${input.id}`, items: [] };

      const visited = new Set<string>();
      const results: import('./types').AiToolResultItem[] = [];
      /*
      | SE-AI-HONESTY — the traversal stops as soon as `limit` rows are
      | collected, so `results` may be a prefix of the true dependency set
      | (the guard `results.length >= limit` is what ends the walk). Reporting
      | that a full page was produced lets the AI ask for more instead of
      | treating a capped list as the complete set of dependents/dependencies.
      */
      /*
      | F-0036 — همان خانوادهٔ SE-AI-12: یال‌های call سرِ **سمبلی** دارند.
      | شکل قبلی با `level:'file'` آن گره‌ها را `continue` می‌کرد، پس یک
      | متد با بیست فراخوان، بسته به شانس، یا فقط فایل‌هایِ سطح‌ماژول را
      | می‌گفت یا هیچ. نتیجه: `get_dependencies` برای `ContextRanker.rank`
      | یک آیتم می‌داد و `impact_analysis` برای همان هدف چهار — دو ابزار،
      | دو جواب به یک سؤال.
      |
      | حالا سمبل به فایلِ مادرش جمع می‌شود و چند فراخوانِ یک فایل، یک
      | سطر می‌گیرد با شمارش و نامِ سمبل‌های رابط. پیمایش برای عمق از همان
      | سمبل ادامه می‌یابد تا رفتار `depth` عوض نشود.
      */
      const emitted = new Map<string, import('./types').AiToolResultItem>();
      const counts = new Map<string, { dependents: number; viaSymbols: string[] }>();

      const emit = (edgeKind: string, targetId: string): void => {
        const targetFile = this.reader.getFileById(targetId);
        const targetSymbol = this.reader.getSymbolById(targetId);
        const externalPackage = targetId.startsWith('pkg:');

        let outId = targetId;
        let outFile = targetFile;
        let outSymbol: import('../../core/types/project-index.types').SymbolEntry | undefined = targetSymbol;
        let viaSymbol: string | undefined;

        if (!targetFile && !externalPackage) {
          if (!targetSymbol) return;
          if (level === 'file') {
            outId = targetSymbol.fileId;
            outFile = this.reader.getFileById(outId);
            outSymbol = undefined;
            viaSymbol = targetSymbol.name;
            if (!outFile) return;
          }
          // level='symbol' → خودِ سمبل با همان هویت منتشر می‌شود
        }

        if (level === 'symbol' && !outSymbol) return;

        const tally = counts.get(outId);
        if (tally) {
          tally.dependents += 1;
          if (viaSymbol && !tally.viaSymbols.includes(viaSymbol)) tally.viaSymbols.push(viaSymbol);
          return;
        }

        counts.set(outId, { dependents: 1, viaSymbols: viaSymbol ? [viaSymbol] : [] });
        const item: import('./types').AiToolResultItem = {
          id: outId,
          name: outSymbol?.name ?? outFile?.path ?? targetId.replace(/^pkg:/, ''),
          kind: edgeKind,
          path: outFile?.path,
          line: outSymbol?.line,
          source: 'index',
        };
        emitted.set(outId, item);
        results.push(item);
      };

      const traverse = (currentId: string, currentDepth: number): void => {
        if (currentDepth > depth || results.length >= limit || visited.has(currentId)) return;
        visited.add(currentId);
        const edges = direction === 'forward'
          ? this.reader.getDependencies(currentId)
          : this.reader.getReverseDependencies(currentId);
        for (const edge of edges) {
          if (kind !== 'all' && !this.matchesKind(edge.kind, kind)) continue;
          emit(edge.kind, edge.to);
          traverse(edge.to, currentDepth + 1);
          if (results.length >= limit) return;
        }
      };
      traverse(resolvedId, 1);

      const withCounts = results
        .filter(item => emitted.get(item.id) === item)
        .map(item => {
          const tally = counts.get(item.id)!;
          return {
            ...item,
            metadata: {
              dependents: tally.dependents,
              ...(tally.viaSymbols.length > 0 ? { viaSymbols: tally.viaSymbols } : {}),
            },
          };
        });
      return { success: true, items: withCounts.slice(0, limit), metadata: { truncated: results.length >= limit, limit } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), items: [] };
    }
  }

  private matchesKind(edgeKind: string, filterKind: string): boolean {
    return filterKind === 'all' || edgeKind === filterKind;
  }
}
