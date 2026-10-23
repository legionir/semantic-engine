/**
 * `semantic-engine index` — MIG-51.
 *
 * همان کاری که `scripts/run-pipeline.js` می‌کرد، ولی به‌عنوان یک
 * دستور واقعی: با پرچم، با کد خروج، و با خروجی ماشین‌خوان.
 */

import * as fs from 'fs';
import * as path from 'path';
import { IndexPipeline } from '../../pipeline/IndexPipeline';
import { ExtractionCache } from '../../pipeline/ExtractionCache';
import { createExtractors } from '../../pipeline/ExtractorFactory';
import { OutputWriter, INDEX_FILE_NAME } from '../../pipeline/OutputWriter';
import { GitInfoCollector } from '../../core/git';
import { VectorIndexer } from '../../vector/VectorIndexer';
import { IEmbeddingGenerator } from '../../vector/EmbeddingGenerator';
import { resolveVectorPlan } from '../embeddingFromArgs';
import { ProjectIndex } from '../../core/types/project-index.types';
import { EXIT, ParsedArgs, boolOption, stringOption } from '../args';
import { CommandContext, CommandResult } from './types';
import { loadGlobalConfig, scannerOverridesFrom } from '../../core/config/GlobalConfig';
import { normalizeWorkspaceRoot, PROJECT_OUTPUT_DIR } from '../../core/config/ProjectPaths';
import { migrateLegacyArtifacts } from '../../core/config/migrateLegacyArtifacts';
import { projectPathsFromArgs } from '../projectPathsFromArgs';

export const DEFAULT_OUTPUT_DIR = PROJECT_OUTPUT_DIR;

