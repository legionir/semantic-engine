/**
 * BlueprintGenerator — تولید blueprint.json از روی project-index.json.
 *
 * این فاز کاملاً derived است؛ هیچ id جدیدی برای symbol/file نمی‌سازد.
 * module id ها با پیشوند `mod-` و ساختار path-based تولید می‌شوند.
 */

import * as path from 'path';
import {
  ProjectIndex,
  FileEntry,
  SymbolEntry,
} from '../core/types/project-index.types';
import {
  Blueprint,
  BlueprintMeta,
  ModuleEntry,
  FolderNode,
  BlueprintDependencyGraph,
  GraphNode,
  GraphEdge,
  BlueprintSymbolIndexEntry,
  TechnicalConstraint,
  ArchitectureOverview,
  ArchitectureLayer,
  ApiEntry,
  DataFlowEdge,
} from '../core/types/blueprint.types';
import { sha256 } from '../core/utils/hash';
import {
  ARCHITECTURE_LAYERS,
  MIN_CATEGORY_SHARE_DIVISOR,
  MODULE_CATEGORIES,
  ROOT_MODULE_PATH,
  matchesSegment,
} from './blueprintCategories';
import { ApiMapExtractor } from './ApiMapExtractor';
import { EntityMapExtractor, WorkflowExtractor } from './EntityMapExtractor';

export interface BlueprintGeneratorOptions {
  readonly generatorVersion?: string;
  readonly gitCommit?: string;
  readonly driftScore?: number;
  /**
   * سورسِ یک فایل، برای استخراجِ `apiMap` — SE-BP-02.
   *
   * blueprint در اصل «کاملاً derived» است و فقط از project-index
   * می‌خواند. ثبتِ مسیرهای HTTP اما در ایندکس نیست: نه symbol است نه
   * dependency. به‌جای افزودنِ یک فیلدِ تازه به قرارداد داده، سورس
   * به‌صورت **اختیاری** تزریق می‌شود.
   *
   * بدون آن، `apiMap` خالی می‌ماند — که صادقانه است: «نگاه نکردم»
   * نه «چیزی نبود».
   */
  readonly sourceOf?: (file: FileEntry) => string | undefined;
}

export class BlueprintGenerator {
  private readonly moduleMap = new Map<string, ModuleEntry>();
  /**
   * fileId → moduleId، از آخرین `generate()`.
   *
   * SE-DATA-04 — `FileEntry.blueprintRef` در قرارداد اعلام شده بود و
   * هیچ‌جا نوشته نمی‌شد. نگاشتِ فایل به ماژول فقط داخل blueprint
   * وجود داشت، پس هر مصرف‌کننده‌ای که از project-index شروع می‌کرد
   * یا باید دوباره حسابش می‌کرد یا بی‌خبر می‌ماند.
   */
  private readonly moduleByFileId = new Map<string, string>();

  /** نگاشتِ فایل به ماژولِ آخرین blueprintِ تولیدشده. */
  moduleRefs(): ReadonlyMap<string, string> {
    return this.moduleByFileId;
  }

  constructor(private readonly options: BlueprintGeneratorOptions = {}) {}

  generate(projectIndex: ProjectIndex): Blueprint {
    const modules = this.buildModuleMap(projectIndex.files);
    const apiMap = this.buildApiMap(projectIndex);
    const folderStructure = this.buildFolderStructure(projectIndex.files);
    const dependencyGraph = this.buildDependencyGraph(projectIndex, modules);
    const moduleDependencies = this.deriveModuleDependencies(modules, dependencyGraph);

    const modulesWithDeps: ModuleEntry[] = modules.map(mod => {
      const deps = moduleDependencies.get(mod.id) ?? [];
      return deps.length > 0 ? { ...mod, dependsOnModuleIds: deps } : mod;
    });

    return {
      schemaVersion: '2.0.0',
      meta: this.buildMeta(projectIndex),
      architectureOverview: this.buildArchitectureOverview(modulesWithDeps),
      moduleMap: modulesWithDeps,
      folderStructure,
      dependencyGraph,
      entityTechnicalMapping: new EntityMapExtractor().extract({
        projectIndex,
        ...(this.options.sourceOf ? { sourceOf: this.options.sourceOf } : {}),
      }),
      apiMap,
      workflowExecutionMap: new WorkflowExtractor().extract({ projectIndex, apiMap }),
      symbolIndex: this.buildSymbolIndex(projectIndex.symbols, projectIndex.files),
      technicalConstraints: this.buildTechnicalConstraints(projectIndex),
    };
  }

