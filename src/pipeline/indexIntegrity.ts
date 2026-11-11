/**
 * Quick self-checks of a finished index.
 *
 * A user cannot tell that "the index looks wrong", so the run checks it
 * itself, on data it already holds (no disk reads, no parsing):
 *
 *   - `rebuild` issues are inconsistencies a clean run does not produce: a
 *     symbol of a file that is not in the index, an edge from a file that is
 *     not there, vector chunks of two different models. A fresh full index
 *     fixes them, so the run starts one by itself.
 *   - `warn` issues are things a rebuild cannot fix (no symbols at all in a
 *     project full of source files, most files failing to parse, vectors
 *     asked for but none made or an embedding model that was not ready). They are reported, not retried.
 */

import { ProjectIndex } from '../core/types/project-index.types';

export type IntegritySeverity = 'rebuild' | 'warn';

export interface IntegrityIssue {
  readonly code: string;
  readonly severity: IntegritySeverity;
  /** One sentence a person can read. */
  readonly message: string;
}

export interface IntegrityOptions {
  /** Vectors are switched on for this project. */
  readonly expectVectors?: boolean;
}

/** A project with fewer parsable files than this can legitimately have no symbols. */
const MIN_FILES_FOR_EMPTY_CHECK = 5;
/** Share of source files with a failed extraction that is no longer a few odd files. */
const FAILED_SHARE_WARN = 0.3;

export function checkIndexIntegrity(index: ProjectIndex, options: IntegrityOptions = {}): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const add = (code: string, severity: IntegritySeverity, message: string): void => {
    issues.push({ code, severity, message });
  };

  const fileIds = new Set(index.files.map(file => file.id));
  const symbolIds = new Set(index.symbols.map(symbol => symbol.id));

  const orphanSymbols = index.symbols.filter(symbol => !fileIds.has(symbol.fileId)).length;
  if (orphanSymbols > 0) {
    add('orphan-symbols', 'rebuild', `${orphanSymbols} symbols belong to files that are not in the index`);
  }

  const deps = index.graphs?.dependencyGraph ?? [];
  const orphanDeps = deps.filter(edge => !fileIds.has(edge.from)).length;
  if (orphanDeps > 0) {
    add('orphan-dependencies', 'rebuild', `${orphanDeps} dependency links start at files that are not in the index`);
  }

  const calls = index.graphs?.callGraph ?? [];
  const orphanCalls = calls.filter(edge => !symbolIds.has(edge.caller) && !fileIds.has(edge.caller)).length;
  if (orphanCalls > 0) {
    add('orphan-calls', 'rebuild', `${orphanCalls} call links start at symbols that are not in the index`);
  }

  const sourceFiles = index.files.filter(file => !file.binary && file.language);
  if (index.metrics && index.metrics.totalFiles !== index.files.length) {
    add('count-mismatch', 'rebuild', `the file count (${index.metrics.totalFiles}) does not match the files listed (${index.files.length})`);
  }

  if (index.symbols.length === 0 && sourceFiles.length >= MIN_FILES_FOR_EMPTY_CHECK) {
    add('no-symbols', 'warn', `${sourceFiles.length} source files were found but no symbols were extracted; the parser may be missing for this language`);
  }

  const failed = sourceFiles.filter(file =>
    (file.diagnostics ?? []).some(d => d.severity === 'error' && d.code === 'symbol-extraction')
  ).length;
  if (sourceFiles.length >= MIN_FILES_FOR_EMPTY_CHECK && failed / sourceFiles.length >= FAILED_SHARE_WARN) {
    add('many-parse-failures', 'warn', `${failed} of ${sourceFiles.length} source files could not be parsed`);
  }

  const chunks = index.vectorChunks ?? [];
  if (chunks.length > 0) {
    const orphanChunks = chunks.filter(chunk => !fileIds.has(chunk.fileId)).length;
    if (orphanChunks > 0) {
      add('orphan-chunks', 'rebuild', `${orphanChunks} vector chunks belong to files that are not in the index`);
    }
    const embedded = chunks.filter(chunk => chunk.embedding && chunk.embedding.length > 0);
    const models = new Set(embedded.map(chunk => chunk.embeddingModel ?? ''));
    const dims = new Set(embedded.map(chunk => chunk.embedding!.length));
    if (models.size > 1 || dims.size > 1) {
      add('mixed-embeddings', 'rebuild', 'vectors from different models are mixed, so they cannot be compared');
    }
    if (options.expectVectors && embedded.length < chunks.length) {
      add('missing-embeddings', 'warn', `${chunks.length - embedded.length} vector chunks have no embedding`);
    }
  } else if (options.expectVectors && sourceFiles.length > 0) {
    add('no-vectors', 'warn', 'vectors are switched on but none were made; semantic search will fall back to keywords');
  }

  return issues;
}

export const needsRebuild = (issues: readonly IntegrityIssue[]): boolean =>
  issues.some(issue => issue.severity === 'rebuild');
