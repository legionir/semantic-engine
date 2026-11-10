/**
 * Project registry — MULTI_PROJECT_GATEWAY_EXECUTION_PLAN فاز ۲ (D3/D4).
 *
 * The registry is the authority on *which projects exist* and on the identity
 * of each one. Two properties matter more than anything else here:
 *
 *   1. **The canonical root is the unique key.** Registering a root that is
 *      already registered returns the existing record instead of creating a
 *      second one — the reference plan calls this out explicitly, and the bug
 *      it replaces was real: `ProjectService` keyed projects by an id derived
 *      from `basename`, so `/tmp/client-a/app` and `/tmp/client-b/app` both
 *      became `prj-app` and the second registration silently replaced the
 *      first.
 *   2. **The id is computed once and persisted.** Renaming a project changes
 *      the display name only; moving it is an explicit `relocate`.
 *
 * Storage: a single JSON document at `<dataRoot>/registry.json`, written
 * atomically (temp file + rename) so a crash mid-write cannot leave a
 * half-written registry, and read defensively so a corrupt file is quarantined
 * instead of taking the server down.
 *
 * Per-project metadata lives beside it, at
 * `<dataRoot>/projects/<projectId>/manifest.json`. That is registry state, so
 * it stays in the data directory even while `artifactLocation` is still
 * `in-root` — registering a project must never write into the source tree.
 */

import * as fs from 'fs';
import * as path from 'path';
import { PROJECTS_DIR_NAME, resolveProjectPaths } from './ProjectPaths';
import {
  assertProjectRoot,
  canonicalizeRoot,
  isPathSafeProjectId,
  isSafeProjectId,
  projectIdFor,
} from './ProjectIdentity';
import { DataRootOptions, ensureDataRoot, resolveDataRoot } from './DataRootResolver';
import { atomicWriteJsonSync, withFileLockSync } from '../utils/atomicFile';

export const REGISTRY_FILE = 'registry.json';
export const REGISTRY_VERSION = 1;
export const PROJECT_MANIFEST_FILE = 'manifest.json';
export const MANIFEST_SCHEMA_VERSION = 1;

export interface ProjectRecord {
  readonly id: string;
  readonly name: string;
  /** ریشهٔ canonical (نتیجهٔ `realpath`) — کلید یکتایی. */
  readonly rootPath: string;
  /** شناسه‌های دیگری که همین پروژه با آن‌ها ثبت شده و باید resolve شوند. */
  readonly aliases: readonly string[];
  readonly enabled: boolean;
  readonly autoStart: boolean;
  readonly createdAt: string;
  readonly lastSeenAt: string;
}

export interface RegisterProjectInput {
  readonly rootPath: string;
  readonly name?: string;
  /** شناسهٔ دلخواه (مثلاً از structured-ai یا از UI). */
  readonly id?: string;
  readonly enabled?: boolean;
  readonly autoStart?: boolean;
}

export interface ProjectRegistryOptions extends DataRootOptions {
  /**
   * data root صریح. هم‌معنی `dataDir` در `DataRootOptions` است و فقط نامش
   * اینجا روشن‌تر است؛ اگر هر دو داده شوند `dataRoot` مقدم است.
   */
  readonly dataRoot?: string;
  /** مسیر صریح فایل registry؛ بیشتر برای تست. */
  readonly registryPath?: string;
  /** ساعت تزریق‌پذیر تا تست‌ها زمان قطعی داشته باشند. */
  readonly now?: () => Date;
}

interface RegistryFile {
  version: number;
  projects: ProjectRecord[];
}

function isRecord(value: unknown): value is ProjectRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['id'] === 'string' &&
    typeof candidate['name'] === 'string' &&
    typeof candidate['rootPath'] === 'string' &&
    typeof candidate['createdAt'] === 'string' &&
    typeof candidate['lastSeenAt'] === 'string'
  );
}

function normalizeRecord(value: unknown): ProjectRecord | null {
  if (!isRecord(value)) return null;
  const candidate = value as unknown as Record<string, unknown>;
  const aliases = Array.isArray(candidate['aliases'])
    ? (candidate['aliases'] as unknown[]).filter((a): a is string => typeof a === 'string')
    : [];
  return {
    id: candidate['id'] as string,
    name: candidate['name'] as string,
    rootPath: candidate['rootPath'] as string,
    aliases,
    enabled: candidate['enabled'] === undefined ? true : Boolean(candidate['enabled']),
    autoStart: candidate['autoStart'] === undefined ? false : Boolean(candidate['autoStart']),
    createdAt: candidate['createdAt'] as string,
    lastSeenAt: candidate['lastSeenAt'] as string,
  };
}