  /**
   * SE-BP-02 — `apiMap` از روی سورس، بدون LLM.
   *
   * فقط فایل‌هایی خوانده می‌شوند که `sourceOf` برایشان چیزی بدهد.
   * اگر تزریق نشده باشد، فهرست خالی است.
   */
  private buildApiMap(projectIndex: ProjectIndex): ApiEntry[] {
    const sourceOf = this.options.sourceOf;
    if (!sourceOf) return [];

    const extractor = new ApiMapExtractor();
    const entries: ApiEntry[] = [];
    const symbolsByFile = new Map<string, SymbolEntry[]>();

    for (const symbol of projectIndex.symbols) {
      const list = symbolsByFile.get(symbol.fileId) ?? [];
      list.push(symbol);
      symbolsByFile.set(symbol.fileId, list);
    }

    for (const file of projectIndex.files) {
      if (file.binary) continue;

      const source = sourceOf(file);
      if (!source) continue;

      for (const route of extractor.extract(file.path, source)) {
        /*
        | handler به یک symbol واقعی وصل می‌شود اگر پیدا شود. نامِ
        | تنها، بدون شناسه، برای مصرف‌کننده‌ای که می‌خواهد به کد
        | برود کافی نیست.
        */
        const handlerSymbol = route.handlerName
          ? (symbolsByFile.get(file.id) ?? []).find(sym => sym.name === route.handlerName)
          : undefined;

        entries.push({
          id: `api-${sha256(`${file.id}:${route.method}:${route.path}:${route.line}`).substring(0, 12)}`,
          method: route.method as ApiEntry['method'],
          path: route.path,
          handlerSymbolId: handlerSymbol?.id ?? null,
          handlerName: route.handlerName,
          fileId: file.id,
          line: route.line,
          framework: route.framework,
          derivedFrom: 'static-analysis',
          /*
          | SE-SEC-001: تشخیصِ اینکه یک مسیر احراز هویت می‌خواهد، از نحو
          | برنمی‌آید. `false` قدیمی به AI می‌گفت «این route باز است» در
          | حالی که منظور «شواهدی ندیدم» بود — یعنی evidence of absence
          | جا زده می‌شد با absence of evidence (§15). حالا `null` یعنی
          | «بررسی نشد» و فقط وقتی واقعاً middleware احراز هویت روی route
          | دیده شده true/false صادر می‌شود.
          */
          authRequired: null,
        });
      }
    }

    return entries.sort(
      (a, b) =>
        a.path.localeCompare(b.path) ||
        a.method.localeCompare(b.method) ||
        (a.fileId ?? '').localeCompare(b.fileId ?? '')
    );
  }

  private buildMeta(projectIndex: ProjectIndex): BlueprintMeta {
    const projectName = typeof projectIndex.root === 'string' && projectIndex.root.length > 0
      ? projectIndex.root
      : 'unknown-project';

    return {
      id: this.generateBlueprintId(projectIndex),
      projectName,
      generatedAt: new Date().toISOString(),
      sourceProjectIndex: {
        generatedAt: projectIndex.generatedAt,
        schemaVersion: projectIndex.schemaVersion,
        fileCountAtSync: projectIndex.files.length,
      },
      lastSyncedCommit: this.options.gitCommit ?? 'unknown',
      driftScore: this.options.driftScore ?? 0,
      generatorVersion: this.options.generatorVersion ?? projectIndex.generatorVersion ?? '0.1.0',
    };
  }

