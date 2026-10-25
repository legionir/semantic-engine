/**
 * ProjectIndexStore — wrapper mutable برای ProjectIndex جهت incremental update.
 *
 * مسئولیت:
 * - نگهداری state فعلی project-index در حافظه
 * - به‌روزرسانی سریع فایل‌ها، symbol ها، و graph ها
 * - محاسبه‌ی reverse index برای import/dependency
 *
 * تمام mutations در این کلاس انجام می‌شود؛ IncrementalEngine فقط منطق تصمیم‌گیری دارد.
 *
 * ── SE-INC-09 ─────────────────────────────────────────────────────
 *
 * «mutable» به این معنی نیست که روی شیء *ورودی* بنویسیم.
 * `syncFilesArray` و `syncSymbolsArray` این کار را می‌کردند:
 *
 * ```ts
 * (this.projectIndex as unknown as { files: FileEntry[] }).files = files;
 * ```
 *
 * دو مشکل: قرارداد `readonly` را می‌شکست (و روی یک شیء `Object.freeze`
 * شده در حالت strict استثنا می‌داد)، و فراخوانِ `load()` نمی‌توانست
 * فرض کند ایندکسی که داده دست‌نخورده می‌ماند. حالا هر تغییر، یک شیء
 * سطح-بالای تازه می‌سازد؛ آرایه‌ها و ورودی‌های دست‌نخورده به اشتراک
 * گذاشته می‌شوند، پس هزینه‌اش یک shallow copy است نه یک کپی عمیق.
 *
 * ── SE-INC-11 ─────────────────────────────────────────────────────
 *
 * `removeFile` نگاشت `symbolsByFileId` را پاک می‌کرد و `syncFilesArray`
 * را صدا می‌زد، ولی `syncSymbolsArray` را **نه**. یعنی بلافاصله پس از
 * حذف، `projectIndex.symbols` هنوز symbolهای فایلِ رفته را داشت و
 * store در حالتی بود که «فایلی که نیست، symbol دارد».
 */

import {
  ProjectIndex,
  FileEntry,
  SymbolEntry,
  CallEdge,
  TypeEdge,
  DependencyEdge,
  IncrementalInfo,
} from '../core/types/project-index.types';
import { normalizePath } from '../core/utils/hash';
import { sortSymbolsDeterministically } from '../core/utils/symbolSort';
import { ReverseDependencyIndex } from '../graphs/ReverseDependencyIndex';

export class ProjectIndexStore {
  private fileById = new Map<string, FileEntry>();
  private fileByPath = new Map<string, FileEntry>();
  private symbolsByFileId = new Map<string, SymbolEntry[]>();

  /** نگاشت وارونهٔ وابستگی — تنبل، چون هر تغییر باطلش می‌کند. */
  private dependentsByFileId: Map<string, Set<string>> | null = null;

  private currentIndex: ProjectIndex;
  /** `files`/`symbols` arrays are stale; rebuilt once, on the next read of `projectIndex`. */
  private arraysDirty = false;

  constructor(projectIndex: ProjectIndex) {
    this.currentIndex = projectIndex;
    this.rebuildIndexes();
  }

  /**
   * The index with up-to-date `files`/`symbols` arrays.
   *
   * Every `upsertFile`/`setSymbolsForFile` used to rebuild and re-sort both arrays eagerly. A change
   * to one file with 136 dependents did that ≈270 times (≈4 s of a ≈8 s update, measured). The maps
   * are the source of truth, so the arrays are now rebuilt once, when somebody reads them.
   */
  get projectIndex(): ProjectIndex {
    if (this.arraysDirty) this.rebuildArrays();
    return this.currentIndex;
  }

  set projectIndex(value: ProjectIndex) {
    this.currentIndex = value;
    this.arraysDirty = false;
  }

  /**
   * بارگذاری مجدد projectIndex (مثلاً بعد از regeneration کامل AI Metadata).
   */
  load(projectIndex: ProjectIndex): void {
    this.projectIndex = projectIndex;
    this.rebuildIndexes();
  }

  /** بی‌اعتبار کردن نگاشت‌های مشتق — پس از هر تغییر ساختاری. */
  private invalidateDerived(): void {
    this.dependentsByFileId = null;
  }

