/**
 * CodeIntelligenceService — Symbol 360 view, diagnostics, callers, impact, and tests service.
 */

import { ManagedProject } from './ProjectService';
import { ExplainSymbolTool, SymbolExplanation } from '../ai/tools/ExplainSymbolTool';
import { ImpactAnalysisTool } from '../ai/tools/ImpactAnalysisTool';
import { GetDependenciesTool } from '../ai/tools/GetDependenciesTool';
import { FindTestsTool } from '../ai/tools/FindTestsTool';
import { Diagnostic } from '../core/types/project-index.types';

export class CodeIntelligenceService {
  /**
   * دریافت نمای ۳۶۰ درجه نماد (Explain Symbol).
   */
  async explainSymbol(project: ManagedProject, symbolIdOrName: string): Promise<SymbolExplanation> {
    if (!project.reader) {
      throw new Error(`Project ${project.id} has no valid index loaded.`);
    }

    const tool = new ExplainSymbolTool(project.reader);

    const isId = symbolIdOrName.startsWith('sym-') || symbolIdOrName.startsWith('s_');
    const result = await tool.execute(isId ? { id: symbolIdOrName } : { name: symbolIdOrName });

    if (!result.success) {
      throw new Error(result.error || `Symbol not found: ${symbolIdOrName}`);
    }

    const item = result.items[0];
    if (!item || !item.metadata) {
      throw new Error(`Symbol not found: ${symbolIdOrName}`);
    }

    return item.metadata as unknown as SymbolExplanation;
  }

  /**
   * تحلیل شعاع اثر تغییر یک نماد (Impact Analysis).
   */
  async analyzeImpact(
    project: ManagedProject,
    symbol: string,
    maxDepth = 3
  ): Promise<{ symbol: string; targetType: 'module' | 'package' | 'file_or_symbol'; impactedCount: number; truncated: boolean; candidateCount: number; items: unknown[] }> {
    if (!project.reader) {
      throw new Error(`Project ${project.id} has no valid index loaded.`);
    }

    const tool = new ImpactAnalysisTool(project.reader, {
      ...(project.blueprint ? { blueprint: project.blueprint } : {}),
    });

    /*
    | P-008/§16 — دو باگ در این مسیر:
    | ۱) نام پارامتر: ابزار `depth` می‌خواند؛ پاس‌دادن `{ maxDepth }`
    |    بی‌صدا در `depth: 2` پیش‌فرض فروریخت، پس پرس‌وجوهای عمیق‌تر
    |    از پنجره‌ای کوچک‌تر جواب می‌دادند تا حدِ عمیقِ درخواستی.
    | ۲) برش `limit` در metadata ابزار بود و اینجا دور ریخته می‌شد؛
    |    مصرف‌کننده HTTP فقط `impactedCount` (تعداد صفحه) می‌دید و
    |    «۳۰ از ۵۰۰» با «۳۰ تا، تمام» یکسان به نظر می‌رسید.
    */
    const result = await tool.execute({ id: symbol, depth: maxDepth });
    if (!result.success) {
      throw new Error(result.error || 'Impact analysis failed');
    }

    const meta = result.metadata as { truncated?: boolean; candidateCount?: number } | undefined;
    return {
      symbol,
      targetType: result.metadata?.targetType === 'module'
        ? 'module'
        : result.metadata?.targetType === 'package'
          ? 'package'
          : 'file_or_symbol',
      impactedCount: result.items.length,
      truncated: meta?.truncated === true,
      candidateCount: meta?.candidateCount ?? result.items.length,
      items: [...result.items],
    };
  }

  /**
   * دریافت گراف وابستگی‌های یک فایل یا نماد.
   */
  async getDependencies(
    project: ManagedProject,
    filePath: string,
    depth = 1,
    direction: 'in' | 'out' | 'both' = 'both'
  ): Promise<{ path: string; total: number; edges: unknown[] }> {
    if (!project.reader) {
      throw new Error(`Project ${project.id} has no valid index loaded.`);
    }

    const tool = new GetDependenciesTool(project.reader);

    /*
    | F-0013 — `direction:'both'` must be the union of forward (`out`) and
    | backward (`in`), not silently forward-only. The tool only understands
    | forward/backward, so run both traversals and de-duplicate by item id.
    | The tool resolves its target from `id`, which may be a path, so pass
    | `filePath` directly (the old `dep-${filePath}` never resolved).
    */
    const runOnce = (dir: 'forward' | 'backward') =>
      tool.execute({
        id: filePath,
        path: filePath,
        depth,
        direction: dir,
      });

    if (direction === 'both') {
      const [fwd, bwd] = await Promise.all([runOnce('forward'), runOnce('backward')]);
      if (!fwd.success) throw new Error(fwd.error || 'Failed to extract dependencies');
      if (!bwd.success) throw new Error(bwd.error || 'Failed to extract dependencies');

      const merged = new Map<string, unknown>();
      for (const item of [...fwd.items, ...bwd.items]) {
        const id = (item as { id?: string }).id;
        if (id !== undefined && !merged.has(id)) merged.set(id, item);
      }
      const edges = [...merged.values()];
      return { path: filePath, total: edges.length, edges };
    }

    const result = await runOnce(direction === 'in' ? 'backward' : 'forward');

    if (!result.success) {
      throw new Error(result.error || 'Failed to extract dependencies');
    }

    return {
      path: filePath,
      total: result.items.length,
      edges: [...result.items],
    };
  }

  /**
   * یافتن تست‌های مرتبط با یک فایل یا نماد.
   */
  async findTests(
    project: ManagedProject,
    filePath?: string,
    symbolName?: string
  ): Promise<{ testsCount: number; items: unknown[] }> {
    if (!project.reader) {
      throw new Error(`Project ${project.id} has no valid index loaded.`);
    }

    const tool = new FindTestsTool(project.reader);

    const result = await tool.execute({ path: filePath, symbol: symbolName });
    if (!result.success) {
      throw new Error(result.error || 'Failed to find tests');
    }

    return {
      testsCount: result.items.length,
      items: [...result.items],
    };
  }

  /**
   * استخراج خطاهای کامپایلر از ایندکس.
   */
  async getDiagnostics(project: ManagedProject, filePaths?: string[]): Promise<Diagnostic[]> {
    if (!project.index) {
      return [];
    }

    const all = project.index.diagnostics || [];
    if (filePaths && filePaths.length > 0) {
      const set = new Set(filePaths);
      return all.filter(d => d.fileId && set.has(d.fileId));
    }
    return [...all];
  }
}