  private generateBlueprintId(projectIndex: ProjectIndex): string {
    const input = `${projectIndex.root}:${projectIndex.generatedAt}:${projectIndex.files.length}`;
    return `bp-${sha256(input).substring(0, 12)}`;
  }

  private buildModuleMap(files: readonly FileEntry[]): ModuleEntry[] {
    this.moduleMap.clear();
    this.moduleByFileId.clear();
    const moduleFiles = new Map<string, FileEntry[]>();

    for (const file of files) {
      if (file.binary) continue;
      const modulePath = this.deriveModulePath(file.path);

      const list = moduleFiles.get(modulePath);
      if (list) {
        list.push(file);
      } else {
        moduleFiles.set(modulePath, [file]);
      }
    }

    const modules: ModuleEntry[] = [];
    for (const [modulePath, fileList] of moduleFiles) {
      const id = this.modulePathToId(modulePath);
      const name = modulePath === ROOT_MODULE_PATH
        ? 'root'
        : path.basename(modulePath) || modulePath;
      const entry: ModuleEntry = {
        id,
        name,
        path: modulePath,
        responsibility: this.inferResponsibility(name, fileList),
        fileIds: fileList.map(f => f.id).sort(),
      };
      modules.push(entry);
      this.moduleMap.set(modulePath, entry);
      for (const fileId of entry.fileIds) this.moduleByFileId.set(fileId, id);
    }

    return modules.sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * ماژولِ یک فایل = دایرکتوری والدش.
   *
   * SE-BP-04 — قبلاً برای `dir === '.'` مقدار `null` برمی‌گشت، پس هر
   * فایلِ ریشه (`package.json`, `README.md`, `tsconfig.json`) در هیچ
   * ماژولی نبود و از `moduleMap` غایب می‌ماند. حالا همه در یک ماژولِ
   * صریحِ ریشه جمع می‌شوند.
   */
  private deriveModulePath(filePath: string): string {
    const dir = path.dirname(filePath).replace(/\\/g, '/');
    return dir === '.' || dir === '' ? ROOT_MODULE_PATH : dir;
  }

  /**
   * شناسهٔ ماژول — SE-BP-01.
   *
   * نسخهٔ قبلی این بود:
   *
   * ```ts
   * modulePath.replace(/\//g, '-').replace(/_/g, '-').toLowerCase()
   * ```
   *
   * سه نگاشتِ اتلافی روی هم: جداکنندهٔ مسیر و زیرخط هر دو به `-`
   * تبدیل می‌شدند و همه‌چیز کوچک می‌شد. پس `src/foo_bar` و
   * `src/foo/bar` هر دو `mod-src-foo-bar` می‌شدند، و `src/FooBar` با
   * `src/foobar` یکی. دو `ModuleEntry` با شناسهٔ یکسان در `moduleMap`
   * ظاهر می‌شدند و نگاشتِ فایل به ماژول غلط می‌شد.
   *
   * حالا شناسه هم **خوانا** می‌ماند و هم **یکتا**: شکلِ خواناشده
   * ساخته می‌شود و اگر با مسیرِ اصلی بازگشت‌پذیر نباشد، یک پسوندِ
   * کوتاهِ هش از مسیرِ دقیق به آن اضافه می‌شود.
   */
  private modulePathToId(modulePath: string): string {
    if (modulePath === ROOT_MODULE_PATH) return 'mod-root';

    const normalized = modulePath.replace(/\\/g, '/');
    const readable = normalized
      .toLowerCase()
      // هر نویسه خارج از `[a-z0-9]` (جداکننده، `_`، `.`، `@`، فاصله، ...)
      // با schema (`^mod-[a-z0-9-]+$`) سازگار نیست؛ مثلاً `.github` یا `@types`.
      .replace(/[^a-z0-9]+/g, '-')
      // `src/__tests__` نباید `src---tests--` شود.
      .replace(/^-|-$/g, '');

    // بازگشت‌پذیر؟ اگر شکلِ خوانا اطلاعاتی را دور نریخته باشد، همان کافی است.
    const lossless = /^[a-z0-9]+(\/[a-z0-9]+)*$/.test(normalized);

    if (lossless) return `mod-${readable}`;

    const hash = sha256(normalized).substring(0, 6);
    return readable ? `mod-${readable}-${hash}` : `mod-${hash}`;
  }

  /**
   * مسئولیت ماژول را با **رأی‌گیری روی فایل‌ها** تعیین می‌کند.
   *
   * SE-BP-05 — نسخهٔ قبلی این بود:
   *
   * ```ts
   * const names = files.map(f => f.path).join(' ');
   * const lower = names.toLowerCase();
   * if (lower.includes('service')) return 'Business logic and orchestration';
   * ...
   * if (lower.includes('test')) return 'Test specifications';
   * ```
   *
   * یعنی زیررشته را در *الحاقِ* همهٔ مسیرها می‌جست، پس یک فایل کافی
   * بود تا برچسبِ کلِ ماژول عوض شود، و ترتیبِ if ها تعیین می‌کرد کدام
   * فایل برنده است. اندازه‌گیری روی ایندکس واقعی این پکیج (۳۲ ماژول):
   * ۲۵ ماژول برچسب «Test specifications» گرفتند و ۲۰ تای آنها
   * اکثریتشان کدِ منبع بود.
   *
   * حالا هر فایل *مستقل* دسته‌بندی می‌شود و پرتکرارترین دسته برنده
   * است. دو قاعدهٔ صریح:
   *
   * - **فایل‌های تست در رأی‌گیریِ موضوع شرکت نمی‌کنند.** `X.test.ts`
   *   دربارهٔ موضوعِ ماژول چیزی نمی‌گوید جز اینکه `X` آزموده شده.
   *   «Test specifications» فقط وقتی برنده است که هیچ فایلِ غیرتست
   *   نمانده باشد.
   * - **تساوی به نفعِ دستهٔ خاص‌تر شکسته می‌شود** (ترتیب `CATEGORIES`)،
   *   تا نتیجه به ترتیبِ ورودی حساس نباشد.
   */
  private inferResponsibility(moduleName: string, files: FileEntry[]): string {
    const votes = new Map<string, number>();
    let nonTestFiles = 0;

    for (const file of files) {
      if (this.isTestFile(file)) continue;
      nonTestFiles++;

      const category = this.categorizeFile(file.path);
      if (category) votes.set(category, (votes.get(category) ?? 0) + 1);
    }

    if (nonTestFiles === 0 && files.length > 0) return 'Test specifications';

    let winner: string | null = null;
    let best = 0;
    for (const category of MODULE_CATEGORIES) {
      const count = votes.get(category.label) ?? 0;
      if (count > best) {
        best = count;
        winner = category.label;
      }
    }

    /*
    | اکثریتِ نسبی کافی نیست. `mod-lsp` روی ایندکس واقعی سیزده فایل
    | منبع دارد که فقط یکی‌شان `LspEnrichmentService.ts` است؛ با
    | رأی‌گیریِ ساده همان یک رأی برنده می‌شد چون بقیه هیچ رأیی
    | نمی‌دهند. برچسبی که از ۸٪ فایل‌ها می‌آید، دربارهٔ ماژول چیزی
    | نمی‌گوید.
    |
    | آستانه یک‌سوم است: قضاوت، نه اندازه‌گیری — ولی قضاوتی که نوشته
    | شده و آزمون دارد.
    */
    if (winner && best * MIN_CATEGORY_SHARE_DIVISOR >= nonTestFiles) return winner;
    if (moduleName === 'src' || moduleName === 'app') {
      return 'Application entrypoint and core setup';
    }
    return `Module ${moduleName}`;
  }

  private isTestFile(file: FileEntry): boolean {
    if (file.testFile) return true;
    return /\.(test|spec)\.[cm]?[jt]sx?$/i.test(file.path);
  }

  /** دستهٔ یک فایل بر اساس مسیرِ *خودش*، نه الحاقِ مسیرهای ماژول. */
  private categorizeFile(filePath: string): string | null {
    const lower = filePath.toLowerCase();
    for (const category of MODULE_CATEGORIES) {
      if (category.patterns.some(pattern => lower.includes(pattern))) {
        return category.label;
      }
    }
    return null;
  }


  private buildFolderStructure(files: readonly FileEntry[]): FolderNode {
    interface MutableFolderNode {
      name: string;
      type: 'file' | 'directory';
      fileId?: string | null;
      children?: MutableFolderNode[];
    }

    const root: MutableFolderNode = { name: '.', type: 'directory', children: [] };
    const index = new Map<string, MutableFolderNode>();
    index.set('.', root);

    for (const file of files) {
      const parts = file.path.split('/');
      let currentPath = '';

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!;
        const isFile = i === parts.length - 1;
        const parentPath = currentPath || '.';
        currentPath = currentPath ? `${currentPath}/${part}` : part;

        let node = index.get(currentPath);
        if (!node) {
          node = isFile
            ? { name: part, type: 'file', fileId: file.id }
            : { name: part, type: 'directory', children: [] };
          index.set(currentPath, node);

          const parent = index.get(parentPath)!;
          parent.children = parent.children ?? [];
          parent.children.push(node);
        }
      }
    }

    this.sortFolderChildren(root);
    return root as FolderNode;
  }