export class ProjectRegistry {
  private readonly registryPathValue: string;
  private readonly dataRootValue: string;
  private readonly now: () => Date;
  private readonly dataOptions: DataRootOptions;
  private cache: ProjectRecord[] | null = null;
  /** size:mtime of the registry file the cache was read from; a different stamp means another process wrote. */
  private cacheStamp: string | null = null;
  private lockDepth = 0;

  constructor(options: ProjectRegistryOptions = {}) {
    const dataDir = options.dataRoot ?? options.dataDir;
    this.dataOptions = {
      ...(dataDir !== undefined ? { dataDir } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
      ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    };
    this.dataRootValue = options.registryPath
      ? path.dirname(path.dirname(options.registryPath))
      : resolveDataRoot(this.dataOptions);
    this.registryPathValue = options.registryPath
      ?? path.join(resolveDataRoot(this.dataOptions), REGISTRY_FILE);
    this.now = options.now ?? (() => new Date());
  }

  get registryPath(): string {
    return this.registryPathValue;
  }

  get dataRoot(): string {
    return this.dataRootValue;
  }

  /** پوشهٔ دادهٔ یک پروژه در data root (نه داخل source). */
  projectDataDir(projectId: string): string {
    return path.join(this.dataRootValue, PROJECTS_DIR_NAME, projectId);
  }

  manifestPathFor(projectId: string): string {
    return path.join(this.projectDataDir(projectId), PROJECT_MANIFEST_FILE);
  }

  list(): ProjectRecord[] {
    return [...this.load()];
  }

  /** با شناسهٔ اصلی یا هر alias. */
  get(id: string): ProjectRecord | undefined {
    return this.load().find(record => record.id === id || record.aliases.includes(id));
  }

  getByRoot(rootPath: string): ProjectRecord | undefined {
    const canonical = canonicalizeRoot(rootPath);
    return this.load().find(record => record.rootPath === canonical);
  }

  /**
   * ثبت یا بازگرداندن یک پروژه.
   *
   * ریشهٔ تکراری پروژهٔ جدید نمی‌سازد؛ فقط `lastSeenAt` را به‌روز می‌کند و
   * اگر نام تازه‌ای داده شده باشد نام را عوض می‌کند — بدون تغییر id.
   */
  register(input: RegisterProjectInput): ProjectRecord {
    return this.locked(() => {
      const canonicalRoot = assertProjectRoot(input.rootPath);
      const records = this.load();
      const timestamp = this.now().toISOString();

      const existing = records.find(record => record.rootPath === canonicalRoot);
      if (existing) {
        const aliases = new Set(existing.aliases);
        const requestedId = (input.id ?? '').trim();
        if (requestedId !== '' && requestedId !== existing.id && isSafeProjectId(requestedId)) {
          aliases.add(requestedId);
        }

        const updated: ProjectRecord = {
          ...existing,
          name: (input.name ?? '').trim() !== '' ? (input.name as string) : existing.name,
          aliases: [...aliases],
          lastSeenAt: timestamp,
        };

        this.replace(updated);
        return updated;
      }

      const name = (input.name ?? '').trim() !== ''
        ? (input.name as string)
        : path.basename(canonicalRoot);

      const id = this.chooseId(input.id, name, canonicalRoot, records);
      const record: ProjectRecord = {
        id,
        name,
        rootPath: canonicalRoot,
        aliases: this.aliasesFor(input.id, id),
        enabled: input.enabled ?? true,
        autoStart: input.autoStart ?? false,
        createdAt: timestamp,
        lastSeenAt: timestamp,
      };

      records.push(record);
      this.save(records);
      this.writeManifest(record);
      return record;
    });
  }

  /** تغییر نام، بدون تغییر id. */
  rename(id: string, name: string): ProjectRecord {
    return this.locked(() => {
      const record = this.get(id);
      if (!record) throw new Error(`Unknown project id: ${id}`);
      const trimmed = name.trim();
      if (trimmed === '') throw new Error('Project name must not be empty.');

      const updated: ProjectRecord = {
        ...record,
        name: trimmed,
        lastSeenAt: this.now().toISOString(),
      };
      this.replace(updated);
      return updated;
    });
  }

  /**
   * به‌روزرسانی فیلدهای قابل‌تغییر یک پروژه (name / enabled / autoStart)
   * با یک نوشتن atomic. `id` و `rootPath` هرگز از اینجا عوض نمی‌شوند.
   */
  update(
    id: string,
    patch: { name?: string; enabled?: boolean; autoStart?: boolean }
  ): ProjectRecord {
    return this.locked(() => {
      const record = this.get(id);
      if (!record) throw new Error(`Unknown project id: ${id}`);

      let name = record.name;
      if (patch.name !== undefined) {
        name = patch.name.trim();
        if (name === '') throw new Error('Project name must not be empty.');
      }

      const updated: ProjectRecord = {
        ...record,
        name,
        enabled: patch.enabled ?? record.enabled,
        autoStart: patch.autoStart ?? record.autoStart,
        lastSeenAt: this.now().toISOString(),
      };
      this.replace(updated);
      return updated;
    });
  }

  /**
   * جابه‌جایی کنترل‌شدهٔ ریشه. id حفظ می‌شود؛ فقط canonicalRoot عوض می‌شود
   * و اگر ریشهٔ مقصد از قبل ثبت شده باشد خطا می‌دهد تا دو رکورد یکی نشوند.
   */
  relocate(id: string, newRootPath: string): ProjectRecord {
    return this.locked(() => {
      const record = this.get(id);
      if (!record) throw new Error(`Unknown project id: ${id}`);

      const canonical = assertProjectRoot(newRootPath);
      const clash = this.load().find(other => other.rootPath === canonical && other.id !== record.id);
      if (clash) {
        throw new Error(
          `Cannot relocate ${id}: ${canonical} is already registered as ${clash.id}.`
        );
      }

      const updated: ProjectRecord = {
        ...record,
        rootPath: canonical,
        lastSeenAt: this.now().toISOString(),
      };
      this.replace(updated);
      return updated;
    });
  }

  remove(id: string): boolean {
    return this.locked(() => {
      const record = this.get(id);
      if (!record) return false;
      this.save(this.load().filter(item => item.id !== record.id));
      return true;
    });
  }

  touch(id: string): ProjectRecord | undefined {
    return this.locked(() => {
      const record = this.get(id);
      if (!record) return undefined;
      const updated: ProjectRecord = { ...record, lastSeenAt: this.now().toISOString() };
      this.replace(updated);
      return updated;
    });
  }

  /** manifest پروژه در data root؛ هیچ‌گاه داخل source root. */
  writeManifest(record: ProjectRecord): string {
    /*
    | `resolveProjectPaths` اینجا دو کار می‌کند: شناسه را پیش از ساخت پوشه
    | اعتبارسنجی می‌کند و مسیر را از همان قراردادی می‌سازد که بقیهٔ سیستم
    | استفاده می‌کنند، نه از یک `path.join` دستی.
    */
    const paths = resolveProjectPaths({
      projectId: record.id,
      workspaceRoot: record.rootPath,
      dataRoot: this.dataRootValue,
      location: 'external',
    });
    fs.mkdirSync(paths.artifactRoot, { recursive: true, mode: 0o700 });

    const manifestPath = path.join(paths.artifactRoot, PROJECT_MANIFEST_FILE);
    const payload = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      projectId: record.id,
      name: record.name,
      rootPath: record.rootPath,
      aliases: [...record.aliases],
      enabled: record.enabled,
      autoStart: record.autoStart,
      createdAt: record.createdAt,
      lastSeenAt: record.lastSeenAt,
      registeredBy: 'semantic-engine',
    };

    writeJsonAtomic(manifestPath, payload);
    return manifestPath;
  }

