/**
 * Migration from in-root artifacts — MULTI_PROJECT_GATEWAY_EXECUTION_PLAN فاز ۳.
 *
 * Indexes used to live inside the checkout (`<root>/.semantic-engine`, and
 * before that `<root>/.agent/semantic` and `<root>/semantic`). Once artifacts
 * move to the data directory, an existing index must not be thrown away: it is
 * **copied** to the new location, the copy is recorded, and the legacy files
 * are left exactly where they are.
 *
 * Three rules this module never breaks:
 *
 *   - legacy artifacts are never deleted, even after a successful migration;
 *   - a corrupt legacy index downgrades to `corrupt-legacy` instead of
 *     throwing, so a broken checkout cannot stop the Gateway from starting;
 *   - nothing at all happens while `artifactLocation` is `in-root`, which is
 *     still the default in this phase.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  BLUEPRINT_FILE,
  PROJECT_ARTIFACTS_MANIFEST_FILE,
  PROJECT_INDEX_FILE,
  indexPathCandidates,
  resolveProjectPaths,
} from './ProjectPaths';
import { ArtifactLocation, DEFAULT_ARTIFACT_LOCATION } from './DataRootResolver';

export const MIGRATION_FILE = 'migration.json';
export const MIGRATION_MODE_COPY_READONLY = 'copy-readonly-legacy';
export const MIGRATION_SCHEMA_VERSION = 1;

export type MigrationStatus =
  /** در data directory از قبل ایندکس هست؛ کاری لازم نیست. */
  | 'external-already'
  /** کپی انجام شد. */
  | 'migrated'
  /** هیچ artifact legacy پیدا نشد. */
  | 'no-legacy'
  /** artifact legacy خراب است؛ پروژه باید `stale` بماند، نه crash. */
  | 'corrupt-legacy'
  /** حالت `in-root`؛ عمداً کاری نکردیم. */
  | 'skipped';

export interface MigrationResult {
  readonly status: MigrationStatus;
  readonly migrated: boolean;
  /** پوشهٔ legacy که از آن کپی شد. */
  readonly from?: string;
  /** artifactRoot مقصد. */
  readonly to?: string;
  readonly indexPath?: string;
  readonly copied: readonly string[];
  readonly error?: string;
}

export interface MigrateLegacyArtifactsOptions {
  readonly workspaceRoot: string;
  readonly projectId: string;
  readonly dataRoot?: string;
  readonly location?: ArtifactLocation;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: string;
  readonly homeDir?: string;
  readonly now?: () => Date;
}

/** فایل‌هایی که با ایندکس جابه‌جا می‌شوند. pid و لاگ عمداً کپی نمی‌شوند. */
const MIGRATABLE_FILES: readonly string[] = [
  PROJECT_INDEX_FILE,
  BLUEPRINT_FILE,
  PROJECT_ARTIFACTS_MANIFEST_FILE,
];

export function migrateLegacyArtifacts(options: MigrateLegacyArtifactsOptions): MigrationResult {
  const location = options.location ?? DEFAULT_ARTIFACT_LOCATION;
  if (location !== 'external') {
    return { status: 'skipped', migrated: false, copied: [] };
  }

  const paths = resolveProjectPaths({
    projectId: options.projectId,
    workspaceRoot: options.workspaceRoot,
    location: 'external',
    ...(options.dataRoot !== undefined ? { dataRoot: options.dataRoot } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
  });

  if (fs.existsSync(paths.indexPath)) {
    return {
      status: 'external-already',
      migrated: false,
      to: paths.artifactRoot,
      indexPath: paths.indexPath,
      copied: [],
    };
  }

  /* فقط مسیرهای in-root؛ مسیر external را خودمان ساختیم و خالی است. */
  const legacyIndex = indexPathCandidates(options.workspaceRoot, { location: 'in-root' })
    .find(candidate => fs.existsSync(candidate));

  if (!legacyIndex) {
    return { status: 'no-legacy', migrated: false, to: paths.artifactRoot, copied: [] };
  }

  const legacyDir = path.dirname(legacyIndex);

  try {
    JSON.parse(fs.readFileSync(legacyIndex, 'utf8'));
  } catch (error) {
    return {
      status: 'corrupt-legacy',
      migrated: false,
      from: legacyDir,
      to: paths.artifactRoot,
      copied: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }

  fs.mkdirSync(paths.artifactRoot, { recursive: true, mode: 0o700 });

  const copied: string[] = [];
  for (const file of MIGRATABLE_FILES) {
    const source = path.join(legacyDir, file);
    if (!fs.existsSync(source)) continue;
    fs.copyFileSync(source, path.join(paths.artifactRoot, file));
    copied.push(file);
  }

  const migration = {
    schemaVersion: MIGRATION_SCHEMA_VERSION,
    migratedFrom: legacyDir,
    migratedAt: (options.now ?? (() => new Date()))().toISOString(),
    migrationMode: MIGRATION_MODE_COPY_READONLY,
    files: copied,
  };
  fs.writeFileSync(
    path.join(paths.artifactRoot, MIGRATION_FILE),
    `${JSON.stringify(migration, null, 2)}\n`
  );

  return {
    status: 'migrated',
    migrated: true,
    from: legacyDir,
    to: paths.artifactRoot,
    indexPath: paths.indexPath,
    copied,
  };
}
