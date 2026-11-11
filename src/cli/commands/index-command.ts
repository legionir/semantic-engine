/**
 * `semantic-engine index` — MIG-51.
 *
 * همان کاری که `scripts/run-pipeline.js` می‌کرد، ولی به‌عنوان یک
 * دستور واقعی: با پرچم، با کد خروج، و با خروجی ماشین‌خوان.
 */

import * as fs from 'fs';
import { IndexBusyError, readPreviousIndex, runIndexJob } from '../../pipeline/runIndexJob';
import { resolveVectorPlan } from '../embeddingFromArgs';
import { EXIT, ParsedArgs, boolOption, stringOption } from '../args';
import { CommandContext, CommandResult } from './types';
import { loadGlobalConfig, scannerOverridesFrom } from '../../core/config/GlobalConfig';
import { normalizeWorkspaceRoot, PROJECT_OUTPUT_DIR } from '../../core/config/ProjectPaths';
import { migrateLegacyArtifacts } from '../../core/config/migrateLegacyArtifacts';
import { projectPathsFromArgs } from '../projectPathsFromArgs';
import { mergeScanOverrides, parseScanFlags } from '../scanFlags';

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
  const scanFlags = parseScanFlags(args);
  if (!scanFlags.ok) return { code: EXIT.usage, error: scanFlags.error };
  const scanOverrides = mergeScanOverrides(
    scannerOverridesFrom(loadGlobalConfig(projectPaths.dataRoot).config),
    scanFlags.overrides
  );
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
  const previousIndex = readPreviousIndex(outputDir);
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
  | `--full` ignores the extraction cache (and rebuilds it); `--no-cache`
  | neither reads nor writes it.
  */
  const cache = !boolOption(args.options, 'cache', true)
    ? 'off'
    : boolOption(args.options, 'full', false) ? 'rebuild' : 'reuse';

  let result;
  try {
    result = await runIndexJob({
      workspaceRoot: root,
      outputDir,
      logger: context.logger,
      cache,
      scannerConfig: scanOverrides,
      git: wantsGit,
      treeSitter: boolOption(args.options, 'treeSitter', true),
      /* the generator is built before the scan, so a bad provider or key fails early */
      embeddingGenerator: wantsVectors ? plannedGenerator : null,
      vectors: wantsVectors,
      lspDiagnostics: wantsLspDiagnostics,
      ...(diagnosticsBudget ? { diagnosticsBudgetMs: Number(diagnosticsBudget) } : {}),
      pretty,
      blueprint: wantsBlueprint,
    });
  } catch (error) {
    if (error instanceof IndexBusyError) return { code: EXIT.failure, error: error.message };
    throw error;
  }

  return {
    code: EXIT.ok,
    json: {
      ok: true,
      root,
      files: result.files,
      symbols: result.symbols,
      durationMs: result.durationMs,
      ...(result.extractionCache ? { extractionCache: result.extractionCache } : {}),
      indexPath: result.indexPath,
      blueprintPath: result.blueprintPath,
      artifactRoot: outputDir,
      artifactLocation: projectPaths.location,
      ...(migration.migrated
        ? { migratedFrom: migration.from, migrationMode: 'copy-readonly-legacy' }
        : {}),
    },
    text:
      `indexed ${result.files} files, ${result.symbols} symbols in ${result.durationMs}ms\n` +
      `  ${result.indexPath}` +
      (result.blueprintPath ? `\n  ${result.blueprintPath}` : ''),
  };
}