  private rebuildIndexes(): void {
    this.fileById = new Map(this.projectIndex.files.map(f => [f.id, f]));
    this.fileByPath = new Map(this.projectIndex.files.map(f => [normalizePath(f.path), f]));

    this.symbolsByFileId = new Map();
    for (const sym of this.projectIndex.symbols) {
      const list = this.symbolsByFileId.get(sym.fileId) ?? [];
      list.push(sym);
      this.symbolsByFileId.set(sym.fileId, list);
    }

    this.invalidateDerived();
  }

  getFileById(fileId: string): FileEntry | undefined {
    return this.fileById.get(fileId);
  }

  getFileByPath(filePath: string): FileEntry | undefined {
    return this.fileByPath.get(normalizePath(filePath));
  }

  getSymbolsForFile(fileId: string): readonly SymbolEntry[] {
    return this.symbolsByFileId.get(fileId) ?? [];
  }

  /**
   * نگاشت «چه کسی به این فایل وابسته است» — SE-INC-06.
   *
   * نسخهٔ قبلی فقط `file.imports` را می‌خواند. یک barrel با
   * `export { x } from './y'` هیچ `import` ندارد؛ فقط یک export با
   * `reExportFrom`. یعنی در نگاه store، *هیچ‌کس* به `y` وابسته نبود و
   * تغییر در `y` هیچ فایلی را بازپردازش نمی‌کرد.
   *
   * `dependencyGraph` هر دو شکل را می‌شناسد — همان جایی که
   * `DependencyGraphBuilder` import و re-export را کنار هم می‌گذارد —
   * پس منبع درست همان است. `file.imports` به‌عنوان پشتیبان می‌ماند
   * برای وقتی که گراف هنوز ساخته نشده.
   */
  private dependentsMap(): Map<string, Set<string>> {
    if (this.dependentsByFileId) return this.dependentsByFileId;

    const map = new Map<string, Set<string>>();
    const add = (target: string, dependent: string): void => {
      if (target === dependent) return;
      const set = map.get(target);
      if (set) set.add(dependent);
      else map.set(target, new Set([dependent]));
    };

    for (const edge of this.projectIndex.graphs?.dependencyGraph ?? []) {
      if (this.fileById.has(edge.to) && this.fileById.has(edge.from)) {
        add(edge.to, edge.from);
      }
    }

    for (const file of this.projectIndex.files) {
      for (const imported of file.imports ?? []) {
        const target = imported.resolvedFileId;
        if (target && this.fileById.has(target)) add(target, file.id);
      }
    }

    this.dependentsByFileId = map;
    return map;
  }

  /**
   * فایل‌هایی که مستقیماً به fileId وابسته‌اند.
   */
  getDirectDependents(fileId: string): FileEntry[] {
    const ids = this.dependentsMap().get(fileId);
    if (!ids) return [];
    return [...ids]
      .map(id => this.fileById.get(id))
      .filter((file): file is FileEntry => file !== undefined)
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * فایل‌هایی که مستقیم **یا از طریق زنجیره** به fileId وابسته‌اند.
   *
   * SE-INC-06: یک تایپ که از طریق `index.ts` دوباره export می‌شود،
   * مصرف‌کنندهٔ واقعی‌اش دو گام دورتر است. یک سطح کافی نیست.
   *
   * پیمایش BFS با مجموعهٔ بازدیدشده است، پس چرخهٔ وابستگی — که در
   * TypeScript کاملاً مجاز است — بی‌نهایت نمی‌شود.
   */
  getTransitiveDependents(fileId: string, maxDepth = 16): FileEntry[] {
    const map = this.dependentsMap();
    const seen = new Set<string>([fileId]);
    const collected: string[] = [];

    let frontier = [fileId];
    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const current of frontier) {
        for (const dependent of map.get(current) ?? []) {
          if (seen.has(dependent)) continue;
          seen.add(dependent);
          collected.push(dependent);
          next.push(dependent);
        }
      }
      frontier = next;
    }