  private sortFolderChildren(node: { children?: { name: string; type: 'file' | 'directory'; children?: unknown[] }[] }): void {
    if (!node.children || node.children.length === 0) return;
    node.children.sort((a, b) => {
      if (a.type === b.type) return a.name.localeCompare(b.name);
      return a.type === 'directory' ? -1 : 1;
    });
    for (const child of node.children) {
      if ('children' in child) {
        this.sortFolderChildren(child as { children?: { name: string; type: 'file' | 'directory'; children?: unknown[] }[] });
      }
    }
  }

  private buildDependencyGraph(
    projectIndex: ProjectIndex,
    modules: ModuleEntry[]
  ): BlueprintDependencyGraph {
    const nodes: GraphNode[] = [];
    const nodeIds = new Set<string>();

    // file nodes
    for (const file of projectIndex.files) {
      if (file.binary) continue;
      nodes.push({ id: file.id, kind: 'file' });
      nodeIds.add(file.id);
    }

    // module nodes
    for (const mod of modules) {
      nodes.push({ id: mod.id, kind: 'module' });
      nodeIds.add(mod.id);
    }

    const edges: GraphEdge[] = [];
    const edgeCounts = new Map<string, number>();

    for (const dep of projectIndex.graphs.dependencyGraph) {
      const fromId = dep.from;
      const toId = dep.to;
      if (!nodeIds.has(fromId)) continue;

      // اگر to یک package باشد، node نمی‌سازیم (external) ولی edge رد نمی‌کنیم؟
      // طبق schema، to باید یک node موجود باشد؛ برای package ها فعلاً skip می‌کنیم.
      if (!nodeIds.has(toId)) continue;

      const key = `${fromId}::${toId}`;
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
    }

    for (const [key, weight] of edgeCounts) {
      const [from, to] = key.split('::');
      edges.push({
        from: from!,
        to: to!,
        kind: 'imports',
        weight,
      });
    }

    return { nodes, edges };
  }

