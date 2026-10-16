/**
 * GetFileSummaryTool — summary فایل + public API + dependencies کلیدی.
 */

import { AiTool, AiToolInput, AiToolOutput } from './types';
import { ProjectIndexReader } from '../ProjectIndexReader';

export interface GetFileSummaryInput extends AiToolInput {
  readonly path?: string;
  readonly fileId?: string;
}

export class GetFileSummaryTool implements AiTool<GetFileSummaryInput> {
  readonly name = 'get_file_summary';
  readonly description = 'Get a concise summary of a file including public API and key dependencies.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative file path' },
      fileId: { type: 'string', description: 'File id (alternative to path)' },
    },
    /*
    | SE-AI-06 — `required: ['path']` بود، در حالی که پیاده‌سازی از
    | همان اول `fileId` را هم می‌پذیرفت. یعنی یک فراخوانیِ کاملاً
    | معتبر با `fileId` توسط اعتبارسنجی رد می‌شد.
    |
    | تا فاز ۴۵ این تناقض بی‌اثر بود چون اعتبارسنجی فقط «وجود
    | داشتن» را می‌سنجید و کسی به schema تکیه نمی‌کرد. با آمدنِ
    | اعتبارسنجیِ واقعی، تناقض به یک خطای عملی تبدیل می‌شد.
    */
    anyOf: [{ required: ['path'] }, { required: ['fileId'] }],
  };

  constructor(private readonly reader: ProjectIndexReader) {}

  async execute(input: GetFileSummaryInput): Promise<AiToolOutput> {
    try {
      const file = input.fileId
        ? this.reader.getFileById(input.fileId)
        : input.path
          ? this.reader.getFileByPath(input.path)
          : undefined;

      if (!file) {
        return { success: false, error: 'File not found', items: [] };
      }

      const symbols = this.reader.getSymbolsForFile(file.id);
      const publicSymbols = symbols.filter(s => s.exported || s.visibility === 'public');
      const imports = file.imports ?? [];
      const exports = file.exports ?? [];

      const summary = file.aiMetadata?.summary ?? this.inferSummary(file, publicSymbols);

      const context = [
        `File: ${file.path}`,
        `Role: ${file.role ?? 'unknown'}`,
        `Language: ${file.language ?? 'unknown'}`,
        `Lines: ${file.lines}`,
        `Summary: ${summary}`,
        `Public API (${publicSymbols.length}): ${publicSymbols.map(s => s.signature ?? s.name).join(', ')}`,
        `Imports (${imports.length}): ${imports.map(i => i.from).join(', ')}`,
        `Exports (${exports.length}): ${exports.map(e => e.name).join(', ')}`,
      ].join('\n');

      const items = publicSymbols.slice(0, 20).map(sym => ({
        id: sym.id,
        name: sym.name,
        kind: sym.kind,
        path: file.path,
        line: sym.line,
        source: sym.source,
        excerpt: sym.signature ?? sym.documentation ?? undefined,
      }));

      /*
      | SE-AI-HONESTY — `items` carries at most 20 symbols even though the
      | context line already counts the full public API. Expose that cap as a
      | machine-readable signal so the AI does not treat the item list as the
      | complete public surface.
      */
      return {
        success: true,
        items,
        context,
        metadata: { truncated: publicSymbols.length > 20, publicSymbolCount: publicSymbols.length },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        items: [],
      };
    }
  }

  private inferSummary(file: import('../../core/types/project-index.types').FileEntry, publicSymbols: import('../../core/types/project-index.types').SymbolEntry[]): string {
    if (file.role && file.role !== 'unknown') {
      return `${file.role} file with ${publicSymbols.length} public symbols`;
    }
    return `File with ${publicSymbols.length} public symbols`;
  }
}
