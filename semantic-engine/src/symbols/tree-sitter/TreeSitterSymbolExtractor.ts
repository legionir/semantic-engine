/**
 * TreeSitterSymbolExtractor — استخراج symbol ها با tree-sitter برای TS/JS/TSX/JSX.
 *
 * اولویت ۵۰: بین LSP (100) و heuristic (10).
 * اگر parse error داشته باشیم، partial=true برمی‌گردانیم تا manager به heuristic fallback کند.
 */

import {
  ISymbolExtractor,
  SymbolExtractionResult,
} from '../ISymbolExtractor';
import { ExtractionSource, Result, ok } from '../../core/types/common.types';
import { TreeSitterParserManager } from './TreeSitterParserManager';
import { TreeSitterSymbolMapper } from './TreeSitterSymbolMapper';
import { TreeSitterAstCache } from './TreeSitterAstCache';
import { Tree } from 'web-tree-sitter';
import { sha256 } from '../../core/utils/hash';

export interface TreeSitterSymbolExtractorOptions {
  readonly parserManager: TreeSitterParserManager;
  readonly astCache?: TreeSitterAstCache;
}

export class TreeSitterSymbolExtractor implements ISymbolExtractor {
  readonly name: ExtractionSource = 'tree-sitter';
  readonly priority = 50;

  private readonly astCache: TreeSitterAstCache;

  constructor(private readonly options: TreeSitterSymbolExtractorOptions) {
    this.astCache = options.astCache ?? new TreeSitterAstCache();
  }

  async isAvailable(languageId: string): Promise<boolean> {
    return this.options.parserManager.isAvailable(languageId);
  }

  async extract(
    fileId: string,
    filePath: string,
    content: string,
    languageId: string
  ): Promise<Result<SymbolExtractionResult>> {
    try {
      const parser = await this.options.parserManager.getParser(languageId);
      if (!parser) {
        return ok({
          symbols: [],
          source: 'tree-sitter',
          partial: true,
          warnings: [`No tree-sitter parser available for ${languageId}`],
        });
      }

      const contentHash = sha256(content);
      let tree: Tree | null = this.astCache.get(fileId, contentHash)?.tree ?? null;
      if (!tree) {
        tree = parser.parse(content);
        if (!tree) {
          return ok({
            symbols: [],
            source: 'tree-sitter',
            partial: true,
            warnings: ['tree-sitter parser returned null'],
          });
        }
        this.astCache.set(fileId, contentHash, tree, languageId);
      }

      const mapper = new TreeSitterSymbolMapper(
        fileId,
        filePath,
        languageId,
        content.split('\n')
      );
      const symbols = mapper.mapTree(tree);
      const partial = tree.rootNode.hasError;

      return ok({
        symbols,
        source: 'tree-sitter',
        partial,
        warnings: partial ? ['Parse tree contains syntax errors'] : [],
      });
    } catch (error) {
      return ok({
        symbols: [],
        source: 'tree-sitter',
        partial: true,
        warnings: [error instanceof Error ? error.message : String(error)],
      });
    }
  }

  async dispose(): Promise<void> {
    this.astCache.clear();
  }
}
