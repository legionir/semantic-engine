/**
 * `semantic-engine watch` — MIG-52.
 *
 * ایندکس اولیه، بعد رصد تا SIGINT/SIGTERM. فایل PID می‌نویسد تا
 * بشود از بیرون متوقفش کرد و تا دو نمونهٔ هم‌زمان روی یک کارگاه
 * راه نیفتند.
 */

import * as fs from 'fs';
import * as path from 'path';
import { IndexPipeline } from '../../pipeline/IndexPipeline';
import { ExtractionCache } from '../../pipeline/ExtractionCache';
import { createExtractors } from '../../pipeline/ExtractorFactory';
import { OutputWriter, INDEX_FILE_NAME } from '../../pipeline/OutputWriter';
import { WatchPipeline } from '../../pipeline/WatchPipeline';
import { IncrementalEngine } from '../../incremental/IncrementalEngine';
import { VectorIndexer } from '../../vector/VectorIndexer';
import { resolveVectorPlan } from '../embeddingFromArgs';
import { projectPathsFromArgs } from '../projectPathsFromArgs';
import { mergeScanOverrides, parseScanFlags } from '../scanFlags';
import { ProjectIndex } from '../../core/types/project-index.types';
import { GitInfoCollector } from '../../core/git';
import { EXIT, ParsedArgs, boolOption, stringOption } from '../args';
import { CommandContext, CommandResult } from './types';
import { loadGlobalConfig, scannerOverridesFrom } from '../../core/config/GlobalConfig';
import { normalizeWorkspaceRoot } from '../../core/config/ProjectPaths';
import { waitForShutdown } from './serviceSupervisor';

export const PID_FILE_NAME = 'watch.pid';

/**
 * آیا پروسه‌ای با این شناسه زنده است؟
 *
 * `kill(pid, 0)` چیزی نمی‌فرستد و فقط وجود را بررسی می‌کند. `EPERM`
 * یعنی هست ولی مال کاربر دیگری است — که باز هم «هست».
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * گرفتن قفل PID.
 *
 * یک فایل PID که از یک کرش جا مانده نباید تا ابد watch را قفل کند،
 * پس اگر پروسه‌اش زنده نباشد بازنویسی می‌شود.
 */
export function claimPidFile(pidPath: string): { ok: true } | { ok: false; pid: number } {
  if (fs.existsSync(pidPath)) {
    const existing = Number(fs.readFileSync(pidPath, 'utf8').trim());
    if (Number.isInteger(existing) && existing > 0 && isProcessAlive(existing)) {
      return { ok: false, pid: existing };
    }
  }

  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  fs.writeFileSync(pidPath, `${process.pid}\n`, 'utf8');
  return { ok: true };
}

/** آزاد کردن قفل — فقط اگر هنوز مال ماست. */
export function releasePidFile(pidPath: string): void {
  try {
    const owner = Number(fs.readFileSync(pidPath, 'utf8').trim());
    if (owner === process.pid) fs.rmSync(pidPath);
  } catch {
    /* فایل نیست یا خوانده نشد — چیزی برای آزاد کردن نمانده */
  }
}

function loadExistingIndex(indexPath: string): ProjectIndex | null {
  if (!fs.existsSync(indexPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(indexPath, 'utf8')) as ProjectIndex;
  } catch {
    /* ایندکس خراب است؛ اجرای watch باید یک ایندکس تازه بسازد. */
    return null;
  }
}

function blueprintMode(args: ParsedArgs): 'always' | 'threshold' {
  const raw = stringOption(args.options, 'blueprintMode');
  if (raw === undefined || raw === 'always') return 'always';
  if (raw === 'threshold') return 'threshold';
  throw new Error('--blueprint-mode must be either "always" or "threshold"');
}