    return collected
      .map(id => this.fileById.get(id))
      .filter((file): file is FileEntry => file !== undefined)
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * پیدا کردن فایل‌هایی که از fileId مشخص استفاده می‌کنند (reverse dependency).
   */
  getDirectDependencies(fileId: string): string[] {
    const file = this.fileById.get(fileId);
    if (!file || !file.imports) return [];
    return file.imports
      .map(imp => imp.resolvedFileId)
      .filter((id): id is string => !!id);
  }

  /**
   * جایگزینی یا افزودن یک فایل.
   */
  upsertFile(file: FileEntry): void {
    this.fileById.set(file.id, file);
    this.fileByPath.set(normalizePath(file.path), file);
    this.syncArrays();
  }

  /**
   * حذف فایل و تمام symbol و edge های مرتبط.
   *
   * @returns شناسهٔ symbolهایی که با این فایل رفتند — فراخوان برای
   * پاک‌سازی یال‌ها به آن‌ها نیاز دارد و بعد از این لحظه دیگر جایی
   * ثبت نیستند (SE-INC-03).
   */
  removeFile(fileId: string): readonly string[] {
    const file = this.fileById.get(fileId);
    if (file) {
      this.fileByPath.delete(normalizePath(file.path));
    }
    const removedSymbolIds = (this.symbolsByFileId.get(fileId) ?? []).map(symbol => symbol.id);

    this.fileById.delete(fileId);
    this.symbolsByFileId.delete(fileId);
    /*
    | SE-INC-11: هر دو آرایه با هم. قبلاً فقط فایل‌ها همگام می‌شدند و
    | symbolهای فایلِ حذف‌شده تا فراخوانی بعدیِ `setSymbolsForFile`
    | در آرایه می‌ماندند.
    */
    this.syncArrays();

    return removedSymbolIds;
  }

  /**
   * تغییر مسیر یک فایل بدون از دست دادن هویت آن — SE-P0-PARITY-01.
   *
   * مسیرِ rename با محتوای بدون‌تغییر، `removeFile` + `upsertFile` را صدا
   * می‌زد. `removeFile` (طبق SE-INC-11) عمداً `symbolsByFileId` را هم پاک
   * می‌کند، و `upsertFile` چیزی برای برگرداندنشان ندارد. اندازه‌گیری با
   * fixture فاز ۰: بعد از rename، ایندکس افزایشی ۵ symbol داشت و یک
   * rebuild کامل ۶ — همان یک symbolِ فایلِ جابه‌جاشده.
   *
   * rename یعنی «همان فایل، مسیر دیگر»، پس نگاشت symbolها باید دست‌نخورده
   * بماند؛ فقط کلیدهای مسیر عوض می‌شوند.
   */
  renameFile(fileId: string, newPath: string): FileEntry | null {
    const file = this.fileById.get(fileId);
    if (!file) return null;

    const renamed: FileEntry = {
      ...file,
      path: normalizePath(newPath),
      modified: new Date().toISOString(),
    };
    this.fileByPath.delete(normalizePath(file.path));
    this.fileById.set(fileId, renamed);
    this.fileByPath.set(normalizePath(renamed.path), renamed);
    this.syncArrays();
    return renamed;
  }

  /**
   * جایگزینی symbol های یک فایل.
   */
  setSymbolsForFile(fileId: string, symbols: readonly SymbolEntry[]): void {
    this.symbolsByFileId.set(fileId, [...symbols]);
    this.syncArrays();
  }

  /**
   * ساخت آرایه‌های `files` و `symbols` از روی نگاشت‌ها.
   *
   * SE-INC-09: به‌جای نوشتن روی شیء موجود، یک شیء سطح-بالای تازه
   * ساخته می‌شود. `rebuildIndexes` عمداً صدا زده نمی‌شود — نگاشت‌ها
   * همین حالا منبع حقیقت‌اند و بازسازی‌شان از روی آرایه‌ای که خودشان
   * ساخته‌اند، کار بیهوده است.
   */
  private syncArrays(): void {
    this.arraysDirty = true;
    this.dependentsByFileId = null;
  }