export async function runIndex(args: ParsedArgs, context: CommandContext): Promise<CommandResult> {
  const root = normalizeWorkspaceRoot(stringOption(args.options, 'root') ?? context.cwd);


  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return {
      code: EXIT.failure,
      error: `--root does not exist or is not a directory: ${root}`,
    };
  }

  /*
  | مسیر artifact فقط از `resolveProjectPaths` می‌آید. `--out` صریح همان معنای
  | قبلی را دارد (`path.resolve(root, out)`)، پس یک `--out` مطلق امروز و فردا
  | یک کار می‌کند؛ فقط پیش‌فرض است که با
  | `SEMANTIC_ENGINE_ARTIFACT_LOCATION=external` به data directory می‌رود.
  */
  const projectPaths = projectPathsFromArgs(args, root);
  const outputDir = projectPaths.artifactRoot;

  /*
  | پیش از هر خواندن/نوشتن: اگر artifact قدیمی داخل root باشد و مقصد بیرون،
  | یک بار کپی می‌شود (بدون حذف legacy). در حالت `in-root` این فراخوانی عمداً
  | هیچ کاری نمی‌کند.
  */
  const migration = migrateLegacyArtifacts({
    workspaceRoot: root,
    projectId: projectPaths.projectId,
    location: projectPaths.location,
    dataRoot: projectPaths.dataRoot,
  });

  const wantsBlueprint = boolOption(args.options, 'blueprint', true);
  const wantsGit = boolOption(args.options, 'git', true);
  const scanOverrides = scannerOverridesFrom(loadGlobalConfig(projectPaths.dataRoot).config);
  /*
  | SE-VEC-02 — تا فاز ۴۴ اینجا `vectorIndexer: null` هاردکد بود و
  | هیچ پرچمی هم نداشت، پس `vectorChunks` هرگز تولید نمی‌شد و
  | «جست‌وجوی معنایی» در عمل همیشه کلیدواژه‌ای بود. حالا با
  | `--vectors` روشن می‌شود.
  |
  | پیش‌فرض خاموش است چون هزینهٔ زمان و اندازهٔ فایل دارد، نه چون
  | کار نمی‌کند. اگر ایندکس قبلی vector داشته باشد، آن حالت به‌طور
  | خودکار حفظ می‌شود تا یک refresh معمولیِ index vectorها را
  | ناخواسته حذف نکند؛ `--no-vectors` برای خاموش‌کردن صریح است.
  */
  const existingIndexPath = path.join(outputDir, INDEX_FILE_NAME);
  let previousIndex: ProjectIndex | null = null;
  if (fs.existsSync(existingIndexPath)) {
    try {
      previousIndex = JSON.parse(fs.readFileSync(existingIndexPath, 'utf8')) as ProjectIndex;
    } catch {
      previousIndex = null;
    }
  }
  /*
  | `--embedding-provider` صریح یعنی کاربر embedding می‌خواهد، پس vectorها هم
  | روشن می‌شوند؛ در غیر این صورت همان رفتار قبلی (flag یا ایندکس قبلی).
  */
  const { wantsVectors, embeddingGenerator: plannedGenerator } = resolveVectorPlan(
    args,
    Boolean(previousIndex?.vectorChunks)
  );
  const pretty = boolOption(args.options, 'pretty', true);
  /*
  | diagnostics زبان‌سرور (فاز ۳۴) — پیش‌فرض خاموش، چون هزینه‌اش واقعی است:
  | روی ۱۶۴ فایل همین مخزن زبان‌سرور ~۷٫۷s می‌برد. `--diagnostics-budget <ms>`
  | سقف کار است و فایل‌های پشتِ سقف «بررسی‌نشده» می‌مانند، نه «تمیز».
  */
  const wantsLspDiagnostics = boolOption(args.options, 'lspDiagnostics', false);
  const diagnosticsBudget = stringOption(args.options, 'diagnosticsBudget');

  /*
  | یک بار و پیش از scan ساخته می‌شود تا خطای provider یا کلید API همان‌جا
  | دیده شود، نه بعد از خواندن کل مخزن.
  */
  const embeddingGenerator: IEmbeddingGenerator | undefined = plannedGenerator;

  const extractors = createExtractors({
    workspaceRoot: root,
    treeSitter: boolOption(args.options, 'treeSitter', true),
    logger: context.logger,
    lspDiagnostics: wantsLspDiagnostics,
  });
  if (wantsLspDiagnostics && !extractors.diagnosticsSource) {
    context.logger.warn(
      'diagnostics requested but no language server is usable — index will carry no LSP diagnostics'
    );
  }

  /*
  | کش استخراج هر فایل. `--full` کش را نادیده می‌گیرد (و دوباره می‌سازد)؛
  | `--no-cache` اصلاً نه می‌خواند نه می‌نویسد.
  */
  const extractionCache = extractors.fingerprint && boolOption(args.options, 'cache', true)
    ? new ExtractionCache(projectPaths.extractionCachePath, extractors.fingerprint, {
        reuse: !boolOption(args.options, 'full', false),
      })
    : null;

  try {
    const { projectIndex, stats } = await new IndexPipeline({
      workspaceRoot: root,
      outputPath: path.join(outputDir, INDEX_FILE_NAME),
      symbolExtractors: extractors.symbols,
      dependencyExtractors: extractors.dependencies,
      logger: context.logger,
      extractionCache,
      /*
      | git به‌طور پیش‌فرض روشن است چون یک ایندکس بدون تاریخچه، نصف
      | سیگنال‌های رتبه‌بندی را ندارد. `--no-git` برای مخزنی که git
      | نیست، یا برای خروجی قطعی.
      */
      ...(Object.keys(scanOverrides).length > 0 ? { scannerConfig: scanOverrides } : {}),
      gitCollector: wantsGit ? new GitInfoCollector(root) : null,
      vectorIndexer: wantsVectors
        ? new VectorIndexer({ embeddingGenerator })
        : null,
      ...(previousIndex?.vectorChunks
        ? { previousVectorChunks: previousIndex.vectorChunks }
        : {}),
      ...(extractors.diagnosticsSource
        ? { diagnosticsSource: extractors.diagnosticsSource }
        : {}),
      ...(diagnosticsBudget ? { diagnosticsBudgetMs: Number(diagnosticsBudget) } : {}),
      pretty,
    }).run();

    const written = await new OutputWriter({
      outputDir,
      logger: context.logger,
      pretty,
      blueprint: wantsBlueprint,
      ...(projectIndex.git?.commit ? { gitCommit: projectIndex.git.commit } : {}),
    }).write(projectIndex);

    return {
      code: EXIT.ok,
      json: {
        ok: true,
        root,
        files: stats.files,
        symbols: stats.symbols,
        durationMs: stats.durationMs,
        ...(stats.extractionCache ? { extractionCache: stats.extractionCache } : {}),
        indexPath: written.indexPath,
        blueprintPath: written.blueprintPath,
        artifactRoot: outputDir,
        artifactLocation: projectPaths.location,
        ...(migration.migrated
          ? { migratedFrom: migration.from, migrationMode: 'copy-readonly-legacy' }
          : {}),
      },
      text:
        `indexed ${stats.files} files, ${stats.symbols} symbols in ${stats.durationMs}ms\n` +
        `  ${written.indexPath}` +
        (written.blueprintPath ? `\n  ${written.blueprintPath}` : ''),
    };
  } finally {
    extractors.dispose();
  }
}