export async function runWatch(args: ParsedArgs, context: CommandContext): Promise<CommandResult> {
  const root = normalizeWorkspaceRoot(stringOption(args.options, 'root') ?? context.cwd);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { code: EXIT.failure, error: `--root does not exist or is not a directory: ${root}` };
  }

  let mode: 'always' | 'threshold';
  try {
    mode = blueprintMode(args);
  } catch (error) {
    return { code: EXIT.usage, error: error instanceof Error ? error.message : String(error) };
  }

  /* Before the pid file is claimed: a usage error must not leave a claim behind. */
  const scanFlags = parseScanFlags(args);
  if (!scanFlags.ok) return { code: EXIT.usage, error: scanFlags.error };

  /* همان resolver دستور `index`؛ watch و write هرگز واگرا نمی‌شوند. */
  const watchPaths = projectPathsFromArgs(args, root);
  const outputDir = watchPaths.artifactRoot;
  const pidPath = path.join(outputDir, PID_FILE_NAME);

  const claim = claimPidFile(pidPath);
  if (!claim.ok) {
    return {
      code: EXIT.failure,
      error:
        `another watcher is already running for this workspace (pid ${claim.pid}).\n` +
        `stop it, or delete ${pidPath} if that process is gone.`,
    };
  }

  const wantsLspDiagnostics = boolOption(args.options, 'lspDiagnostics', false);
  const diagnosticsBudget = stringOption(args.options, 'diagnosticsBudget');

  const extractors = createExtractors({
    workspaceRoot: root,
    treeSitter: boolOption(args.options, 'treeSitter', true),
    logger: context.logger,
    lspDiagnostics: wantsLspDiagnostics,
  });

  const wantsGit = boolOption(args.options, 'git', true);
  const scanOverrides = mergeScanOverrides(
    scannerOverridesFrom(loadGlobalConfig(watchPaths.dataRoot).config),
    scanFlags.overrides
  );
  const pretty = boolOption(args.options, 'pretty', true);

  const indexPath = path.join(outputDir, INDEX_FILE_NAME);
  const existingIndex = loadExistingIndex(indexPath);
  const skipInitialIndex =
    boolOption(args.options, 'skipInitialIndex', false) ||
    args.options['initialIndex'] === false;
  const wantsBlueprint = boolOption(args.options, 'blueprint', true);
  /*
  | Same rule and same provider as `index` (audit F-07): `--embedding-provider`
  | implies vectors, and the generator is built from the flags - it used to be a
  | hard-coded HashingEmbeddingGenerator, so `watch` silently ignored the
  | provider that built the index. Built once, before the scan, so a bad
  | provider/API key fails immediately.
  */
  const { embeddingGenerator } = resolveVectorPlan(args, Boolean(existingIndex?.vectorChunks));
  const vectorIndexer = embeddingGenerator ? new VectorIndexer({ embeddingGenerator }) : null;

  try {
    let projectIndex: ProjectIndex;
    let indexedFiles: number;

    if (skipInitialIndex) {
      if (!existingIndex) {
        return {
          code: EXIT.failure,
          error: `cannot skip the initial index: ${indexPath} does not exist`,
        };
      }
      projectIndex = existingIndex;
      indexedFiles = projectIndex.files.length;
    } else {
      const extractionCache = extractors.fingerprint && boolOption(args.options, 'cache', true)
        ? new ExtractionCache(watchPaths.extractionCachePath, extractors.fingerprint, {
            reuse: !boolOption(args.options, 'full', false),
          })
        : null;
      const indexed = await new IndexPipeline({
        extractionCache,
        workspaceRoot: root,
        outputPath: indexPath,
        symbolExtractors: extractors.symbols,
        dependencyExtractors: extractors.dependencies,
        logger: context.logger,
        ...(Object.keys(scanOverrides).length > 0 ? { scannerConfig: scanOverrides } : {}),
        gitCollector: wantsGit ? new GitInfoCollector(root) : null,
        vectorIndexer,
        ...(existingIndex?.vectorChunks
          ? { previousVectorChunks: existingIndex.vectorChunks }
          : {}),
        /*
        | diagnostics فقط در ایندکس اولیه گرفته می‌شود؛ batchهای افزایشی
        | زبان‌سرور اجرا نمی‌کنند و diagnostics فایلِ دست‌خورده پاک می‌شود
        | (SE-INC-11) تا هشدار کهنه گزارش نشود.
        */
        ...(extractors.diagnosticsSource
          ? { diagnosticsSource: extractors.diagnosticsSource }
          : {}),
        ...(diagnosticsBudget ? { diagnosticsBudgetMs: Number(diagnosticsBudget) } : {}),
        pretty,
      }).run();

      projectIndex = indexed.projectIndex;
      indexedFiles = indexed.stats.files;

      await new OutputWriter({
        outputDir,
        logger: context.logger,
        pretty,
        blueprint: wantsBlueprint,
        ...(projectIndex.git?.commit ? { gitCommit: projectIndex.git.commit } : {}),
      }).write(projectIndex);
    }

    const engine = new IncrementalEngine({
      workspaceRoot: root,
      symbolExtractorManager: extractors.symbols,
      dependencyExtractorManager: extractors.dependencies,
      vectorIndexer,
      logger: context.logger,
    });
    engine.load(projectIndex);

    const pipeline = new WatchPipeline({
      workspaceRoot: root,
      outputDir,
      engine,
      logger: context.logger,
      pretty,
      blueprint: wantsBlueprint,
      blueprintMode: mode,
      ...(stringOption(args.options, 'debounce')
        ? { debounceMs: Number(stringOption(args.options, 'debounce')) }
        : {}),
    });

    pipeline.onBatchComplete(result => {
      process.stderr.write(
        `updated: ${result.changedFileIds.length} changed, ` +
          `${result.removedFileIds.length} removed, ` +
          `${result.dependentFileIds.length} dependents\n`
      );
    });
    pipeline.onError(error => {
      process.stderr.write(`batch failed: ${error.message}\n`);
    });

    await pipeline.watchFilesystem();

    /*
    | نصب handler **پیش از** اعلام آمادگی، نه بعدش (فاز ۴۹).
    |
    | ترتیب قبلی این بود: اول «press Ctrl+C to stop» نوشته می‌شد و
    | بعد `waitForShutdown` صدا زده می‌شد. بین آن دو خط پروسه هیچ
    | شنونده‌ای برای SIGINT/SIGTERM نداشت، پس سیگنال با رفتار
    | پیش‌فرض آن را می‌کشت: نه `dispose`، نه پاک شدن فایل PID.
    |
    | اندازه‌گیری روی ماشین شلوغ: از هر ۸ اجرا، ۵ تا با
    | `signal=SIGTERM` و فایل PID جامانده تمام می‌شد. روی ماشین
    | بی‌کار ۰ از ۸ — به همین دلیل شبیه flake به نظر می‌رسید.
    |
    | `waitForShutdown` شنونده‌ها را همان لحظهٔ فراخوانی نصب می‌کند
    | (executor یک Promise همگام اجرا می‌شود)، پس فقط کافی است
    | نتیجه‌اش نگه داشته شود و بعد از اعلام، انتظار کشیده شود.
    */
    const shutdown = waitForShutdown(async () => {
      await pipeline.dispose();
    });

    process.stderr.write(
      `watching ${root} (${indexedFiles} files indexed, pid ${process.pid})\n` +
        `press Ctrl+C to stop\n`
    );

    await shutdown;

    return { code: EXIT.ok, text: `stopped after ${pipeline.stats().batches} update(s)` };
  } finally {
    extractors.dispose();
    releasePidFile(pidPath);
  }
}