  private chooseId(
    requested: string | undefined,
    name: string,
    canonicalRoot: string,
    records: readonly ProjectRecord[]
  ): string {
    const trimmed = (requested ?? '').trim();

    if (trimmed !== '') {
      /*
      | یک id خارجی فقط وقتی می‌تواند شناسهٔ اصلی باشد که به‌عنوان نام پوشه
      | هم قانونی باشد؛ در غیر این صورت به alias تبدیل می‌شود و شناسهٔ اصلی
      | تولید می‌گردد.
      */
      if (isPathSafeProjectId(trimmed)) {
        const clash = records.find(record => record.id === trimmed);
        if (clash) {
          throw new Error(
            `Project id ${trimmed} is already registered for ${clash.rootPath}; ` +
              `refusing to bind it to ${canonicalRoot}.`
          );
        }
        return trimmed;
      }
    }

    const generated = projectIdFor(name, canonicalRoot);
    const clash = records.find(record => record.id === generated);
    if (clash) {
      throw new Error(
        `Generated project id ${generated} is already registered for ${clash.rootPath}; ` +
        `pass an explicit id for ${canonicalRoot}.`
      );
    }
    return generated;
  }

  private aliasesFor(requested: string | undefined, id: string): string[] {
    const trimmed = (requested ?? '').trim();
    if (trimmed === '' || trimmed === id || !isSafeProjectId(trimmed)) return [];
    return [trimmed];
  }

  private replace(updated: ProjectRecord): void {
    const records = this.load().map(record => (record.id === updated.id ? updated : record));
    this.save(records);
    this.writeManifest(updated);
  }

