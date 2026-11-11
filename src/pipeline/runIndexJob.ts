/**
 * The one full-index run.
 *
 * `semantic-engine index`, the first run of `watch`, a worker's Reindex and
 * the HTTP index job each assembled their own pipeline, and drifted: the HTTP
 * job had no extraction cache and collected no git data, so the same project
 * got a different index depending on which button started it. They now all
 * call this function and differ only in the options they pass.
 *
 * It also holds the project's index lock for the duration, so two runs cannot
 * write the same artifact at once (a Reindex while an HTTP job is running).
 */

import * as fs from 'fs';
import * as path from 'path';
import { ScannerConfig } from '../core/config/ScannerConfig';
import { CACHE_DIR, EXTRACTION_CACHE_FILE } from '../core/config/ProjectPaths';
import { GitInfoCollector } from '../core/git';
import { ProjectIndex, VectorChunk } from '../core/types/project-index.types';
import { acquireLock, INDEX_LOCK_FILE } from '../gateway/ProjectLock';
import { CancellationToken } from '../host/Cancellation';
import { ILogger } from '../host/Logger';
import { ProgressLike } from '../host/Progress';
import { IEmbeddingGenerator } from '../vector/EmbeddingGenerator';
import { VectorIndexer } from '../vector/VectorIndexer';
import { ExtractionCache } from './ExtractionCache';
import { createExtractors } from './ExtractorFactory';
import { IndexPipeline } from './IndexPipeline';
import { INDEX_FILE_NAME, OutputWriter } from './OutputWriter';

export interface IndexJobOptions {
  readonly workspaceRoot: string;
  /** Artifact directory: where `project-index.json` is written. */
  readonly outputDir: string;
  readonly logger?: ILogger;
  /**
   * `reuse` (default) skips files whose extraction is cached; `rebuild`
   * ignores the cache and writes a fresh one; `off` neither reads nor writes.
   */
  readonly cache?: 'reuse' | 'rebuild' | 'off';
  readonly scannerConfig?: Partial<ScannerConfig>;
  /** Collect git metadata (hotspots, history). Default true. */
  readonly git?: boolean;
  readonly treeSitter?: boolean;
  /**
   * `undefined` keeps vectors only if the previous index had them (a plain
   * refresh must not drop them); `null` turns them off; a generator builds them.
   */
  readonly embeddingGenerator?: IEmbeddingGenerator | null;
  /** Build vectors with the default generator even without an explicit one. */
  readonly vectors?: boolean;
  readonly lspDiagnostics?: boolean;
  readonly diagnosticsBudgetMs?: number;
  readonly pretty?: boolean;
  readonly blueprint?: boolean;
  readonly token?: CancellationToken;
  readonly progress?: ProgressLike;
}

export interface IndexJobResult {
  readonly projectIndex: ProjectIndex;
  readonly files: number;
  readonly symbols: number;
  readonly vectorChunks: number;
  readonly durationMs: number;
  readonly extractionCache?: unknown;
  readonly indexPath: string;
  readonly blueprintPath?: string;
}

/** Another index run holds the project's lock. */
export class IndexBusyError extends Error {
  constructor(readonly holderPid: number | null) {
    super(
      holderPid === null
        ? 'an index run is already in progress for this project'
        : `an index run is already in progress for this project (pid ${holderPid})`
    );
    this.name = 'IndexBusyError';
  }
}

export function readPreviousIndex(outputDir: string): ProjectIndex | null {
  const indexPath = path.join(outputDir, INDEX_FILE_NAME);
  if (!fs.existsSync(indexPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(indexPath, 'utf8')) as ProjectIndex;
  } catch {
    return null;
  }
}

export async function runIndexJob(options: IndexJobOptions): Promise<IndexJobResult> {
  const { workspaceRoot, outputDir, logger } = options;

  /*
  | A dead holder is recovered by pid; the heartbeat window is made long
  | because an index run does not heartbeat and may take many minutes.
  */
  const lock = acquireLock(path.join(outputDir, INDEX_LOCK_FILE), path.basename(outputDir), 'index', {
    staleAfterMs: 24 * 60 * 60 * 1000,
  });
  if (!lock.ok) throw new IndexBusyError(lock.holder?.pid ?? null);

  const previous = readPreviousIndex(outputDir);
  const previousChunks: readonly VectorChunk[] | undefined = previous?.vectorChunks;
  const wantsVectors =
    options.embeddingGenerator !== null &&
    (options.embeddingGenerator !== undefined || options.vectors === true || Boolean(previousChunks));

  const extractors = createExtractors({
    workspaceRoot,
    treeSitter: options.treeSitter !== false,
    ...(logger ? { logger } : {}),
    lspDiagnostics: options.lspDiagnostics === true,
  });
  if (options.lspDiagnostics === true && !extractors.diagnosticsSource) {
    logger?.warn('diagnostics requested but no language server is usable — index will carry no LSP diagnostics');
  }

  const cacheMode = options.cache ?? 'reuse';
  const extractionCache =
    extractors.fingerprint && cacheMode !== 'off'
      ? new ExtractionCache(path.join(outputDir, CACHE_DIR, EXTRACTION_CACHE_FILE), extractors.fingerprint, {
          reuse: cacheMode === 'reuse',
        })
      : null;
  const scannerConfig = options.scannerConfig ?? {};
  const pretty = options.pretty !== false;

  try {
    const { projectIndex, stats } = await new IndexPipeline({
      workspaceRoot,
      outputPath: path.join(outputDir, INDEX_FILE_NAME),
      symbolExtractors: extractors.symbols,
      dependencyExtractors: extractors.dependencies,
      ...(logger ? { logger } : {}),
      extractionCache,
      ...(Object.keys(scannerConfig).length > 0 ? { scannerConfig } : {}),
      gitCollector: options.git === false ? null : new GitInfoCollector(workspaceRoot),
      vectorIndexer: wantsVectors
        ? new VectorIndexer({ embeddingGenerator: options.embeddingGenerator ?? undefined })
        : null,
      ...(previousChunks ? { previousVectorChunks: previousChunks } : {}),
      ...(extractors.diagnosticsSource ? { diagnosticsSource: extractors.diagnosticsSource } : {}),
      ...(options.diagnosticsBudgetMs ? { diagnosticsBudgetMs: options.diagnosticsBudgetMs } : {}),
      ...(options.token ? { token: options.token } : {}),
      ...(options.progress ? { progress: options.progress } : {}),
      pretty,
    }).run();

    const written = await new OutputWriter({
      outputDir,
      ...(logger ? { logger } : {}),
      pretty,
      blueprint: options.blueprint !== false,
      ...(projectIndex.git?.commit ? { gitCommit: projectIndex.git.commit } : {}),
    }).write(projectIndex);

    return {
      projectIndex,
      files: stats.files,
      symbols: stats.symbols,
      vectorChunks: stats.vectorChunks ?? 0,
      durationMs: stats.durationMs,
      ...(stats.extractionCache ? { extractionCache: stats.extractionCache } : {}),
      indexPath: written.indexPath,
      ...(written.blueprintPath ? { blueprintPath: written.blueprintPath } : {}),
    };
  } finally {
    extractors.dispose();
    lock.release();
  }
}
