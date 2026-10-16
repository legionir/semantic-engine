/**
 * `semantic-engine cache` — فاز ۱۳.
 *
 * Generated data now lives outside the checkout, so it needs its own
 * housekeeping: what is there, how big it is, and how to remove, export or
 * import it.
 *
 * ── The one rule this command must never break ───────────────────────────
 *
 * It deletes generated data and nothing else. Every destructive path is
 * resolved and then checked twice: it must be strictly inside
 * `<dataRoot>/projects/`, and it must not be (or contain) any workspace root
 * registered in `registry.json`. `clean --older-than` is a dry run unless
 * `--force` is passed, because "older than 30 days" is exactly the kind of
 * filter that surprises someone.
 */

import * as fs from 'fs';
import * as path from 'path';
import { EXIT, ParsedArgs, boolOption, stringOption } from '../args';
import { CommandContext, CommandResult } from './types';
import { resolveDataRoot } from '../../core/config/DataRootResolver';
import { PROJECTS_DIR_NAME } from '../../core/config/ProjectPaths';
import { REGISTRY_FILE } from '../../core/config/ProjectRegistry';

interface CacheEntry {
  readonly projectId: string;
  readonly path: string;
  readonly bytes: number;
  readonly files: number;
  readonly indexBytes: number;
  readonly modifiedAt?: string;
  readonly name?: string;
  readonly rootPath?: string;
}

interface RegistryProject {
  readonly id?: string;
  readonly rootPath?: string;
}

function readRegistryProjects(dataRoot: string): RegistryProject[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataRoot, REGISTRY_FILE), 'utf8')) as {
      projects?: RegistryProject[];
    };
    return Array.isArray(parsed.projects) ? parsed.projects : [];
  } catch {
    return [];
  }
}

function directorySize(dir: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;

  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      try {
        bytes += fs.statSync(full).size;
        files += 1;
      } catch {
        /* فایلی که بین readdir و stat پاک شده، شمرده نمی‌شود. */
      }
    }
  };

  walk(dir);
  return { bytes, files };
}

function listEntries(dataRoot: string): CacheEntry[] {
  const projectsDir = path.join(dataRoot, PROJECTS_DIR_NAME);
  let names: string[];
  try {
    names = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  } catch {
    return [];
  }

  return names.map(name => {
    const dir = path.join(projectsDir, name);
    const { bytes, files } = directorySize(dir);
    const indexPath = path.join(dir, 'project-index.json');

    let indexBytes = 0;
    let modifiedAt: string | undefined;
    try {
      const stats = fs.statSync(indexPath);
      indexBytes = stats.size;
      modifiedAt = stats.mtime.toISOString();
    } catch {
      /* ایندکس ندارد؛ فقط اندازهٔ پوشه گزارش می‌شود. */
    }

    let projectName: string | undefined;
    let rootPath: string | undefined;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as {
        name?: string;
        rootPath?: string;
      };
      projectName = manifest.name;
      rootPath = manifest.rootPath;
    } catch {
      /* manifest اختیاری است. */
    }

    return {
      projectId: name,
      path: dir,
      bytes,
      files,
      indexBytes,
      ...(modifiedAt !== undefined ? { modifiedAt } : {}),
      ...(projectName !== undefined ? { name: projectName } : {}),
      ...(rootPath !== undefined ? { rootPath } : {}),
    };
  });
}

function parseDuration(input: string): number | null {
  const match = /^(\d+)\s*([smhd])$/.exec(input.trim());
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2];
  const factor = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return value * factor;
}

function copyTree(source: string, target: string): number {
  fs.mkdirSync(target, { recursive: true });
  let copied = 0;

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copied += copyTree(from, to);
      continue;
    }
    fs.copyFileSync(from, to);
    copied += 1;
  }

  return copied;
}

/**
 * گارد اصلی: مسیر مقصد باید داخل `<dataRoot>/projects/` باشد و هیچ workspace
 * ثبت‌شده‌ای را در بر نگیرد.
 */
function assertSafeTarget(
  target: string,
  dataRoot: string,
  registered: RegistryProject[]
): string | null {
  const projectsRoot = path.resolve(dataRoot, PROJECTS_DIR_NAME);
  const resolved = path.resolve(target);

  if (resolved !== projectsRoot && !resolved.startsWith(projectsRoot + path.sep)) {
    return `refusing to touch ${resolved}: it is not inside ${projectsRoot}`;
  }

  for (const project of registered) {
    if (typeof project.rootPath !== 'string' || project.rootPath === '') continue;
    let workspace: string;
    try {
      workspace = fs.realpathSync(project.rootPath);
    } catch {
      workspace = path.resolve(project.rootPath);
    }
    if (resolved === workspace || resolved.startsWith(workspace + path.sep) ||
        workspace === resolved || workspace.startsWith(resolved + path.sep)) {
      return `refusing to touch ${resolved}: it overlaps the registered workspace ${workspace}`;
    }
  }

  return null;
}