  /**
   * Run a read-modify-write while holding the cross-process registry lock.
   * The cache is dropped first, so the change is applied to what is on disk
   * now — not to what this process read minutes ago.
   */
  private locked<T>(run: () => T): T {
    if (this.lockDepth > 0) return run();
    this.lockDepth += 1;
    try {
      return withFileLockSync(
        `${this.registryPathValue}.lock`,
        () => {
          this.cache = null;
          this.cacheStamp = null;
          return run();
        },
        { staleMs: 15_000, waitMs: 8_000 }
      );
    } finally {
      this.lockDepth -= 1;
    }
  }

  private stampOfRegistryFile(): string | null {
    try {
      const stat = fs.statSync(this.registryPathValue);
      return `${stat.size}:${stat.mtimeMs}`;
    } catch {
      return null;
    }
  }

  private load(): ProjectRecord[] {
    const stamp = this.stampOfRegistryFile();
    if (this.cache && this.cacheStamp === stamp) return this.cache;

    let raw: string;
    try {
      raw = fs.readFileSync(this.registryPathValue, 'utf8');
    } catch {
      /* no registry file yet: start from the manifests that exist, if any */
      this.cache = this.rebuildFromManifests();
      this.cacheStamp = stamp;
      return this.cache;
    }

    try {
      const parsed = JSON.parse(raw) as RegistryFile;
      const projects = Array.isArray(parsed?.projects)
        ? parsed.projects.map(normalizeRecord).filter((r): r is ProjectRecord => r !== null)
        : null;

      if (projects === null) throw new Error('registry.projects is not an array');
      this.cache = projects;
      this.cacheStamp = stamp;
      return this.cache;
    } catch {
      /*
      | فایل نیمه‌نویس یا خراب نباید سرویس را بخواباند. قرنطینه‌اش می‌کنیم تا
      | قابل بررسی بماند. فهرست از manifest هر پروژه (که کنار دادهٔ خودش
      | نوشته شده) بازسازی می‌شود، پس پروژه‌های ثبت‌شده گم نمی‌شوند.
      */
      try {
        const quarantined = `${this.registryPathValue}.corrupt-${Date.now()}`;
        fs.renameSync(this.registryPathValue, quarantined);
      } catch {
        /* اگر قرنطینه ممکن نبود، همان فایل خراب سر جایش می‌ماند. */
      }
      this.cache = this.rebuildFromManifests();
      this.cacheStamp = this.stampOfRegistryFile();
      return this.cache;
    }
  }

  /**
   * Rebuild the project list from `<dataRoot>/projects/<id>/manifest.json`.
   * Only manifests whose root still exists and whose id matches the folder are
   * taken; anything else is ignored rather than guessed.
   */
  private rebuildFromManifests(): ProjectRecord[] {
    const projectsDir = path.join(this.dataRootValue, PROJECTS_DIR_NAME);
    let names: string[];
    try {
      names = fs.readdirSync(projectsDir);
    } catch {
      return [];
    }

    const records: ProjectRecord[] = [];
    const seenRoots = new Set<string>();
    for (const name of names.sort()) {
      try {
        const manifest = JSON.parse(
          fs.readFileSync(path.join(projectsDir, name, PROJECT_MANIFEST_FILE), 'utf8')
        ) as Record<string, unknown>;
        const root = manifest['rootPath'];
        if (manifest['projectId'] !== name || typeof root !== 'string' || !fs.existsSync(root)) continue;
        if (seenRoots.has(root)) continue;

        const record = normalizeRecord({
          id: name,
          name: manifest['name'],
          rootPath: root,
          aliases: manifest['aliases'],
          enabled: manifest['enabled'],
          autoStart: manifest['autoStart'],
          createdAt: manifest['createdAt'],
          lastSeenAt: manifest['lastSeenAt'],
        });
        if (record) {
          records.push(record);
          seenRoots.add(root);
        }
      } catch {
        /* a project folder without a readable manifest is not a registration */
      }
    }
    return records;
  }

  private save(records: readonly ProjectRecord[]): void {
    const dir = path.dirname(this.registryPathValue);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeJsonAtomic(this.registryPathValue, {
      version: REGISTRY_VERSION,
      projects: [...records],
    } satisfies RegistryFile);
    this.cache = [...records];
    this.cacheStamp = this.stampOfRegistryFile();
  }
}

/** نوشتن tmp + fsync + rename، تا خواننده هرگز فایل نیمه‌نویس نبیند. */
function writeJsonAtomic(target: string, payload: unknown): void {
  atomicWriteJsonSync(target, payload, { mode: 0o600, dirMode: 0o700 });
}

/** برای تست و برای doctor: data root مؤثر بدون ساختن چیزی. */
export function defaultRegistryPath(options: DataRootOptions = {}): string {
  return path.join(resolveDataRoot(options), REGISTRY_FILE);
}

/** data root را می‌سازد و مسیر registry را برمی‌گرداند. */
export function ensureRegistryPath(options: DataRootOptions = {}): string {
  return path.join(ensureDataRoot(options), REGISTRY_FILE);
}
