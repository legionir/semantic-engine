import {
  IDependencyExtractor,
  DependencyExtractionResult,
} from './IDependencyExtractor';
import { ExtractionSource, Result, ok, err, IDisposable } from '../core/types/common.types';

/**
 * DependencyExtractorManager — مدیریت fallback chain بین extractors.
 *
 * طراحی مشابه SymbolExtractorManager:
 * - extractors بر اساس priority مرتب می‌شوند
 * - partial result → fallback به extractor بعدی
 * - آخرین partial اگر هیچ‌کامل نبود برگردانده می‌شود
 */
export class DependencyExtractorManager implements IDisposable {
  private readonly extractors: IDependencyExtractor[] = [];

  register(extractor: IDependencyExtractor): void {
    this.extractors.push(extractor);
    this.extractors.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Runs the fallback chain. Each extractor is isolated: a throw or a rejected promise from one
   * (in `isAvailable` or `extractDependencies`) is recorded and the next extractor still runs.
   *
   * Result rules (decision D-10):
   *   - first complete (non-partial) result wins, and carries the diagnostics of every extractor
   *     that failed before it;
   *   - otherwise the partial result with the most entries wins (ties: the higher-priority one),
   *     and carries all diagnostics;
   *   - otherwise an error that lists every attempt.
   */
  async extract(
    fileId: string,
    filePath: string,
    content: string,
    languageId: string
  ): Promise<Result<DependencyExtractionResult>> {
    const diagnostics: string[] = [];
    let bestPartial: DependencyExtractionResult | null = null;
    let bestPartialSize = -1;

    for (const extractor of this.extractors) {
      let result: Result<DependencyExtractionResult>;
      try {
        if (!(await extractor.isAvailable(languageId))) continue;
        result = await extractor.extractDependencies(fileId, filePath, content, languageId);
      } catch (error) {
        diagnostics.push(`[${extractor.name}] threw: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }

      if (!result.ok) {
        diagnostics.push(`[${extractor.name}] ${result.error.message}`);
        continue;
      }

      if (!result.value.partial) {
        const all = [...diagnostics, ...(result.value.diagnostics ?? [])];
        return all.length === 0 ? result : ok({ ...result.value, diagnostics: all });
      }

      diagnostics.push(`[${extractor.name}] returned partial result`);
      const size = result.value.imports.length + result.value.exports.length;
      if (size > bestPartialSize) {
        bestPartial = result.value;
        bestPartialSize = size;
      }
    }

    if (bestPartial) {
      return ok({ ...bestPartial, diagnostics: [...diagnostics, ...(bestPartial.diagnostics ?? [])] });
    }

    return err(new Error(
      `No dependency extractor available for language "${languageId}". Tried: ${diagnostics.join('; ')}`
    ));
  }

  async hasExtractorFor(languageId: string): Promise<boolean> {
    for (const extractor of this.extractors) {
      if (await extractor.isAvailable(languageId)) {
        return true;
      }
    }
    return false;
  }

  getRegisteredExtractors(): readonly { name: ExtractionSource; priority: number }[] {
    return this.extractors.map(e => ({ name: e.name, priority: e.priority }));
  }

  async dispose(): Promise<void> {
    for (const extractor of this.extractors) {
      await extractor.dispose();
    }
    this.extractors.length = 0;
  }
}
