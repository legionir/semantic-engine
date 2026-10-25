/**
 * JobRoutes — Async indexing jobs & SSE events endpoints.
 *
 * SE-UI-06: بدنهٔ درخواستِ `POST …/index` حالا گزینه‌های اسکن و
 * embedding را از UI می‌پذیرد: حالت اسکن (tree-sitter/heuristic)،
 * رعایت .gitignore، عمق، خروجی‌ها (blueprint) و پیکربندی
 * بردار (provider + مدل embedding یا مدل پیش‌فرض).
 */

import { RouteDefinition } from '../types';
import { ProjectService } from '../../services/ProjectService';
import { JobManager } from '../../runtime/JobManager';
import { SseManager } from '../SseManager';
import { createExtractors } from '../../pipeline/ExtractorFactory';
import { IndexPipeline } from '../../pipeline/IndexPipeline';
import { OutputWriter, INDEX_FILE_NAME } from '../../pipeline/OutputWriter';
import { VectorIndexer } from '../../vector/VectorIndexer';
import { IEmbeddingGenerator } from '../../vector/EmbeddingGenerator';
import { createEmbeddingGenerator } from '../../vector/createEmbeddingGenerator';
import { assertResolvedFetchableUrl } from '../../services/providers/EmbeddingProviderService';
import { ScannerConfig } from '../../core/config/ScannerConfig';
import { VectorChunk } from '../../core/types/project-index.types';
import * as path from 'path';

interface IndexRequestBody {
  scan?: {
    treeSitter?: boolean;
    useGitignore?: boolean;
    maxDepth?: number;
    maxFileSizeMb?: number;
    additionalIgnorePatterns?: string[];
    skipHiddenDirectories?: boolean;
  };
  output?: {
    blueprint?: boolean;
  };
  /**
   * مرحلهٔ diagnostics زبان‌سرور (فاز ۳۴). خاموش پیش‌فرض — روی مخزن بزرگ
   * همین‌طور که هست پرهزینه است.
   */
  lsp?: {
    diagnostics?: boolean;
    budgetMs?: number;
  };
  embedding?: {
    enabled?: boolean;
    provider?: 'local' | 'ollama' | 'openai-compatible';
    model?: string;
    baseUrl?: string;
    apiKey?: string;
    useDefaultModel?: boolean;
    normalize?: boolean;
  };
}

function buildEmbeddingGenerator(
  cfg: NonNullable<IndexRequestBody['embedding']>,
  modelsDir?: string
): IEmbeddingGenerator | null {
  /*
  | تصمیم «کدام provider» در `vector/createEmbeddingGenerator` گرفته می‌شود تا
  | مسیر HTTP و مسیر CLI واگرا نشوند (فاز ۵).
  */
  return createEmbeddingGenerator({
    enabled: Boolean(cfg.enabled),
    ...(cfg.provider ? { provider: cfg.provider } : {}),
    ...(cfg.model !== undefined ? { model: cfg.model } : {}),
    ...(cfg.baseUrl !== undefined ? { baseUrl: cfg.baseUrl } : {}),
    ...(cfg.apiKey !== undefined ? { apiKey: cfg.apiKey } : {}),
    ...(cfg.useDefaultModel !== undefined ? { useDefaultModel: cfg.useDefaultModel } : {}),
    ...(cfg.normalize !== undefined ? { normalize: cfg.normalize } : {}),
    ...(modelsDir ? { modelsDir } : {}),
  });
}

type IndexJobData = {
  readonly scan?: IndexRequestBody['scan'];
  readonly output?: IndexRequestBody['output'];
  readonly lsp?: IndexRequestBody['lsp'];
  readonly embedding?: IndexRequestBody['embedding'];
};

