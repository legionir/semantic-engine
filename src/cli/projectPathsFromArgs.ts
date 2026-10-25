/**
 * One place where CLI flags become artifact paths — فاز ۳.
 *
 * `index`, `watch`, `serve`, `ui`, `start`, `query` and the standalone MCP
 * entry point all need the same answer to "where do this project's artifacts
 * live". Before this module each of them re-derived it, which is how a writer
 * and a reader end up looking at different directories.
 *
 * Precedence, unchanged from before for the in-root default:
 *
 * ```text
 * --out (explicit)  >  --data-dir / SEMANTIC_ENGINE_DATA_DIR  >  platform default
 * ```
 *
 * and the location itself comes from `--artifact-location` or
 * `SEMANTIC_ENGINE_ARTIFACT_LOCATION` (default `in-root` until فاز ۴ flips it).
 */

import * as path from 'path';
import { ParsedArgs, stringOption } from './args';
import {
  ArtifactLocation,
  artifactLocationOrDefault,
} from '../core/config/DataRootResolver';
import {
  IndexLookupOptions,
  ProjectPaths,
  resolveProjectPaths,
} from '../core/config/ProjectPaths';
import { canonicalizeRoot, isPathSafeProjectId, projectIdFor } from '../core/config/ProjectIdentity';

/**
 * `envVarNameFor('semanticEngine.artifactLocation')` — asserted by
 * `projectPathsFromArgs.test.ts` so the flag/env/schema trio cannot drift.
 */
export const ARTIFACT_LOCATION_ENV_VAR = 'SEMANTIC_ENGINE_ARTIFACT_LOCATION';

export function artifactLocationFromArgs(
  args: ParsedArgs,
  env: Readonly<Record<string, string | undefined>> = process.env
): ArtifactLocation {
  const flag = stringOption(args.options, 'artifactLocation');
  return artifactLocationOrDefault(flag ?? env[ARTIFACT_LOCATION_ENV_VAR]);
}

/**
 * شناسهٔ پروژه برای مسیر artifact.
 *
 * `--project-id` صریح مقدم است (Gateway در فازهای بعد همان را می‌دهد) و در
 * غیر این صورت از نام پوشه و ریشهٔ canonical ساخته می‌شود — قطعی، پس دو بار
 * اجرای CLI روی یک پروژه به یک پوشه می‌رسد.
 */
export function projectIdFromArgs(args: ParsedArgs, workspaceRoot: string): string {
  const requested = (stringOption(args.options, 'projectId') ?? '').trim();
  if (requested !== '' && isPathSafeProjectId(requested)) return requested;
  return projectIdFor(path.basename(workspaceRoot), canonicalizeRoot(workspaceRoot));
}

export function projectPathsFromArgs(
  args: ParsedArgs,
  workspaceRoot: string,
  env: Readonly<Record<string, string | undefined>> = process.env
): ProjectPaths {
  const out = stringOption(args.options, 'out');
  const dataDir = stringOption(args.options, 'dataDir');

  return resolveProjectPaths({
    projectId: projectIdFromArgs(args, workspaceRoot),
    workspaceRoot,
    location: artifactLocationFromArgs(args, env),
    ...(out !== undefined ? { outOverride: out } : {}),
    ...(dataDir !== undefined ? { dataRoot: dataDir } : {}),
    env,
  });
}

/** همان انتخاب، به شکلی که `resolveProjectIndexPath` برای خواندن می‌خواهد. */
export function indexLookupFromArgs(
  args: ParsedArgs,
  workspaceRoot: string,
  env: Readonly<Record<string, string | undefined>> = process.env
): IndexLookupOptions {
  const dataDir = stringOption(args.options, 'dataDir');
  return {
    location: artifactLocationFromArgs(args, env),
    projectId: projectIdFromArgs(args, workspaceRoot),
    ...(dataDir !== undefined ? { dataRoot: dataDir } : {}),
    env,
  };
}
