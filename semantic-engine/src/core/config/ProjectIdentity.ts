/**
 * Stable project identity — MULTI_PROJECT_GATEWAY_EXECUTION_PLAN فاز ۱ (D3/D4).
 *
 * ── What was broken ────────────────────────────────────────────────────
 *
 * `ProjectService.registerProject` derived the id from the directory name:
 *
 * ```ts
 * const id = customId || `prj-${path.basename(rootPath).toLowerCase()…}`;
 * ```
 *
 * Two checkouts named `app` therefore produced the *same* id, and because the
 * registry is keyed by id the second registration silently replaced the
 * first. Measured while auditing the plan:
 *
 * ```text
 * registerProject('/tmp/…/client-a/app') → prj-app
 * registerProject('/tmp/…/client-b/app') → prj-app
 * listProjects().length → 1
 * ```
 *
 * ── The scheme chosen here ─────────────────────────────────────────────
 *
 * `prj-<slug(name)>-<sha256(canonicalRoot)[0:8]>`, i.e. exactly the algorithm
 * `structured-ai/agent/projects/ProjectRegistry.js:61` already ships
 * (`prj-engine-core-3fa9c1d2`). Reusing it — instead of the `prj-<uuid>` the
 * reference plan suggested — means the engine and its only consumer agree on
 * an id without a translation table, and an id stays human-recognisable in
 * logs and URLs.
 *
 * An id is computed **once**, at registration, and persisted. Renaming a
 * project afterwards changes the display name only; moving a project is an
 * explicit `relocate` (فاز ۲), never an accident of `basename`.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export const PROJECT_ID_PREFIX = 'prj-';

/**
 * Accepted ids: the generated form, plus any id an external registry
 * (structured-ai) hands over. Deliberately strict — the id becomes a
 * *directory name* under the data root, so anything outside this charset is a
 * path-traversal attempt, not a project.
 */
export const PROJECT_ID_PATTERN = /^prj-[a-z0-9][a-z0-9-]{0,63}$/;

/** Longest id we accept; the generated form is far shorter. */
export const PROJECT_ID_MAX_LENGTH = 68;

const SLUG_MAX_LENGTH = 24;
const HASH_LENGTH = 8;

/**
 * Display name → url/directory-safe slug.
 *
 * Same rules as structured-ai: lowercase, every run of non-alphanumerics
 * becomes one dash, dashes trimmed, capped at 24 characters, and a name with
 * nothing usable in it (including a purely non-Latin name) becomes `project`
 * rather than an empty slug.
 */
export function slugify(name: string): string {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH);

  return slug === '' ? 'project' : slug;
}

/** Short, stable fingerprint of a canonical root path. */
export function projectHash(canonicalRoot: string): string {
  return crypto
    .createHash('sha256')
    .update(canonicalRoot)
    .digest('hex')
    .slice(0, HASH_LENGTH);
}

/**
 * شناسهٔ یک پروژه نباید به **املای درایو** بند باشد.
 *
| SE-IDENT-01 — اندازه‌گیری‌شده روی همین مخزن:
|     cwd = 'I:\structured-ai\last\semantic-engine' → prj-semantic-engine-2d5b4da0
|     cwd = 'i:\structured-ai\last\semantic-engine' → prj-semantic-engine-fcc08d5f
| یعنی یک مخزن، دو شناسه، دو پوشهٔ داده. بدترینِ حالت این نیست که
| دوباره‌کاری شود: این است که ابزار روی یک شناسه **ایندکسِ کهنه** را
| می‌خواند و نتیجهٔ درستِ همان سؤال را نمی‌دهد — و هیچ خطایی هم
| ندارد. `path.resolve` جداکننده‌ها را یکی می‌کند ولی حرفِ درایو را
| دست نمی‌زند؛ `fs.realpathSync` هم آن را همان‌طور که آمده برمی‌گرداند.
 *
| قاعده: روی ویندوز حرفِ درایو بزرگ می‌شود (شکلِ استانداردِ خودِ
| ویندوز) و بقیهٔ مسیر دست‌نخورده می‌ماند — روی لینوکس/مک که
| بزرگی/کوچکی معنا دارد، هیچ چیزی عوض نمی‌شود.
 */
export function normalizeDriveLetter(rootPath: string): string {
  return /^[a-z]:[\\/]/.test(rootPath) ? rootPath.charAt(0).toUpperCase() + rootPath.slice(1) : rootPath;
}

