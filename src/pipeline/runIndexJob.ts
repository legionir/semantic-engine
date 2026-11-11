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
import { checkIndexIntegrity, IntegrityIssue, needsRebuild } from './indexIntegrity';

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

/** What the run's own check found; kept next to the index so the console can show it. */
export interface IndexCheckRecord {
  readonly checkedAt: string;
  /** No issue of any kind left after the run. */
  readonly ok: boolean;
  readonly issues: readonly IntegrityIssue[];
  /** The run started (or restarted) a full index by itself because of `reason`. */
  readonly autoRebuilt: boolean;
  readonly reason?: string;
}

export const INDEX_CHECK_FILE = 'index-check.json';

export function readIndexCheck(outputDir: string): IndexCheckRecord | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(outputDir, INDEX_CHECK_FILE), 'utf8')) as IndexCheckRecord;
  } catch {
    return null;
  }
}

export interface IndexJobResult {
  readonly check?: IndexCheckRecord;
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
  const requestedCache = options.cache ?? 'reuse';
  /* what the last index had; a rebuild keeps "vectors were on" but not the vectors themselves */
  const lastChunks: readonly VectorChunk[] | undefined = previous?.vectorChunks;
  const wantsVectors =
    options.embeddingGenerator !== null &&
    (options.embeddingGenerator !== undefined || options.vectors === true || Boolean(lastChunks));

  const extractors = createExtractors({
    workspaceRoot,
    treeSitter: options.treeSitter !== false,
    ...(logger ? { logger } : {}),
    lspDiagnostics: options.lspDiagnostics === true,
  });
  if (options.lspDiagnostics === true && !extractors.diagnosticsSource) {
    logger?.warn('diagnostics requested but no language server is usable — index will carry no LSP diagnostics');
  }

  const cacheFor = (mode: 'reuse' | 'rebuild' | 'off'): ExtractionCache | null =>
    extractors.fingerprint && mode !== 'off'
      ? new ExtractionCache(path.join(outputDir, CACHE_DIR, EXTRACTION_CACHE_FILE), extractors.fingerprint, {
          reuse: mode === 'reuse',
        })
      : null;
  const scannerConfig = options.scannerConfig ?? {};
  const pretty = options.pretty !== false;

  const runPipeline = (mode: 'reuse' | 'rebuild' | 'off') => {
    /* a rebuild keeps "vectors were on" but not the old vectors themselves */
    const previousChunks = mode === 'rebuild' ? undefined : lastChunks;
    return new IndexPipeline({
      workspaceRoot,
      outputPath: path.join(outputDir, INDEX_FILE_NAME),
      symbolExtractors: extractors.symbols,
      dependencyExtractors: extractors.dependencies,
      ...(logger ? { logger } : {}),
      extractionCache: cacheFor(mode),
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
  };

  try {
    /*
    | The run checks itself, because a user cannot tell that an index looks wrong.
    |
    |   before: an index file that cannot be read, or that contradicts itself,
    |           is not worth updating — start from zero at once;
    |   after:  the new index is checked before it is written; if it contradicts
    |           itself, one full run replaces it. Problems a rebuild cannot fix are
    |           kept as warnings.
    */
    let mode = requestedCache;
    let reason: string | undefined;
    /* One automatic rebuild per problem: if the last one did not clear it, a rebuild cannot, so
       stop retrying and let the warning stand until someone rebuilds by hand. */
    const lastCheck = readIndexCheck(outputDir);
    const autoRebuildSpent =
      lastCheck !== null && lastCheck.autoRebuilt && lastCheck.issues.some(i => i.severity === 'rebuild');
    const indexFile = path.join(outputDir, INDEX_FILE_NAME);
    if (mode === 'reuse' && !autoRebuildSpent) {
      if (previous === null && fs.existsSync(indexFile)) {
        reason = 'the previous index could not be read';
      } else if (previous !== null) {
        const found = checkIndexIntegrity(previous, { expectVectors: wantsVectors }).filter(i => i.severity === 'rebuild');
        if (found.length > 0) reason = `the previous index was inconsistent: ${found.map(i => i.message).join('; ')}`;
      }
      if (reason) mode = 'rebuild';
    }
    const announce = (why: string): void =>
      options.progress?.report({ message: `Rebuilding from scratch: ${why}`, percent: 0 });
    if (reason) announce(reason);

    let { projectIndex, stats } = await runPipeline(mode);
    let issues = checkIndexIntegrity(projectIndex, { expectVectors: wantsVectors });
    if (mode !== 'rebuild' && mode !== 'off' && !autoRebuildSpent && needsRebuild(issues)) {
      reason = `the new index was inconsistent: ${issues.filter(i => i.severity === 'rebuild').map(i => i.message).join('; ')}`;
      logger?.warn(`index check failed, rebuilding from scratch: ${reason}`);
      announce(reason);
      mode = 'rebuild';
      ({ projectIndex, stats } = await runPipeline(mode));
      issues = checkIndexIntegrity(projectIndex, { expectVectors: wantsVectors });
    }
    const check: IndexCheckRecord = {
      checkedAt: new Date().toISOString(),
      ok: issues.length === 0,
      issues,
      autoRebuilt: reason !== undefined,
      ...(reason !== undefined ? { reason } : {}),
    };

    const written = await new OutputWriter({
      outputDir,
      ...(logger ? { logger } : {}),
      pretty,
      blueprint: options.blueprint !== false,
      ...(projectIndex.git?.commit ? { gitCommit: projectIndex.git.commit } : {}),
    }).write(projectIndex);

    try {
      fs.writeFileSync(path.join(outputDir, INDEX_CHECK_FILE), JSON.stringify(check, null, 2));
    } catch {
      /* the record is a courtesy; a read-only artifact dir must not fail the run */
    }

    return {
      projectIndex,
      files: stats.files,
      symbols: stats.symbols,
      vectorChunks: stats.vectorChunks ?? 0,
      durationMs: stats.durationMs,
      check,
      ...(stats.extractionCache ? { extractionCache: stats.extractionCache } : {}),
      indexPath: written.indexPath,
      ...(written.blueprintPath ? { blueprintPath: written.blueprintPath } : {}),
    };
  } finally {
    extractors.dispose();
    lock.release();
  }
}