  private rebuildArrays(): void {
    this.arraysDirty = false;
    const files = Array.from(this.fileById.values()).sort((a, b) => a.path.localeCompare(b.path));

    const symbols: SymbolEntry[] = [];
    for (const file of files) {
      symbols.push(...(this.symbolsByFileId.get(file.id) ?? []));
    }

    this.currentIndex = {
      ...this.currentIndex,
      files,
      symbols: sortSymbolsDeterministically(symbols),
    };
  }

  /**
   * ساخت ProjectIndex به‌روزرسانی‌شده.
   */
  buildUpdatedIndex(options: {
    changedFileIds: readonly string[];
    removedFileIds: readonly string[];
    graphs: {
      callGraph: readonly CallEdge[];
      typeGraph: readonly TypeEdge[];
      dependencyGraph: readonly DependencyEdge[];
    };
    mode: 'full' | 'incremental';
    baseGeneratedAt: string | null;
  }): ProjectIndex {
    const files = Array.from(this.fileById.values()).sort((a, b) => a.path.localeCompare(b.path));
    const symbols: SymbolEntry[] = [];
    for (const file of files) {
      const syms = this.symbolsByFileId.get(file.id) ?? [];
      symbols.push(...syms);
    }

    const incremental: IncrementalInfo = {
      mode: options.mode,
      baseGeneratedAt: options.baseGeneratedAt,
      changedFileIds: [...options.changedFileIds],
      removedFileIds: [...options.removedFileIds],
    };

    /*
    | SE-INC-12: `graphs: options.graphs` سه گراف دارد و
    | `reverseDependencyGraph` را ندارد — پس هر به‌روزرسانی افزایشی
    | آن را از ایندکس حذف می‌کرد. اندازه‌گیری: ۲ یال قبل، ۰ یال بعد
    | از یک تغییر ساده. مصرف‌کنندهٔ AI که «چه کسی به این وابسته است»
    | را از همان می‌خواند، بعد از اولین ذخیره چیزی نمی‌دید.
    |
    | ساختش ارزان است (یک پیمایش روی سه گراف) و اشتقاقی است، پس
    | همین‌جا از نو ساخته می‌شود نه اینکه به‌صورت افزایشی نگه داشته
    | شود.
    */
    const reverseDependencyGraph = new ReverseDependencyIndex({
      includeSymbolLevel: true,
    }).build({
      callGraph: options.graphs.callGraph,
      typeGraph: options.graphs.typeGraph,
      dependencyGraph: options.graphs.dependencyGraph,
    });

    /*
    | SE-INC-05: بردارهای فایل‌های رفته هم می‌روند. تا امروز
    | `...this.projectIndex` آن‌ها را دست‌نخورده حمل می‌کرد، پس یک
    | chunk می‌توانست به فایلی اشاره کند که دیگر در ایندکس نیست —
    | چیزی که `validate-project-index.js` هم به‌عنوان خطا می‌گیرد.
    */
    const liveFileIds = new Set(files.map(file => file.id));
    const liveSymbolIds = new Set(symbols.map(symbol => symbol.id));
    const vectorChunks = this.projectIndex.vectorChunks?.filter(
      chunk =>
        liveFileIds.has(chunk.fileId) && (!chunk.symbolId || liveSymbolIds.has(chunk.symbolId))
    );

    return {
      ...this.projectIndex,
      generatedAt: new Date().toISOString(),
      files,
      symbols: sortSymbolsDeterministically(symbols),
      graphs: { ...options.graphs, reverseDependencyGraph },
      incremental,
      ...(vectorChunks ? { vectorChunks } : {}),
    };
  }

  /**
   * محاسبه‌ی driftScore ساده: نسبت فایل‌هایی که hash محتوای فعلی با hash ذخیره‌شده متفاوت است.
   * در فاز ۹ برای تصمیم‌گیری rebuild Blueprint استفاده می‌شود.
   */
  computeDriftScore(changedFileIds: readonly string[], removedFileIds: readonly string[]): number {
    if (this.projectIndex.files.length === 0) return 0;
    const total = this.projectIndex.files.length;
    const drifted = new Set([...changedFileIds, ...removedFileIds]);
    return drifted.size / total;
  }

  getAllFiles(): readonly FileEntry[] {
    return this.projectIndex.files;
  }

  getAllSymbols(): readonly SymbolEntry[] {
    return this.projectIndex.symbols;
  }
}
