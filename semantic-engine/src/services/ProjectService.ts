/**
 * ProjectService — Platform Core V1 & V2 Project Registry & Cache Manager.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ProjectIndex } from '../core/types/project-index.types';
import { ProjectIndexReader } from '../ai/ProjectIndexReader';
import { AiToolRegistry } from '../ai/AiToolRegistry';
import { loadBlueprintBeside } from '../ai/discovery/loadBlueprint';
import { BlueprintIndex } from '../ai/discovery/BlueprintIndex';
import { AnalysisGraph } from './analysis/AnalysisGraph';
import {
  canonicalIndexPath,
  normalizeWorkspaceRoot,
  resolveProjectIndexPath,
  resolveProjectPaths,
} from '../core/config/ProjectPaths';
import { buildProjectGraph, mergeAliases } from './projectGraph';
import { ArtifactLocation, DEFAULT_ARTIFACT_LOCATION } from '../core/config/DataRootResolver';
import { migrateLegacyArtifacts } from '../core/config/migrateLegacyArtifacts';
import type { ProjectRecord, ProjectRegistry } from '../core/config/ProjectRegistry';
import { canonicalizeRoot, isPathSafeProjectId, isSafeProjectId, projectIdFor } from '../core/config/ProjectIdentity';
import {
  MANIFEST_FILE_NAME,
  assertIndexMatchesCommittedManifest,
} from '../core/config/artifactManifest';

const MAX_INDEX_BYTES = 256 * 1024 * 1024;


export interface ManagedProject {
  readonly id: string;
  readonly name: string;
  readonly rootPath: string;
  /**
   * شناسه‌های دیگری که همین پروژه با آن‌ها ثبت شده (`current`، `<basename>`،
   * `prj-<basename>`). همه در `getProject` resolve می‌شوند ولی پروژه در
   * `listProjects` فقط یک بار ظاهر می‌شود.
   */
  readonly aliases: readonly string[];
  readonly indexPath: string;
  readonly blueprintPath?: string;
  readonly status: 'ready' | 'indexing' | 'stale' | 'missing';
  readonly index?: ProjectIndex;
  readonly blueprint?: BlueprintIndex;
  readonly reader?: ProjectIndexReader;
  readonly registry?: AiToolRegistry;
  readonly stats: {
    readonly filesCount: number;
    readonly symbolsCount: number;
    readonly dependenciesCount: number;
    readonly lastIndexedAt?: string;
  };
}