  private deriveModuleDependencies(
    modules: ModuleEntry[],
    dependencyGraph: BlueprintDependencyGraph
  ): Map<string, string[]> {
    const fileIdToModuleId = new Map<string, string>();
    for (const mod of modules) {
      for (const fileId of mod.fileIds) {
        fileIdToModuleId.set(fileId, mod.id);
      }
    }

    const deps = new Map<string, Set<string>>();
    for (const edge of dependencyGraph.edges) {
      const fromMod = fileIdToModuleId.get(edge.from);
      const toMod = fileIdToModuleId.get(edge.to);
      if (!fromMod || !toMod) continue;
      if (fromMod === toMod) continue;

      const set = deps.get(fromMod) ?? new Set<string>();
      set.add(toMod);
      deps.set(fromMod, set);
    }

    const result = new Map<string, string[]>();
    for (const [modId, set] of deps) {
      result.set(modId, Array.from(set).sort());
    }
    return result;
  }

  private buildArchitectureOverview(modules: ModuleEntry[]): ArchitectureOverview {
    const dataFlow: DataFlowEdge[] = [];

    for (const mod of modules) {
      for (const dep of mod.dependsOnModuleIds ?? []) {
        dataFlow.push({
          from: mod.id,
          to: dep,
          description: `${mod.name} depends on ${dep}`,
        });
      }
    }

    return {
      layers: this.buildLayers(modules),
      dataFlow,
    };
  }