export async function runCache(
  args: ParsedArgs,
  context: CommandContext
): Promise<CommandResult> {
  const subcommand = args.positional[0];
  const dataRoot = resolveDataRoot({
    ...(stringOption(args.options, 'dataDir') !== undefined
      ? { dataDir: stringOption(args.options, 'dataDir') }
      : {}),
  });
  const registered = readRegistryProjects(dataRoot);

  if (subcommand === 'list' || subcommand === undefined) {
    const entries = listEntries(dataRoot);
    const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);

    return {
      code: EXIT.ok,
      json: { ok: true, dataRoot, totalBytes, projects: entries },
      text:
        entries.length === 0
          ? `no cached projects under ${dataRoot}`
          : entries
              .map(
                entry =>
                  `${entry.projectId.padEnd(28)} ${(entry.bytes / 1024).toFixed(1).padStart(10)} KB` +
                  `  index ${(entry.indexBytes / 1024).toFixed(1).padStart(9)} KB` +
                  `  ${entry.modifiedAt ?? 'no index'}`
              )
              .join('\n') +
            `\n\ntotal: ${(totalBytes / 1024 / 1024).toFixed(2)} MB in ${entries.length} project(s) under ${dataRoot}`,
    };
  }

  if (subcommand === 'clean') {
    const projectId = stringOption(args.options, 'project');
    const olderThan = stringOption(args.options, 'olderThan');
    const force = boolOption(args.options, 'force', false);

    if (!projectId && !olderThan) {
      return {
        code: EXIT.usage,
        error: 'cache clean needs --project <id> or --older-than <n[s|m|h|d]>',
      };
    }

    const selected = listEntries(dataRoot).filter(entry => {
      if (projectId) return entry.projectId === projectId;
      const window = parseDuration(olderThan as string);
      if (window === null) return false;
      if (!entry.modifiedAt) return false;
      return Date.now() - Date.parse(entry.modifiedAt) > window;
    });

    if (olderThan && !force) {
      return {
        code: EXIT.ok,
        json: {
          ok: true,
          dryRun: true,
          dataRoot,
          wouldRemove: selected.map(entry => entry.projectId),
          bytes: selected.reduce((sum, entry) => sum + entry.bytes, 0),
        },
        text:
          `dry run: ${selected.length} project(s) older than ${olderThan} would be removed ` +
          `(${selected.map(entry => entry.projectId).join(', ') || 'none'}). ` +
          `Pass --force to delete.`,
      };
    }

    const removed: string[] = [];
    const refused: string[] = [];

    for (const entry of selected) {
      const problem = assertSafeTarget(entry.path, dataRoot, registered);
      if (problem) {
        refused.push(problem);
        continue;
      }
      fs.rmSync(entry.path, { recursive: true, force: true });
      removed.push(entry.projectId);
    }

    return {
      code: EXIT.ok,
      json: { ok: true, dataRoot, removed, refused },
      text:
        `removed: ${removed.join(', ') || 'nothing'}` +
        (refused.length > 0 ? `\nrefused:\n  ${refused.join('\n  ')}` : ''),
    };
  }

  if (subcommand === 'export') {
    const projectId = stringOption(args.options, 'project');
    const to = stringOption(args.options, 'to');
    if (!projectId || !to) {
      return { code: EXIT.usage, error: 'cache export needs --project <id> and --to <dir>' };
    }

    const source = path.join(dataRoot, PROJECTS_DIR_NAME, projectId);
    if (!fs.existsSync(source)) {
      return { code: EXIT.failure, error: `no cached artifacts for ${projectId} under ${dataRoot}` };
    }

    const target = path.resolve(to, projectId);
    const copied = copyTree(source, target);
    context.logger.info('cache exported', { projectId, target, files: copied });

    return {
      code: EXIT.ok,
      json: { ok: true, projectId, from: source, to: target, files: copied },
      text: `exported ${copied} file(s) for ${projectId} to ${target}`,
    };
  }

  if (subcommand === 'import') {
    const projectId = stringOption(args.options, 'project');
    const from = stringOption(args.options, 'from');
    if (!projectId || !from) {
      return { code: EXIT.usage, error: 'cache import needs --project <id> and --from <dir>' };
    }

    const resolvedFrom = path.resolve(from);
    const target = path.join(dataRoot, PROJECTS_DIR_NAME, projectId);
    const problem = assertSafeTarget(target, dataRoot, registered);
    if (problem) {
      return { code: EXIT.failure, error: problem };
    }
    if (!fs.existsSync(resolvedFrom)) {
      return { code: EXIT.failure, error: `source directory not found: ${resolvedFrom}` };
    }

    const copied = copyTree(resolvedFrom, target);
    context.logger.info('cache imported', { projectId, target, files: copied });

    return {
      code: EXIT.ok,
      json: { ok: true, projectId, from: resolvedFrom, to: target, files: copied },
      text: `imported ${copied} file(s) into ${projectId} at ${target}`,
    };
  }

  return {
    code: EXIT.usage,
    error: `unknown cache subcommand: ${subcommand}\navailable: list, clean, export, import`,
  };
}