function createIndexRunner(
  project: { id: string; rootPath: string; indexPath: string; index?: { vectorChunks?: readonly VectorChunk[] } },
  data: IndexJobData,
  embeddingGenerator: IEmbeddingGenerator | null,
  reloadProject: (id: string) => unknown
): (
  token: import('../../host/Cancellation').CancellationToken,
  updateProgress: (phase: string, progress: number, data?: unknown) => void
) => Promise<unknown> {
  const scan = data.scan ?? {};
  const output = data.output ?? {};
  const lsp = data.lsp ?? {};
  const treeSitter = scan.treeSitter !== false;
  const scannerConfig: Partial<ScannerConfig> = {
    ...(scan.useGitignore !== undefined ? { useGitignore: scan.useGitignore } : {}),
    ...(typeof scan.maxDepth === 'number' ? { maxDepth: scan.maxDepth } : {}),
    ...(typeof scan.maxFileSizeMb === 'number'
      ? { maxFileSizeBytes: Math.round(scan.maxFileSizeMb * 1024 * 1024) }
      : {}),
    ...(Array.isArray(scan.additionalIgnorePatterns)
      ? { additionalIgnorePatterns: scan.additionalIgnorePatterns }
      : {}),
    ...(scan.skipHiddenDirectories !== undefined
      ? { skipHiddenDirectories: scan.skipHiddenDirectories }
      : {}),
  };
  const wantBlueprint = output.blueprint !== false;

  return async (token, updateProgress) => {
    updateProgress('scanning', 10);
    const extractors = createExtractors({
      workspaceRoot: project.rootPath,
      treeSitter,
      lspDiagnostics: lsp.diagnostics === true,
    });
    const outputDir = path.dirname(project.indexPath);
    const vectorIndexer = embeddingGenerator ? new VectorIndexer({ embeddingGenerator }) : null;
    const pipeline = new IndexPipeline({
      workspaceRoot: project.rootPath,
      outputPath: path.join(outputDir, INDEX_FILE_NAME),
      symbolExtractors: extractors.symbols,
      dependencyExtractors: extractors.dependencies,
      ...(Object.keys(scannerConfig).length > 0 ? { scannerConfig } : {}),
      ...(vectorIndexer ? { vectorIndexer } : {}),
      ...(project.index?.vectorChunks ? { previousVectorChunks: project.index.vectorChunks } : {}),
      ...(extractors.diagnosticsSource
        ? { diagnosticsSource: extractors.diagnosticsSource }
        : {}),
      ...(lsp.budgetMs ? { diagnosticsBudgetMs: lsp.budgetMs } : {}),
      token,
    });
    updateProgress('symbols', 40);
    const { projectIndex, stats } = await pipeline.run();
    updateProgress('graphs', 70);
    const writer = new OutputWriter({ outputDir, blueprint: wantBlueprint });
    updateProgress('finalizing', 90);
    await writer.write(projectIndex);
    reloadProject(project.id);
    return {
      files: stats?.files ?? 0,
      symbols: stats?.symbols ?? 0,
      vectorChunks: stats?.vectorChunks ?? 0,
      embeddingModel: embeddingGenerator?.modelName ?? null,
      treeSitter,
    };
  };
}