  /**
   * لایه‌ها از ساختار پوشه — SE-BP-02.
   *
   * تطابق روی **قطعه‌های** مسیر است نه زیررشته، به همان دلیلی که
   * SE-VEC-11 و SE-BP-05 توضیح دادند: `src/models` قطعهٔ `model` دارد
   * ولی `src/remodeling` ندارد.
   *
   * ماژولی که با هیچ الگویی نخواند، در هیچ لایه‌ای قرار نمی‌گیرد. یک
   * لایهٔ «other» که همه چیز را جمع کند، اطلاعاتی حمل نمی‌کند و فقط
   * وانمود می‌کند معماری کشف شده.
   */
  private buildLayers(modules: ModuleEntry[]): ArchitectureLayer[] {
    const byLayer = new Map<string, string[]>();

    for (const mod of modules) {
      const segments = new Set(
        mod.path
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter(Boolean)
      );
      // نامِ ماژول هم یک قطعه است؛ `src/api` باید با «api» بخورد.
      for (const part of mod.name.toLowerCase().split(/[^a-z0-9]+/)) {
        if (part) segments.add(part);
      }

      for (const layer of ARCHITECTURE_LAYERS) {
        if (!layer.patterns.some(pattern => matchesSegment(pattern, segments))) continue;
        const list = byLayer.get(layer.name) ?? [];
        list.push(mod.id);
        byLayer.set(layer.name, list);
        break; // اولین تطابق برنده است — هیچ ماژولی در دو لایه نیست.
      }
    }

    return ARCHITECTURE_LAYERS.filter(layer => byLayer.has(layer.name)).map(layer => ({
      name: layer.name,
      responsibility: layer.responsibility,
      moduleIds: (byLayer.get(layer.name) ?? []).sort(),
      derivedFrom: 'heuristic' as const,
    }));
  }

  private buildSymbolIndex(
    symbols: readonly SymbolEntry[],
    files: readonly FileEntry[]
  ): BlueprintSymbolIndexEntry[] {
    const aiScoreByFile = new Map(
      files.map(f => [f.id, f.aiMetadata?.aiScore?.importance])
    );

    return symbols.map(sym => {
      let importance = aiScoreByFile.get(sym.fileId) ?? 50;
      importance += (sym.referenceCount ?? 0) * 8;
      importance += (sym.complexity ?? 0) * 2;
      importance = Math.min(100, Math.max(0, Math.floor(importance)));

      return {
        id: sym.id,
        name: sym.name,
        kind: sym.kind,
        fileId: sym.fileId,
        line: sym.line,
        signature: sym.signature ?? null,
        importanceScore: importance,
      };
    });
  }