/**
 * Resolve a root to its real path, falling back to the textual path when the
 * directory does not exist (an index can be inspected for a checkout that is
 * not mounted right now).
 *
 * Registration uses `assertProjectRoot` instead, which refuses a missing or
 * non-directory root — the same contract structured-ai's registry enforces.
 */
export function canonicalizeRoot(rootPath: string): string {
  const resolved = normalizeDriveLetter(path.resolve(String(rootPath ?? '')));
  try {
    return normalizeDriveLetter(fs.realpathSync(resolved));
  } catch {
    return resolved;
  }
}

/**
 * Strict root validation for registration: must be a non-empty string, must
 * exist, must be a directory. Mirrors
 * `structured-ai/agent/projects/ProjectRegistry.js:canonicalizeRoot` so both
 * registries canonicalize identically and therefore hash identically.
 */
export function assertProjectRoot(rootPath: string): string {
  if (typeof rootPath !== 'string' || rootPath.trim() === '') {
    throw new Error('Project rootPath is required and must be a non-empty string.');
  }

  const resolved = normalizeDriveLetter(path.resolve(rootPath));

  let stats: fs.Stats;
  try {
    stats = fs.statSync(resolved);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? (error as Error).message;
    throw new Error(`Project root does not exist: ${rootPath} (${code})`);
  }

  if (!stats.isDirectory()) {
    throw new Error(`Project root is not a directory: ${rootPath}`);
  }

  return normalizeDriveLetter(fs.realpathSync(resolved));
}

/** The generated id for a project name and its canonical root. */
export function projectIdFor(name: string, canonicalRoot: string): string {
  return `${PROJECT_ID_PREFIX}${slugify(name)}-${projectHash(canonicalRoot)}`;
}

export function isValidProjectId(id: unknown): boolean {
  if (typeof id !== 'string') return false;
  if (id.length > PROJECT_ID_MAX_LENGTH) return false;
  return PROJECT_ID_PATTERN.test(id);
}

/*
|── شناسه‌هایی که از بیرون می‌آیند ──────────────────────────────────────────
|
| الگوی `prj-…` برای شناسهٔ *تولیدشده* است. ولی شناسه‌های موجود در دنیا
| از قبل آزادترند: `serve` پروژهٔ ریشه را با `current` و `<basename>` ثبت
| می‌کند (`serve-command.ts:171-173`) و `HttpServer.test.ts:173` انتظار دارد
| `sample-app` همان id باقی بماند. پس دو اعتبارسنج دیگر لازم است:
|
|   - `isSafeProjectId`       — برای lookup/alias: بدون `/`، `\` و `..`
|   - `isPathSafeProjectId`   — برای وقتی شناسه *نام پوشه* می‌شود: همان
|                               قواعد، به‌علاوهٔ فقط حروف کوچک، چون روی
|                               macOS/Windows دو شناسهٔ هم‌نام با تفاوت
|                               بزرگی/کوچکی حروف به یک پوشه می‌خورند.
*/

/** شناسهٔ آزادِ داده‌شده از بیرون؛ فقط نویسه‌های بی‌خطر. */
export const SAFE_PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** همان، ولی lowercase — تنها شکل مجاز برای نام پوشه. */
export const PATH_SAFE_PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function isSafeProjectId(id: unknown): boolean {
  if (typeof id !== 'string' || id.length > PROJECT_ID_MAX_LENGTH) return false;
  if (id.includes('..')) return false;
  return SAFE_PROJECT_ID_PATTERN.test(id);
}

export function isPathSafeProjectId(id: unknown): boolean {
  if (typeof id !== 'string' || id.length > PROJECT_ID_MAX_LENGTH) return false;
  if (id.includes('..')) return false;
  return PATH_SAFE_PROJECT_ID_PATTERN.test(id);
}

/** مثل `assertProjectId`، برای شناسه‌ای که نام پوشه می‌شود. */
export function assertPathSafeProjectId(id: string): string {
  if (!isPathSafeProjectId(id)) {
    throw new Error(
      `Invalid project id: ${JSON.stringify(id)}. ` +
        `A project id used as a directory name must match ${PATH_SAFE_PROJECT_ID_PATTERN} ` +
        `(no path separators, no "..", lowercase only).`
    );
  }
  return id;
}

/** Throws unless `id` is safe to use as a directory name and route segment. */
export function assertProjectId(id: string): string {
  if (!isValidProjectId(id)) {
    throw new Error(
      `Invalid project id: ${JSON.stringify(id)}. ` +
        `Expected ${PROJECT_ID_PATTERN} (at most ${PROJECT_ID_MAX_LENGTH} characters).`
    );
  }
  return id;
}