export function createJobRoutes(
  projectService: ProjectService,
  jobManager: JobManager,
  sseManager: SseManager,
  modelsDir?: string
): RouteDefinition[] {

  jobManager.registerRecovery('index', async interrupted => {
    const project = projectService.getProject(interrupted.projectId);
    if (!project) throw new Error(`Project '${interrupted.projectId}' is no longer registered.`);
    const jobData = (interrupted.data && typeof interrupted.data === 'object')
      ? interrupted.data as IndexJobData
      : {};
    const embedding = jobData.embedding ?? {};
    let embeddingGenerator: IEmbeddingGenerator | null = null;
    if (embedding.enabled) embeddingGenerator = buildEmbeddingGenerator(embedding, modelsDir);
    jobManager.startJob(
      project.id,
      'index',
      createIndexRunner(project, jobData, embeddingGenerator, id => projectService.reloadProject(id)),
      jobData
    );
  });

  return [
    {
      method: 'POST',
      pattern: '/api/v1/projects/:id/index',
      permission: 'semantic:index',
      handler: async ctx => {
        const project = projectService.getProject(ctx.params.id);
        if (!project) {
          return { status: 404, json: { error: `Project not found: ${ctx.params.id}` } };
        }

        const body = (ctx.body || {}) as IndexRequestBody;
        const scan = body.scan ?? {};
        const output = body.output ?? {};
        const lsp = body.lsp ?? {};
        const embedding = body.embedding ?? {};

        // ساخت generator را پیش از شروع job انجام بده تا خطای پیکربندی
        // بلافاصله (400) برگردد نه به‌صورت job.failed.
        let embeddingGenerator: IEmbeddingGenerator | null = null;
        try {
          // F-0014: a remote embedding baseUrl comes from the request body; apply the
          // same resolved-IP egress guard used by providers/chat — allows localhost
          // (Ollama/LMStudio), blocks link-local/private/cloud-metadata pivots. Throw
          // lands in this existing catch as a 400, before any job starts.
          if (embedding.baseUrl && embedding.provider && embedding.provider !== 'local') {
            await assertResolvedFetchableUrl(embedding.baseUrl);
          }
          embeddingGenerator = buildEmbeddingGenerator(embedding, modelsDir);
        } catch (error) {
          return { status: 400, json: { error: error instanceof Error ? error.message : String(error) } };
        }

        const treeSitter = scan.treeSitter !== false;
        const wantBlueprint = output.blueprint !== false;

        const jobData: IndexJobData = { scan, output, lsp, embedding };
        let job;
        try {
          job = jobManager.startJob(
            project.id,
            'index',
            createIndexRunner(project, jobData, embeddingGenerator, id => projectService.reloadProject(id)),
            jobData
          );
        } catch (error) {
          const failure = error as Error & { status?: number };
          return {
            status: failure.status || 503,
            json: { error: failure.message || 'Unable to start indexing job' },
          };
        }

        return {
          status: 202,
          json: {
            jobId: job.id,
            projectId: project.id,
            status: job.status,
            phase: job.phase,
            progress: job.progress,
            options: {
              treeSitter,
              useGitignore: scan.useGitignore !== false,
              blueprint: wantBlueprint,
              lspDiagnostics: lsp.diagnostics === true,
              embedding: embedding.enabled
                ? {
                    provider: embedding.provider ?? 'local',
                    model: embeddingGenerator?.modelName ?? null,
                  }
                : null,
            },
          },
        };
      },
    },
    {
      method: 'GET',
      pattern: '/api/v1/projects/:id/jobs/:jobId',
      permission: 'semantic:query',
      handler: async ctx => {
        const job = jobManager.getJob(ctx.params.jobId);
        if (!job || job.projectId !== ctx.params.id) {
          return { status: 404, json: { error: `Job not found: ${ctx.params.jobId}` } };
        }

        return {
          status: 200,
          json: {
            jobId: job.id,
            projectId: job.projectId,
            type: job.type,
            status: job.status,
            phase: job.phase,
            progress: job.progress,
            startedAt: job.startedAt,
            completedAt: job.completedAt,
            error: job.error,
            result: job.result,
          },
        };
      },
    },
    {
      method: 'POST',
      pattern: '/api/v1/projects/:id/jobs/:jobId/cancel',
      permission: 'semantic:index',
      handler: async ctx => {
        /*
        | SE-API-001 — the route is scoped to project `:id`, so it may only
        | cancel a job that belongs to that project. The sibling GET on the
        | same resource already enforces `job.projectId !== ctx.params.id →
        | 404`; cancel did not, so a caller on project A could cancel
        | project B's running job. An unknown/foreign job now 404s instead
        | of a 200 `cancelled: false` (which presented a miss as if the
        | operation had been considered and declined).
        */
        const job = jobManager.getJob(ctx.params.jobId);
        if (!job || job.projectId !== ctx.params.id) {
          return { status: 404, json: { error: `Job not found: ${ctx.params.jobId}` } };
        }
        const cancelled = jobManager.cancelJob(ctx.params.jobId);
        return {
          status: 200,
          json: {
            jobId: ctx.params.jobId,
            cancelled,
          },
        };
      },
    },
    {
      method: 'GET',
      pattern: '/api/v1/projects/:id/events',
      permission: 'semantic:query',
      handler: async ctx => {
        sseManager.addClient(ctx.params.id, ctx.req, ctx.res);
      },
    },
  ];
}