export class ProjectService {
  /*
  | کلید این map ریشهٔ نرمال‌شده است، نه شناسه. دلیلش یک باگ واقعی بود:
  | شناسه از `basename` ساخته می‌شد، پس `/tmp/client-a/app` و
  | `/tmp/client-b/app` هر دو `prj-app` می‌شدند و `projects.set(id, …)`
  | دومی را جای اولی می‌گذاشت — یعنی یک پروژه بی‌صدا ناپدید می‌شد.
  | `byId` همهٔ شناسه‌ها و aliasها را به همان رکورد نگاشت می‌کند.
  */
  private readonly projects = new Map<string, ManagedProject>();
  private readonly byId = new Map<string, ManagedProject>();
  private readonly artifactWatchers = new Map<string, fs.FSWatcher>();
  private readonly reloadTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly defaultRoot: string = process.cwd(),
    private readonly options: ProjectServiceOptions = {}
  ) {}

  /**
   * ثبت یا باز کردن یک پروژه بر اساس مسیر.
   */
  registerProject(projectPath: string, customId?: string, customName?: string): ManagedProject {
    const rootPath = normalizeWorkspaceRoot(projectPath);
    const requestedId = (customId ?? '').trim();
    const name = customName || path.basename(rootPath);

    /*
    | شناسهٔ پایدار: اول رکورد registry (اگر registry داشته باشیم)، وگرنه
    | شناسهٔ ثبت‌شدهٔ قبلیِ همین ریشه، و در نهایت یک شناسهٔ تولیدشده از
    | `projectIdFor(name, canonicalRoot)` — که برخلاف `basename` برای دو
    | پروژهٔ هم‌نام یکی نمی‌شود.
    */
    const previous = this.projects.get(rootPath);
    const record = this.registerInRegistry(rootPath, name, requestedId);
    const id = record?.id ?? previous?.id ?? this.deriveId(rootPath, name, requestedId);
    const aliases = mergeAliases(previous, record, id, requestedId);

    /*
    | مقصد نوشتن و مسیر خواندن جدا از هم تصمیم گرفته می‌شوند:
    |
    |   - `canonicalPath` جایی است که ایندکس بعدی نوشته می‌شود (در حالت
    |     `external` زیر data root)؛
    |   - `actualIndexPath` اولین ایندکس موجود است، شامل fallbackهای legacy،
    |     تا ایندکس قدیمی خواندنی بماند بدون آنکه مقصد شود.
    |
    | شناسهٔ artifact از ریشه ساخته می‌شود، نه از id نمایشی سرویس (که می‌تواند
    | alias باشد) — پس دو alias از یک پروژه به یک پوشه می‌رسند.
    */
    const location: ArtifactLocation =
      this.options.artifactLocation ?? DEFAULT_ARTIFACT_LOCATION;
    /*
    | شناسهٔ artifact از ریشه می‌آید — همان قاعدهٔ CLI (`projectIdFromArgs`) که
    | ایندکس را می‌نویسد — مگر اینکه برای ریشهٔ اصلیِ سرور صراحتاً داده شده
    | باشد (`--project-id`، worker پشت Gateway). قبلاً `record.id` (مثلاً
    | `jev-shell-agent` یا `current`) استفاده می‌شد، پس UI از پوشهٔ دیگری
    | می‌خواند و پروژه‌ای که `index`/`start` ساخته بود «not indexed» می‌ماند.
    | `basename` و نه `name`: نام نمایشی نباید مسیر دیسک را عوض کند.
    */
    const pinnedId = this.options.artifactProjectId;
    const artifactProjectId =
      pinnedId !== undefined &&
      isPathSafeProjectId(pinnedId) &&
      rootPath === normalizeWorkspaceRoot(this.defaultRoot)
        ? pinnedId
        : projectIdFor(path.basename(rootPath), canonicalizeRoot(rootPath));
    const lookup = {
      location,
      projectId: artifactProjectId,
      ...(this.options.dataRoot !== undefined ? { dataRoot: this.options.dataRoot } : {}),
    };

    if (location === 'external') {
      migrateLegacyArtifacts({
        workspaceRoot: rootPath,
        projectId: artifactProjectId,
        location,
        ...(this.options.dataRoot !== undefined ? { dataRoot: this.options.dataRoot } : {}),
      });
    }

    const canonicalPath =
      location === 'external'
        ? resolveProjectPaths({
            projectId: artifactProjectId,
            workspaceRoot: rootPath,
            location: 'external',
            ...(this.options.dataRoot !== undefined ? { dataRoot: this.options.dataRoot } : {}),
          }).indexPath
        : canonicalIndexPath(rootPath);
    const actualIndexPath = resolveProjectIndexPath(rootPath, undefined, lookup);

    /*
    | SE-PERF-01، یک محدودیتِ شناخته‌شده و نه رفع‌شده.
    |
    | خواندن و parse کردن ایندکس همگام است. اندازه‌گیری روی ۲۷MB:
    | خواندن ۵۰ms، `JSON.parse` ۱۰۰ms. این تابع بعد از هر job ایندکس
    | صدا زده می‌شود، پس ۱۵۰ms قفل event loop آنجا هست.
    |
    | ناهمگام کردنِ خواندن امتحان شد و کنار گذاشته شد: دو سومِ هزینه
    | خودِ `JSON.parse` است که همگام می‌ماند، و پیش‌گرم کردن یعنی
    | فایل دو بار خوانده شود. سودِ ۵۰ms ارزش آن پیچیدگی را ندارد.
    | رفع واقعی یک parser جریانی است، که کار همین‌جا نیست.
    */

    let index: ProjectIndex | undefined;
    let reader: ProjectIndexReader | undefined;
    let blueprint: BlueprintIndex | undefined;
    let registry: AiToolRegistry | undefined;
    let status: ManagedProject['status'] = 'missing';

    let filesCount = 0;
    let symbolsCount = 0;
    let dependenciesCount = 0;
    let lastIndexedAt: string | undefined;

    if (fs.existsSync(actualIndexPath)) {
      try {
        const indexSize = fs.statSync(actualIndexPath).size;
        if (indexSize > MAX_INDEX_BYTES) {
          throw new Error(
            `Project index is ${indexSize} bytes; the ${MAX_INDEX_BYTES}-byte safety limit prevents an event-loop memory spike.`
          );
        }

        const manifestPath = path.join(path.dirname(actualIndexPath), MANIFEST_FILE_NAME);
        const manifest = fs.existsSync(manifestPath)
          ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
              artifacts?: { index?: { sha256?: string }; blueprint?: { path?: string; sha256?: string } | null };
            }
          : null;

        /*
        | fail-closed روی جفتِ artifact: اگر manifest دیجست متفاوتی پین
        | کرده باشد، ایندکس هرگز parse و تحویل نمی‌شود. قاعدهٔ مشترک با
        | مسیر MCP است (core/config/artifactManifest.ts).
        */
        const indexBytes = fs.readFileSync(actualIndexPath);
        assertIndexMatchesCommittedManifest(actualIndexPath, indexBytes);

        index = JSON.parse(indexBytes.toString('utf8')) as ProjectIndex;
        reader = new ProjectIndexReader(index);
        const bpResult = manifest?.artifacts?.blueprint
          ? loadBlueprintBeside(actualIndexPath)
          : { index: undefined };
        if (bpResult.index) {
          blueprint = bpResult.index;
          const blueprintFile = path.join(path.dirname(actualIndexPath), 'blueprint.json');
          const expectedBlueprintHash = manifest?.artifacts?.blueprint?.sha256;
          if (expectedBlueprintHash) {
            const actualBlueprintHash = crypto.createHash('sha256')
              .update(fs.readFileSync(blueprintFile))
              .digest('hex');
            if (actualBlueprintHash !== expectedBlueprintHash) {
              throw new Error('blueprint does not match its committed artifact manifest');
            }
          }
        }

        registry = new AiToolRegistry({
          reader,
          workspaceRoot: rootPath,
          artifactRoot: path.dirname(actualIndexPath),
          projectHash: index.generatedAt,
          enableCache: true,
          ...(blueprint ? { blueprint } : {}),
        });

        filesCount = index.files ? (Array.isArray(index.files) ? index.files.length : Object.keys(index.files).length) : 0;
        symbolsCount = index.symbols ? index.symbols.length : 0;
        dependenciesCount = index.graphs?.dependencyGraph ? index.graphs.dependencyGraph.length : 0;
        lastIndexedAt = index.generatedAt;
        status = 'ready';
      } catch {
        status = 'stale';
      }
    }

    const managed: ManagedProject = {
      id,
      name: record?.name ?? name,
      rootPath,
      aliases,
      /* Always expose the write destination. A legacy index may have been
         read above, but the next UI indexing job must migrate it to the
         canonical directory instead of refreshing `.agent/semantic`. */
      indexPath: canonicalPath,
      blueprintPath: blueprint ? path.join(path.dirname(actualIndexPath), 'blueprint.json') : undefined,
      status,
      index,
      blueprint,
      reader,
      registry,
      stats: {
        filesCount,
        symbolsCount,
        dependenciesCount,
        lastIndexedAt,
      },
    };

    this.projects.set(rootPath, managed);
    this.byId.set(id, managed);
    for (const alias of aliases) this.byId.set(alias, managed);
    this.ensureArtifactWatcher(managed);
    return managed;
  }

  /**
   * همگام‌سازی cache سرویس با خروجی watcher یا هر indexer خارجی.
   * watchِ پروژه فقط artifact directory را نگاه می‌کند تا تغییرات سورس
   * باعث reload بی‌دلیل نشود؛ خود semantic-engine watch بعد از batch
   * موفق project-index و blueprint را atomic می‌نویسد.
   */
  private ensureArtifactWatcher(project: ManagedProject): void {
    if (this.artifactWatchers.has(project.id)) return;

    const directory = path.dirname(project.indexPath);
    if (!fs.existsSync(directory)) return;

    try {
      const watcher = fs.watch(directory, (_event, filename) => {
        const changed = filename ? String(filename) : '';
        if (!changed ||
            changed === path.basename(project.indexPath) ||
            changed === 'blueprint.json' ||
            changed === 'project-artifacts.manifest.json') {
          this.scheduleReload(project.id);
        }
      });
      watcher.on('error', () => {
        this.artifactWatchers.delete(project.id);
      });
      this.artifactWatchers.set(project.id, watcher);
    } catch {
      /* نبودن watcher نباید مانع سرویس‌دهی به index موجود شود. */
    }
  }

  private scheduleReload(id: string): void {
    const previous = this.reloadTimers.get(id);
    if (previous) clearTimeout(previous);

    const timer = setTimeout(() => {
      this.reloadTimers.delete(id);
      this.reloadProject(id);
    }, 100);
    timer.unref?.();
    this.reloadTimers.set(id, timer);
  }

  /** بستن watcherها در shutdown سرور. */
  dispose(): void {
    for (const timer of this.reloadTimers.values()) clearTimeout(timer);
    this.reloadTimers.clear();
    for (const watcher of this.artifactWatchers.values()) watcher.close();
    this.artifactWatchers.clear();
    this.projects.clear();
    this.byId.clear();
  }

  getProject(id: string): ManagedProject | undefined {
    return this.byId.get(id);
  }

  /**
   * تغییر واقعی name/enabled/autoStart: اول registry (durable)، بعد map
   * درون‌حافظه‌ای، تا PATCH دیگر فقط یک پاسخ ساختگی نباشد.
   */
  updateProject(
    id: string,
    patch: { name?: string; enabled?: boolean; autoStart?: boolean }
  ): ManagedProject | undefined {
    const current = this.byId.get(id);
    if (!current) return undefined;

    const registry = this.options.registry;
    let name = current.name;
    if (registry) {
      name = registry.update(current.id, patch).name;
    } else if (patch.name !== undefined) {
      name = patch.name.trim();
      if (name === '') throw new Error('Project name must not be empty.');
    }

    const updated: ManagedProject = { ...current, name };
    this.projects.set(current.rootPath, updated);
    for (const key of [current.id, ...current.aliases]) {
      if (this.byId.get(key) === current) this.byId.set(key, updated);
    }
    return updated;
  }

  /**
   * حذف واقعی: watcher/timer، هر دو map و رکورد registry پاک می‌شوند تا
   * پروژهٔ حذف‌شده پس از restart برنگردد. فایل‌های ایندکس دست‌نخورده می‌مانند.
   */
  removeProject(id: string): boolean {
    const current = this.byId.get(id);
    if (!current) return false;

    this.options.registry?.remove(current.id);

    const timer = this.reloadTimers.get(current.id);
    if (timer) clearTimeout(timer);
    this.reloadTimers.delete(current.id);
    this.artifactWatchers.get(current.id)?.close();
    this.artifactWatchers.delete(current.id);

    this.projects.delete(current.rootPath);
    for (const [key, value] of [...this.byId]) {
      if (value === current) this.byId.delete(key);
    }
    return true;
  }

  listProjects(): ManagedProject[] {
    return Array.from(this.projects.values());
  }

  /**
   * بازخوانی ایندکس پروژه پس از تکمیل فرآیند ایندکس‌سازی.
   */
  reloadProject(id: string): ManagedProject | undefined {
    const current = this.byId.get(id);
    if (!current) return undefined;
    return this.registerProject(current.rootPath, current.id, current.name);
  }

  /**
   * تولید گراف تحلیلی پروژه برای Impact Analysis و معماری.
   */
  getProjectGraph(id: string): AnalysisGraph {
    return buildProjectGraph(this.byId.get(id));
  }

  /**
   * قرارداد صریح: این متد ایندکس را دوباره «نمی‌سازد»؛ artifactهای ایندکس
   * موجود را از دیسک دوباره می‌خواند (`mode: 'reload'`) و شمارش‌های واقعی
   * آن را برمی‌گرداند. ایندکس‌سازی واقعی توسط `IndexPipeline` انجام می‌شود
   * و به این سرویس وصل نشده است؛ `mode` تا آن زمان این را به caller می‌گوید.
   */
  async indexProject(
    id: string,
    _options?: { incremental?: boolean }
  ): Promise<{
    filesCount: number;
    symbolsCount: number;
    edgesCount: number;
    mode: 'reload';
    reindexed: false;
  }> {
    const project = this.byId.get(id);
    if (!project) {
      throw new Error(`Project '${id}' not found`);
    }

    const reloaded = this.reloadProject(id);
    return {
      filesCount: reloaded?.stats.filesCount || 0,
      symbolsCount: reloaded?.stats.symbolsCount || 0,
      edgesCount: reloaded?.stats.dependenciesCount || 0,
      mode: 'reload',
      reindexed: false,
    };
  }

  /**
   * ثبت در registry دائمی، اگر یکی تزریق شده باشد.
   *
   * ریشهٔ ناموجود خطای registry می‌دهد ولی رفتار قبلی این سرویس «پروژه با
   * status=missing» است، پس فقط همان دو حالت نادیده گرفته می‌شوند؛ هر خطای
   * دیگری (مثل تضاد شناسه) باید دیده شود، نه بلعیده.
   */
  private registerInRegistry(
    rootPath: string,
    name: string,
    requestedId: string
  ): ProjectRecord | undefined {
    const registry = this.options.registry;
    if (!registry) return undefined;

    try {
      return registry.register({
        rootPath,
        name,
        ...(requestedId !== '' ? { id: requestedId } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/does not exist|not a directory/.test(message)) return undefined;
      throw error;
    }
  }

  private deriveId(rootPath: string, name: string, requestedId: string): string {
    /*
    | یک شناسهٔ صریح فقط وقتی معتبر است که نویسهٔ بی‌خطر داشته باشد؛ در غیر
    | این صورت شناسه تولید می‌شود و همان مقدار صریح به alias تبدیل می‌شود.
    */
    if (requestedId !== '' && isSafeProjectId(requestedId)) return requestedId;
    return projectIdFor(name, canonicalizeRoot(rootPath));
  }

}

export interface ProjectServiceOptions {
  /** registry دائمی پروژه‌ها؛ بدون آن، شناسه‌ها فقط در حافظه نگه داشته می‌شوند. */
  readonly registry?: ProjectRegistry;
  /** کجا نوشته شود؛ پیش‌فرض `in-root` (رفتار فعلی). */
  readonly artifactLocation?: ArtifactLocation;
  /** data root صریح؛ در غیر این صورت `resolveDataRoot` تصمیم می‌گیرد. */
  readonly dataRoot?: string;
  /** شناسهٔ artifact ریشهٔ اصلی سرور (`--project-id`)؛ بدون آن از ریشه ساخته می‌شود. */
  readonly artifactProjectId?: string;
}
