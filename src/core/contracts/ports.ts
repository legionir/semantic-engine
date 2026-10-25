import type { TextRange } from './codeintel';
import { LineIndex, compareCanonical } from './codeintel';

export interface FileMetadata {
  readonly relativePath: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
  readonly isSymlink: boolean;
  readonly isBinary: boolean;
}

/**
 * Read-only filesystem boundary; implementations must enforce root confinement.
 *
 * The port has three methods and no way to write, rename or delete: a caller
 * that only holds a `FileProvider` cannot mutate the workspace, which is the
 * point. `readOnly: true` is a literal type, so a mutable implementation does
 * not satisfy the interface at all.
 *
 * The reference implementation is `ConfinedFileProvider`
 * (`./fileProvider.ts`); it is the one the contract tests run against, so the
 * guarantees here are executed rather than asserted in prose.
 */
export interface FileProvider {
  readonly readOnly: true;
  list(relativeDirectory: string): Promise<readonly FileMetadata[]>;
  read(relativePath: string, maxBytes: number): Promise<Uint8Array>;
  exists(relativePath: string): Promise<boolean>;
}

/**
 * Token accounting is a port for the same reason: the estimator that ships in
 * v1 is not the one that will ship in v2, and a caller must be able to swap it
 * without touching the read path.
 */
export interface TokenCounter {
  count(text: string): number;
  countRange(text: string, range: TextRange): number;
}

/**
 * Deterministic, duplicate-free path ordering.
 *
 * Code-unit order rather than `localeCompare`: collation depends on the ICU
 * build of the runtime, so a locale-aware sort can order the same two paths
 * differently in two processes — which is exactly the non-determinism the
 * contract forbids.
 */
export function deterministicPaths(paths: readonly string[]): readonly string[] {
  return [...new Set(paths)].sort(compareCanonical);
}

/**
 * A small, dependency-free `TokenCounter`: whitespace-delimited words.
 *
 * It is a *reference* implementation for tests and for the contract's shape —
 * not an estimate of any model's tokenizer. `countRange` goes through
 * `LineIndex`, so a range is measured in the same coordinate space every other
 * part of CodeIntel uses.
 */
export class WhitespaceTokenCounter implements TokenCounter {
  count(text: string): number {
    const trimmed = text.trim();
    return trimmed === '' ? 0 : trimmed.split(/\s+/u).length;
  }

  countRange(text: string, range: TextRange): number {
    return this.count(new LineIndex(text).textOf(range));
  }
}
