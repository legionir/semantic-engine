/**
 * FindTestsTool — پیدا کردن تست‌های مرتبط با یک فایل یا symbol.
 */

import { AiTool, AiToolInput, AiToolOutput } from './types';
import { ProjectIndexReader } from '../ProjectIndexReader';

export interface FindTestsInput extends AiToolInput {
  readonly path?: string;
  readonly fileId?: string;
  readonly symbolId?: string;
  readonly limit?: number;
}

export class FindTestsTool implements AiTool<FindTestsInput> {
  readonly name = 'find_tests';
  readonly description = 'Find test files related to a given file or symbol.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative file path' },
      fileId: { type: 'string', description: 'File id (alternative to path)' },
      symbolId: { type: 'string', description: 'Symbol id' },
      limit: { type: 'integer', default: 20 },
    },
    anyOf: [{ required: ['path'] }, { required: ['fileId'] }, { required: ['symbolId'] }],
  };

  constructor(private readonly reader: ProjectIndexReader) {}

  async execute(input: FindTestsInput): Promise<AiToolOutput> {
    try {
      const selectors = [input.path, input.fileId, input.symbolId];
      if (selectors.every(value => value === undefined)) return { success: false, error: 'One of path, fileId, or symbolId is required', items: [] };
      if (selectors.some(value => value !== undefined && (typeof value !== 'string' || value.trim().length === 0))) {
        return { success: false, error: 'path, fileId, and symbolId must be non-empty strings', items: [] };
      }
      if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1)) {
        return { success: false, error: 'limit must be a positive integer', items: [] };
      }
      const file = input.fileId ? this.reader.getFileById(input.fileId) : input.path ? this.reader.getFileByPath(input.path) : undefined;
      const symbol = input.symbolId ? this.reader.getSymbolById(input.symbolId) : undefined;
      const symbolFile = symbol ? this.reader.getFileById(symbol.fileId) : undefined;
      const primary = file ?? symbolFile;
      if (!primary) return { success: false, error: 'No file or symbol found', items: [] };
      const limit = input.limit ?? 20;

      /*
      | نگاشتِ TestMapper (unionِ symbol.testIds) عمداً شل است — قاعدهٔ سومِ
      | آن «هم‌نام بودنِ specifier» است، بی‌آنکه ببیند از کدام فایل import
      | شده. روی یک فایلِ واقعی با عضوهای هم‌نامِ پرکاربرد (execute/register/
      | get/tools) این یعنی ده‌ها تستِ بی‌ربط. پس اینجا **شاهدِ مستقیم**
      | می‌سنجیم، نه یونión شل: یک تست مربوط است اگر یا نامش مشتق از فایل
      | باشد، یا خودِ فایل را import کرده باشد، یا (برای نماد) دقیقاً همان
      | نماد را از همان فایل import کرده باشد.
      */
      const targetFiles = [primary];
      if (symbolFile && symbolFile.id !== primary.id) targetFiles.push(symbolFile);

      const stripExt = (p: string) => p.replace(/\.[^.]+$/, '');
      const stripTestSuffix = (p: string) => p.replace(/\.(test|spec)$/, '');
      const lastSegment = (p: string) => p.split(/[/\\]/).pop() ?? p;

      const scored: { file: NonNullable<typeof file>; score: number; reason: string }[] = [];
      for (const test of this.reader.getAllFiles()) {
        if (!test.testFile) continue;
        let best = 0;
        let reason = '';
        const bump = (score: number, why: string) => { if (score > best) { best = score; reason = why; } };

        for (const tf of targetFiles) {
          const targetBase = stripExt(tf.path).toLowerCase();
          const testBase = stripTestSuffix(stripExt(test.path)).toLowerCase();

          // ۱) نام فایلِ تست مستقیماً از فایل هدف ساخته شده باشد.
          if (testBase === targetBase) bump(4, `Test file named for ${tf.path}`);
          else if (lastSegment(testBase) === lastSegment(targetBase)) bump(3.5, `Test base name matches ${lastSegment(tf.path)}`);

          // ۲) تست، خودِ فایل هدف را import کرده باشد (provenance).
          const importsFile = (tf.id !== undefined) && (test.imports ?? []).some(imp => imp.resolvedFileId === tf.id);
          if (importsFile) bump(3, `Imports ${tf.path}`);

          // ۳) برای نماد: همان نماد از همان فایل import شده باشد.
          if (symbol && importsFile) {
            const importsSymbol = (test.imports ?? []).some(imp =>
              imp.resolvedFileId === tf.id &&
              (imp.specifiers ?? []).some(sp => sp.imported.toLowerCase() === symbol.name.toLowerCase())
            );
            if (importsSymbol) bump(3.75, `Imports ${symbol.name} from ${tf.path}`);
          }
        }

        if (best > 0) scored.push({ file: test, score: best, reason });
      }

      const items = scored
        .sort((a, b) => (b.score - a.score) || a.file.path.localeCompare(b.file.path))
        .slice(0, limit)
        .map(m => ({
          id: m.file.id,
          name: m.file.path,
          kind: 'test',
          path: m.file.path,
          source: m.reason,
          relevanceScore: m.score,
        }));

      /*
      | SE-AI-HONESTY — `scored` may hold more candidates than `limit`;
      | a slice must be flagged so the AI does not read the returned set as
      | "these are all the related tests".
      */
      return { success: true, items, metadata: { truncated: scored.length > limit, matchCount: scored.length, limit } };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error), items: [] }; }
  }
}