  private buildTechnicalConstraints(projectIndex: ProjectIndex): TechnicalConstraint[] {
    const constraints: TechnicalConstraint[] = [
      {
        id: 'tc-layered-architecture',
        pattern: 'Layered Architecture',
        description: 'Modules should respect directory-level separation of concerns (services, controllers, repositories, etc.).',
        enforcement: 'code-review',
      },
      {
        id: 'tc-no-circular-dependencies',
        pattern: 'No Circular Dependencies',
        description: 'File-level import cycles should be avoided to keep coupling low.',
        enforcement: 'ci-check',
      },
    ];

    /*
    | SE-BP-03 — تشخیص واقعیِ حلقه.
    |
    | جای این حلقه قبلاً کدِ مرده بود: روی فایل‌ها می‌چرخید و تنها
    | دستور مؤثرش `continue` بود، پس `violatingFileIds` هرگز پر
    | نمی‌شد. و قانونِ «No Circular Dependencies» اعلام می‌شد بی‌آنکه
    | هیچ حلقه‌ای تشخیص داده شود — با اینکه گراف کامل در دسترس بود.
    */
    const cyclic = this.filesInCycles(projectIndex);
    if (cyclic.length > 0) {
      constraints[1] = { ...constraints[1]!, violatingFileIds: cyclic };
    }

    return constraints;
  }

  /**
   * فایل‌هایی که در دست‌کم یک حلقهٔ import هستند.
   *
   * الگوریتم Tarjan برای مؤلفه‌های قویاً همبند: هر مؤلفه با بیش از
   * یک عضو یک حلقه است، و یک عضو با یالِ به‌خودش هم.
   *
   * فقط یال‌هایی شمرده می‌شوند که **هر دو سرشان فایلِ واقعی** باشد؛
   * یال به یک پکیج خارجی حلقه نمی‌سازد چون آن سر، گرهی در پروژه
   * نیست.
   */
  private filesInCycles(projectIndex: ProjectIndex): string[] {
    const fileIds = new Set(projectIndex.files.map(f => f.id));
    const out = new Map<string, string[]>();

    for (const edge of projectIndex.graphs.dependencyGraph) {
      if (!fileIds.has(edge.from) || !fileIds.has(edge.to)) continue;
      const list = out.get(edge.from) ?? [];
      list.push(edge.to);
      out.set(edge.from, list);
    }

    let counter = 0;
    const indexOf = new Map<string, number>();
    const lowLink = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const inCycle = new Set<string>();

    /*
    | پیمایش صریح با پشته، نه بازگشتی. روی مخزنی با هزاران فایل،
    | Tarjan بازگشتی به سقفِ پشتهٔ Node می‌خورد — همان درسی که فاز
    | ۳۹ دربارهٔ پیمایش گراف گرفت.
    */
    for (const start of fileIds) {
      if (indexOf.has(start)) continue;

      const work: { node: string; edge: number }[] = [{ node: start, edge: 0 }];
      indexOf.set(start, counter);
      lowLink.set(start, counter);
      counter++;
      stack.push(start);
      onStack.add(start);

      while (work.length > 0) {
        const frame = work[work.length - 1]!;
        const neighbours = out.get(frame.node) ?? [];

        if (frame.edge < neighbours.length) {
          const next = neighbours[frame.edge]!;
          frame.edge++;

          if (next === frame.node) {
            inCycle.add(next); // یال به خودش
            continue;
          }

          if (!indexOf.has(next)) {
            indexOf.set(next, counter);
            lowLink.set(next, counter);
            counter++;
            stack.push(next);
            onStack.add(next);
            work.push({ node: next, edge: 0 });
          } else if (onStack.has(next)) {
            lowLink.set(frame.node, Math.min(lowLink.get(frame.node)!, indexOf.get(next)!));
          }
          continue;
        }

        work.pop();
        const parent = work[work.length - 1];
        if (parent) {
          lowLink.set(parent.node, Math.min(lowLink.get(parent.node)!, lowLink.get(frame.node)!));
        }

        if (lowLink.get(frame.node) === indexOf.get(frame.node)) {
          const component: string[] = [];
          for (;;) {
            const popped = stack.pop()!;
            onStack.delete(popped);
            component.push(popped);
            if (popped === frame.node) break;
          }
          if (component.length > 1) for (const id of component) inCycle.add(id);
        }
      }
    }

    return [...inCycle].sort();
  }
}
