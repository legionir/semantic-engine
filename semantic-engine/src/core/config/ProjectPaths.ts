/**
 * Canonical locations for project artifacts.
 *
 * The CLI writes indexes to `<workspace>/.semantic-engine`. Older versions
 * of the Structured AI integration used `<workspace>/.agent/semantic`; those
 * locations are read as compatibility fallbacks, but are never selected for
 * new output. Keeping the rules here prevents `serve`, `query`, `watch`, the
 * platform registry, and the standalone MCP entry point from inventing
 * slightly different roots.
 */

import * as path from 'path';
import * as fs from 'fs';
import { ArtifactLocation, DEFAULT_ARTIFACT_LOCATION, resolveDataRoot } from './DataRootResolver';
import { assertPathSafeProjectId, isPathSafeProjectId } from './ProjectIdentity';

export const PROJECT_OUTPUT_DIR = '.semantic-engine';
export const LEGACY_PROJECT_OUTPUT_DIR = path.join('.agent', 'semantic');
export const LEGACY_FLAT_OUTPUT_DIR = 'semantic';
export const PROJECT_INDEX_FILE = 'project-index.json';

/**
 * Convert a project-ish path to the actual workspace root.
 *
 * `--root` is occasionally supplied by an integration with the runtime
 * directory (`.agent`) or one of the artifact directories. Treat those as
 * aliases for their parent workspace instead of appending another output
 * directory to them (`.agent/.semantic-engine` or `.semantic-engine/...`).
 */
export function normalizeWorkspaceRoot(input: string): string {
  let resolved = path.resolve(input);
  const base = path.basename(resolved).toLowerCase();
  const parent = path.basename(path.dirname(resolved)).toLowerCase();

  if (base === PROJECT_OUTPUT_DIR.toLowerCase()) {
    return path.dirname(resolved);
  }

  if (
    base === path.basename(LEGACY_PROJECT_OUTPUT_DIR).toLowerCase() &&
    parent === path.basename(path.dirname(LEGACY_PROJECT_OUTPUT_DIR)).toLowerCase()
  ) {
    return path.dirname(path.dirname(resolved));
  }

  /* A pre-canonical build also used `<workspace>/semantic`. Only treat it as
     an artifact directory when it actually contains an index; a real source
     directory named `semantic` must remain a valid workspace root. */
  if (
    base === LEGACY_FLAT_OUTPUT_DIR &&
    fs.existsSync(path.join(resolved, PROJECT_INDEX_FILE))
  ) {
    return path.dirname(resolved);
  }

  /* `.agent` is the Structured AI runtime directory, not the project root. */
  if (base === '.agent') {
    return path.dirname(resolved);
  }

  return resolved;
}

/** Canonical path where a new index for `workspaceRoot` is written. */
export function canonicalIndexPath(workspaceRoot: string): string {
  return path.join(
    normalizeWorkspaceRoot(workspaceRoot),
    PROJECT_OUTPUT_DIR,
    PROJECT_INDEX_FILE
  );
}

/**
 * گزینه‌های پیدا کردن ایندکس وقتی artifact بیرون از root نگه داشته می‌شود.
 * همه اختیاری‌اند: بدون آن‌ها رفتار دقیقاً مثل قبل است.
 */
export interface IndexLookupOptions {
  readonly location?: ArtifactLocation;
  readonly projectId?: string;
  readonly dataRoot?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: string;
  readonly homeDir?: string;
}

/**
 * Candidate index locations, ordered from current to legacy. The canonical
 * candidate is returned even when it does not exist so callers have a stable
 * path to report in an error.
 *
 * در حالت `external` مسیر data directory *اول* می‌آید و مسیرهای in-root به
 * عنوان fallback خواندنی باقی می‌مانند — همان ترتیبی که گام ۳ پلن خواسته.
 */
