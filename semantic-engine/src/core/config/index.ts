export { ScannerConfig, DEFAULT_SCANNER_CONFIG, createScannerConfig } from './ScannerConfig';
export {
  DEFAULT_IGNORE_DIRECTORIES,
  DEFAULT_IGNORE_FILE_PATTERNS,
  SKIP_HIDDEN_DIRECTORIES,
} from './defaultIgnorePatterns';
export {
  PROJECT_OUTPUT_DIR,
  LEGACY_PROJECT_OUTPUT_DIR,
  LEGACY_FLAT_OUTPUT_DIR,
  PROJECT_INDEX_FILE,
  PROJECTS_DIR_NAME,
  BLUEPRINT_FILE,
  PROJECT_ARTIFACTS_MANIFEST_FILE,
  LOCKS_DIR,
  LOGS_DIR,
  EVENTS_DIR,
  RUNTIME_DIR,
  SNAPSHOTS_DIR,
  artifactRootFor,
  canonicalIndexPath,
  indexPathCandidates,
  normalizeWorkspaceRoot,
  resolveProjectIndexPath,
  resolveProjectPaths,
  workspaceRootFromIndexPath,
  workspaceRootFromIndex,
} from './ProjectPaths';
export type {
  IndexLookupOptions,
  ProjectPaths,
  ResolveProjectPathsOptions,
} from './ProjectPaths';
export {
  MIGRATION_FILE,
  MIGRATION_MODE_COPY_READONLY,
  MIGRATION_SCHEMA_VERSION,
  migrateLegacyArtifacts,
} from './migrateLegacyArtifacts';
export type { MigrationResult, MigrationStatus } from './migrateLegacyArtifacts';
export {
  ARTIFACT_LOCATIONS,
  DATA_DIR_CONFIG_KEY,
  DATA_DIR_ENV_VAR,
  DATA_DIR_NAME_POSIX,
  DATA_DIR_NAME_WINDOWS,
  DEFAULT_ARTIFACT_LOCATION,
  ARTIFACT_LOCATION_CONFIG_KEY,
  artifactLocationOrDefault,
  ensureDataRoot,
  isArtifactLocation,
  platformDataRoot,
  resolveDataRoot,
} from './DataRootResolver';
export type { ArtifactLocation, DataRootOptions } from './DataRootResolver';
export {
  MANIFEST_SCHEMA_VERSION,
  PROJECT_MANIFEST_FILE,
  ProjectRegistry,
  REGISTRY_FILE,
  REGISTRY_VERSION,
  defaultRegistryPath,
  ensureRegistryPath,
} from './ProjectRegistry';
export type { ProjectRecord, ProjectRegistryOptions, RegisterProjectInput } from './ProjectRegistry';
export {
  PATH_SAFE_PROJECT_ID_PATTERN,
  PROJECT_ID_MAX_LENGTH,
  PROJECT_ID_PATTERN,
  PROJECT_ID_PREFIX,
  SAFE_PROJECT_ID_PATTERN,
  assertPathSafeProjectId,
  assertProjectId,
  assertProjectRoot,
  canonicalizeRoot,
  isPathSafeProjectId,
  isSafeProjectId,
  isValidProjectId,
  normalizeDriveLetter,
  projectIdFor,
  projectHash,
  slugify,
} from './ProjectIdentity';