export function indexPathCandidates(
  workspaceRoot: string,
  options: IndexLookupOptions = {}
): string[] {
  const root = normalizeWorkspaceRoot(workspaceRoot);
  const inRoot = [
    path.join(root, PROJECT_OUTPUT_DIR, PROJECT_INDEX_FILE),
    path.join(root, LEGACY_PROJECT_OUTPUT_DIR, PROJECT_INDEX_FILE),
    path.join(root, LEGACY_FLAT_OUTPUT_DIR, PROJECT_INDEX_FILE),
  ];

  const location = options.location ?? DEFAULT_ARTIFACT_LOCATION;
  const projectId = options.projectId ?? '';
  if (location !== 'external' || !isPathSafeProjectId(projectId)) return inRoot;

  const external = path.join(
    artifactRootFor({
      projectId,
      workspaceRoot: root,
      location: 'external',
      ...(options.dataRoot !== undefined ? { dataRoot: options.dataRoot } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
      ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    }),
    PROJECT_INDEX_FILE
  );

  return [external, ...inRoot];
}

/** Resolve an explicit file, or the first existing/default index for a root. */
export function resolveProjectIndexPath(
  workspaceRoot: string,
  explicitPath?: string,
  options: IndexLookupOptions = {}
): string {
  if (explicitPath && explicitPath.trim() !== '') {
    return path.resolve(explicitPath);
  }

  const candidates = indexPathCandidates(workspaceRoot, options);
  return candidates.find(candidate => fs.existsSync(candidate)) ?? candidates[0]!;
}

/**
 * Recover a workspace root from an index file when `rootPath` is absent (old
 * indexes only had the display-name `root` field).
 */
export function workspaceRootFromIndexPath(indexPath: string): string {
  const resolved = path.resolve(indexPath);
  const outputDir = path.basename(path.dirname(resolved)).toLowerCase();
  const outputParent = path.basename(path.dirname(path.dirname(resolved))).toLowerCase();

  if (outputDir === PROJECT_OUTPUT_DIR.toLowerCase()) {
    return path.dirname(path.dirname(resolved));
  }

  if (
    outputDir === path.basename(LEGACY_PROJECT_OUTPUT_DIR).toLowerCase() &&
    outputParent === path.basename(path.dirname(LEGACY_PROJECT_OUTPUT_DIR)).toLowerCase()
  ) {
    return path.dirname(path.dirname(path.dirname(resolved)));
  }

  if (outputDir === LEGACY_FLAT_OUTPUT_DIR) {
    return path.dirname(path.dirname(resolved));
  }

  return path.dirname(path.dirname(resolved));
}

/** Normalize an index's persisted root path, including old `.agent` values. */
export function workspaceRootFromIndex(
  index: { readonly rootPath?: string },
  indexPath: string
): string {
  /* `rootPath` can point to the machine that produced a committed index.
     Use it only while it still exists; otherwise the index location is the
     portable source of truth. An explicit CLI --root is handled by callers
     before this function and remains authoritative. */
  const persistedRoot =
    index.rootPath &&
    path.isAbsolute(index.rootPath) &&
    fs.existsSync(index.rootPath)
      ? index.rootPath
      : workspaceRootFromIndexPath(indexPath);

  return normalizeWorkspaceRoot(persistedRoot);
}

/*
|── پروژهٔ واحد: تفکیک source از artifact (فاز ۱) ─────────────────────────
|
| تا اینجا این ماژول فقط یک سؤال داشت: «project-index.json کجاست؟». Gateway
| چندپروژه‌ای سؤال بزرگ‌تری دارد: «همهٔ artifactهای *این* پروژه کجا
| نوشته/خوانده شوند؟» — و پاسخ باید در CLI، Worker، Gateway، MCP و UI یکی
| باشد، وگرنه هرکدام یک ریشهٔ کمی متفاوت حدس می‌زنند.
|
| دو قانون:
|
|   1. `workspaceRoot` همیشه source است و هرگز با artifact قاطی نمی‌شود.
|   2. `artifactRoot` یا داخل root است (رفتار امروز، `in-root`) یا زیر data
|      directory کاربر (`external`). انتخاب با `artifactLocation` است و
|      `--out` صریح، مثل امروز، بر هر دو مقدم است.
|
| در فاز ۱ هیچ رفتاری عوض نمی‌شود: پیش‌فرض `in-root` است و خروجی
| `resolveProjectPaths` با `canonicalIndexPath` می‌خواند.
*/

/** زیرپوشهٔ پروژه‌ها در data root. */
export const PROJECTS_DIR_NAME = 'projects';

export const BLUEPRINT_FILE = 'blueprint.json';
export const PROJECT_ARTIFACTS_MANIFEST_FILE = 'project-artifacts.manifest.json';

export const LOCKS_DIR = 'locks';
export const CACHE_DIR = 'cache';
export const EXTRACTION_CACHE_FILE = 'extraction.json';
export const LOGS_DIR = 'logs';
export const EVENTS_DIR = 'events';
export const SNAPSHOTS_DIR = 'snapshots';

/**
 * state سطح پروسه (صف jobها، telemetry) زیر data root. این‌ها به یک پروژهٔ
 * خاص وابسته نیستند، پس کنار `projects/` می‌نشینند نه داخل آن — و مهم‌تر از
 * همه، هرگز داخل source root.
 */
export const RUNTIME_DIR = 'runtime';

/** تمام مسیرهای یک پروژه، تفکیک‌شده به source و generated data. */
export interface ProjectPaths {
  /** شناسهٔ پایدار؛ بخشی از مسیر artifact در حالت `external`. */
  readonly projectId: string;
  /** ریشهٔ source — فقط خواندن. */
  readonly workspaceRoot: string;
  /** کجا نوشته می‌شود. */
  readonly location: ArtifactLocation;
  /** data root مؤثر (همیشه پر است؛ در حالت `in-root` فقط برای گزارش). */
  readonly dataRoot: string;
  /** ریشهٔ همهٔ artifactهای این پروژه. */
  readonly artifactRoot: string;
  readonly indexPath: string;
  readonly blueprintPath: string;
  readonly manifestPath: string;
  readonly lockDir: string;
  readonly logDir: string;
  /** کش مشتق (قابل بازسازی)؛ حذفش فقط اجرای بعدی را کند می‌کند. */
  readonly extractionCachePath: string;
}

export interface ResolveProjectPathsOptions {
  readonly projectId: string;
  readonly workspaceRoot: string;
  /** data root صریح؛ در غیر این صورت از `resolveDataRoot` می‌آید. */
  readonly dataRoot?: string;
  /** `--out`؛ مثل امروز بر هر دو حالت مقدم است. */
  readonly outOverride?: string;
  readonly location?: ArtifactLocation;
  /** برای تست: env/platform/homeDir به `resolveDataRoot` پاس داده می‌شود. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: string;
  readonly homeDir?: string;
}

/**
 * ریشهٔ artifact یک پروژه.
 *
 * `outOverride` دقیقاً همان معنا را دارد که در `index-command` داشت
 * (`path.resolve(root, out)`)، پس یک `--out` مطلق امروز و فردا یک کار می‌کند.
 */
export function artifactRootFor(options: ResolveProjectPathsOptions): string {
  /*
  | شناسه مستقیماً بخشی از مسیر است، پس پیش از هر `path.join` اعتبارسنجی
  | می‌شود؛ `prj-../other` باید خطا بدهد، نه یک مسیر بیرون‌زده بسازد.
  */
  /* `assertPathSafeProjectId` و نه `assertProjectId`: شناسه‌های موجود در
     دنیا (`current`، `sample-app`) پیشوند `prj-` ندارند ولی بی‌خطرند. */
  const projectId = assertPathSafeProjectId(options.projectId);
  const root = normalizeWorkspaceRoot(options.workspaceRoot);

  const outOverride = (options.outOverride ?? '').trim();
  if (outOverride !== '') {
    return path.resolve(root, outOverride);
  }

  const location = options.location ?? DEFAULT_ARTIFACT_LOCATION;
  if (location === 'external') {
    const explicitDataRoot = (options.dataRoot ?? '').trim();
    const dataRoot = explicitDataRoot !== ''
      ? path.resolve(explicitDataRoot)
      : resolveDataRoot({
          env: options.env,
          platform: options.platform,
          homeDir: options.homeDir,
        });
    return path.join(dataRoot, PROJECTS_DIR_NAME, projectId);
  }

  return path.join(root, PROJECT_OUTPUT_DIR);
}

/**
 * Every path one project owns, in one object.
 *
 * Callers must not re-derive any of these; a caller that joins
 * `.semantic-engine` by hand is exactly the bug this module exists to end.
 */
export function resolveProjectPaths(options: ResolveProjectPathsOptions): ProjectPaths {
  /* همان اعتبارسنجی `artifactRootFor`؛ شناسه نام پوشه می‌شود. */
  const projectId = assertPathSafeProjectId(options.projectId);
  const workspaceRoot = normalizeWorkspaceRoot(options.workspaceRoot);
  const location = options.location ?? DEFAULT_ARTIFACT_LOCATION;
  const artifactRoot = artifactRootFor(options);

  return {
    projectId,
    workspaceRoot,
    location,
    dataRoot: resolveDataRoot({
      dataDir: options.dataRoot,
      env: options.env,
      platform: options.platform,
      homeDir: options.homeDir,
    }),
    artifactRoot,
    indexPath: path.join(artifactRoot, PROJECT_INDEX_FILE),
    blueprintPath: path.join(artifactRoot, BLUEPRINT_FILE),
    manifestPath: path.join(artifactRoot, PROJECT_ARTIFACTS_MANIFEST_FILE),
    lockDir: path.join(artifactRoot, LOCKS_DIR),
    logDir: path.join(artifactRoot, LOGS_DIR),
    extractionCachePath: path.join(artifactRoot, CACHE_DIR, EXTRACTION_CACHE_FILE),
  };
}
