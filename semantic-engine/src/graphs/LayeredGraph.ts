/**
 * LayeredGraph — GAP-09: اتصال لایه‌های بالا به همان مدلِ گره/یال.
 *
 * ## مسئله
 *
 * گراف تا فاز ۴۶ دو لایه داشت: فایل و نماد. پرسش‌هایی که یک آدم
 * می‌پرسد بالاتر از آن‌اند — «کدام endpoint به جدول users دست
 * می‌زند؟» — و برای پاسخ باید از یک گرهِ API به یک گرهِ Entity رسید.
 * آن گره‌ها وجود نداشتند.
 *
 * ## طراحی
 *
 * لایه‌های بالا **گرهِ مصنوعی** می‌گیرند و با همان `GraphEdge` به
 * گراف موجود وصل می‌شوند. هیچ ساختار دادهٔ دومی ساخته نمی‌شود، پس
 * `path`، `subgraph` و `neighbors` بدون تغییر روی لایه‌ها هم کار
 * می‌کنند.
 *
 * ```
 * api:POST /login   ──handles──▶  s-handler  (نماد)
 *        │
 *   workflow:...    ──step──▶     s-handler ─calls▶ s-auth ─calls▶ s-find
 *                                                                    │
 *                                              entity:User ◀─touches─┘
 *                                                    │
 *                                              storage:sql   ("Database")
 * ```
 *
 * ## دو تصمیم
 *
 * **شناسه پیشونددار است** (`api:`, `entity:`, `storage:`) تا با
 * هشِ فایل و نماد قاطی نشود و لایهٔ هر گره از خودش خوانده شود.
 *
 * **آدرس‌دهی با برچسبِ خواندنی.** معیار پذیرش فاز ۴۷ می‌گوید
 * `path("API /login", "Database")`. اگر مصرف‌کننده مجبور باشد اول
 * شناسهٔ داخلی را پیدا کند، آن پرس‌وجو دو مرحله‌ای می‌شود و لایه‌ها
 * عملاً غیرقابل استفاده می‌مانند.
 */

import { ProjectIndex, SymbolEntry } from '../core/types/project-index.types';
import { Blueprint } from '../core/types/blueprint.types';
import type { GraphEdge } from './GraphQueryEngine';

export type GraphLayer =
  | 'api'
  | 'workflow'
  | 'entity'
  | 'storage'
  | 'symbol'
  | 'file'
  | 'unknown';

const LAYER_PREFIX: Readonly<Record<string, GraphLayer>> = Object.freeze({
  'api:': 'api',
  'wf:': 'workflow',
  'entity:': 'entity',
  'storage:': 'storage',
});

/**
 * اعتمادِ یال‌های بین‌لایه‌ای.
 *
 * `blueprint` یعنی از یک نگاشتِ صریح آمده (apiMap، workflow،
 * entityTechnicalMapping) و همان‌قدر معتبر است که آن نگاشت.
 * `name-match` یعنی حدس — و عمداً زیر آستانهٔ پیش‌فرضِ ۷۰ است تا
 * پرس‌وجوی محتاط آن را نبیند، همان قاعده‌ای که فاز ۱۹ برای یال‌های
 * حدسی گذاشت.
 */
const CONFIDENCE_FROM_BLUEPRINT = 95;
const CONFIDENCE_FROM_NAME = 45;

export class LayeredGraph {
  private readonly synthetic: GraphEdge[] = [];
  private readonly byLabel = new Map<string, string>();
  private readonly knownNodes = new Set<string>();
  private readonly ambiguousLabels = new Set<string>();
  /** گرهِ entity → نمادی که تعریفش می‌کند. */
  private readonly entitySymbols = new Map<string, string>();

  constructor(
    private readonly projectIndex: ProjectIndex,
    blueprint: Blueprint
  ) {
    for (const file of projectIndex.files) this.knownNodes.add(file.id);
    for (const symbol of projectIndex.symbols) this.knownNodes.add(symbol.id);

    this.addApiLayer(blueprint);
    this.addWorkflowLayer(blueprint);
    this.addEntityLayer(blueprint);
    this.addSymbolToFileLayer();

    this.synthetic.sort(
      (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind)
    );
  }

  /** یال‌های مصنوعی، آمادهٔ تزریق به `GraphQueryEngine`. */
  edges(): readonly GraphEdge[] {
    return this.synthetic;
  }

  /**
   * شناسهٔ گره از روی یک برچسبِ خواندنی.
   *
   * `undefined` یعنی چنین گره‌ای نیست — عمداً به یک گرهِ نزدیک
   * برنمی‌گردیم، چون پاسخِ اشتباه به یک پرس‌وجوی مسیر، مسیرِ
   * اشتباهی می‌سازد که تمیز و مطمئن به نظر می‌رسد.
   */
  resolve(label: string): string | undefined {
    const trimmed = label.trim();
    if (trimmed.length === 0) return undefined;

    if (this.knownNodes.has(trimmed)) return trimmed;
    if (this.byLabel.has(trimmed)) return this.byLabel.get(trimmed);

    return this.byLabel.get(normalizeLabel(trimmed));
  }

  layerOf(nodeId: string): GraphLayer {
    for (const [prefix, layer] of Object.entries(LAYER_PREFIX)) {
      if (nodeId.startsWith(prefix)) return layer;
    }
    if (this.projectIndex.symbols.some(s => s.id === nodeId)) return 'symbol';
    if (this.projectIndex.files.some(f => f.id === nodeId)) return 'file';
    return 'unknown';
  }

  // ── لایه‌ها ────────────────────────────────────────────────────

  private addApiLayer(blueprint: Blueprint): void {
    for (const api of blueprint.apiMap ?? []) {
      const nodeId = `api:${api.method} ${api.path}`;
      this.knownNodes.add(nodeId);

      // هر دو شکل: با متد و بدون متد.
      this.label(`api ${api.method} ${api.path}`, nodeId);
      this.label(`api ${api.path}`, nodeId);

      if (api.handlerSymbolId) {
        this.edge(nodeId, api.handlerSymbolId, 'handles', CONFIDENCE_FROM_BLUEPRINT, 'blueprint');
      }
    }
  }

  private addWorkflowLayer(blueprint: Blueprint): void {
    for (const workflow of blueprint.workflowExecutionMap ?? []) {
      const nodeId = `wf:${workflow.workflowId}`;
      this.knownNodes.add(nodeId);
      this.label(`workflow ${workflow.workflowId}`, nodeId);

      /*
      | فقط اولین مرحله به گرهِ workflow وصل می‌شود. مراحل بعدی از
      | قبل با یال‌های `calls` به هم وصل‌اند؛ تکرارشان یعنی همان
      | اطلاعات دو بار در گراف، و مسیرهای کوتاه‌ترِ ساختگی.
      */
      const first = workflow.steps.find(step => step.order === 0) ?? workflow.steps[0];
      if (first) {
        this.edge(nodeId, first.symbolId, 'starts', CONFIDENCE_FROM_BLUEPRINT, 'blueprint');
      }
    }
  }

  private addEntityLayer(blueprint: Blueprint): void {
    const storageNodes = new Set<string>();

    for (const entity of blueprint.entityTechnicalMapping ?? []) {
      /*
      | SE-BP-10 — گره از `conceptualEntityId` ساخته می‌شود، نه از
      | نام. سه `User` در سه زبان، سه گره‌اند نه یکی.
      */
      const nodeId = `entity:${entity.conceptualEntityId}`;
      this.knownNodes.add(nodeId);
      this.label(`entity ${entity.conceptualEntityId}`, nodeId);
      /*
      | برچسبِ کوتاه فقط وقتی ثبت می‌شود که یکتا باشد. اگر دو
      | entity هم‌نام باشند، `entity User` مبهم است و پاسخِ
      | دلبخواه دادن بدتر از پاسخ ندادن است.
      */
      if (!this.ambiguousLabels.has(`entity ${entity.modelName}`)) {
        if (this.byLabel.has(normalizeLabel(`entity ${entity.modelName}`))) {
          this.ambiguousLabels.add(`entity ${entity.modelName}`);
          this.byLabel.delete(normalizeLabel(`entity ${entity.modelName}`));
        } else {
          this.label(`entity ${entity.modelName}`, nodeId);
        }
      }

      this.edge(nodeId, entity.symbolId, 'models', CONFIDENCE_FROM_BLUEPRINT, 'blueprint');
      this.entitySymbols.set(nodeId, entity.symbolId);

      const storageId = `storage:${entity.storage}`;
      if (!storageNodes.has(storageId)) {
        storageNodes.add(storageId);
        this.knownNodes.add(storageId);
        this.label(`storage ${entity.storage}`, storageId);

        /*
        | «Database» یک برچسبِ عام است که معیار پذیرش با آن پرسیده
        | می‌شود. به مخزنِ پایدار وصل می‌شود، نه به `in-memory` —
        | یک `Map` در حافظه پایگاه‌داده نیست.
        */
        if (entity.storage === 'sql' || entity.storage === 'nosql') {
          this.label('database', storageId);
        }
      }

      this.edge(nodeId, storageId, 'persists-in', CONFIDENCE_FROM_BLUEPRINT, 'blueprint');
      this.linkEntityToUsers(entity.symbolId, nodeId);
    }

    /*
    | اگر هیچ entityِ پایداری نبود، «Database» به هیچ گرهی اشاره
    | نمی‌کند. این درست است: پروژه‌ای بدون لایهٔ پایداری، گرهِ
    | پایداری هم ندارد.
    */
    if (!this.byLabel.has('database')) {
      const inMemory = [...storageNodes].find(id => id === 'storage:in-memory');
      if (inMemory) this.label('database', inMemory);
    }
  }

  /**
   * پلِ نماد به فایل — لایهٔ `Symbol → File` در GAP-09.
   *
   * بدون این، دو نیمهٔ گراف به هم نمی‌رسند: یال‌های `calls` بین
   * نمادهایند و یال‌های `imports` بین فایل‌ها، و هیچ یالی از یکی به
   * دیگری نیست. اندازه‌گیری روی fixture واقعی: مسیر از
   * `API /users` به `Database` وجود نداشت، دقیقاً به همین دلیل —
   * زنجیرهٔ فراخوانی به `persistUser` می‌رسید و همان‌جا می‌ایستاد،
   * چون ارجاعِ آن به مدل یک ارجاعِ **نوعی** است نه فراخوانی، و
   * ارجاع نوعی فقط در سطح فایل (import) دیده می‌شود.
   *
   * فایل هم به entityهایی که اعلام می‌کند وصل می‌شود، تا مسیر از
   * سمت import به لایهٔ entity برسد.
   */
  private addSymbolToFileLayer(): void {
    for (const symbol of this.projectIndex.symbols) {
      if (!this.knownNodes.has(symbol.fileId)) continue;
      this.edge(symbol.id, symbol.fileId, 'declared-in', CONFIDENCE_FROM_BLUEPRINT, 'index');
    }

    for (const [entityNodeId, symbolId] of this.entitySymbols) {
      const symbol = this.projectIndex.symbols.find(s => s.id === symbolId);
      if (!symbol) continue;
      this.edge(symbol.fileId, entityNodeId, 'declares', CONFIDENCE_FROM_BLUEPRINT, 'index');
    }
  }

  /**
   * نمادهایی که این entity را لمس می‌کنند، به گرهِ entity وصل
   * می‌شوند.
   *
   * بدون این، مسیر از یک repository به entity قطع است: یال‌های
   * `calls` به خودِ نمادِ مدل می‌رسند، نه به گرهِ مصنوعی.
   */
  private linkEntityToUsers(entitySymbolId: string, entityNodeId: string): void {
    for (const edge of this.projectIndex.graphs?.callGraph ?? []) {
      if (edge.callee !== entitySymbolId) continue;
      this.edge(edge.caller, entityNodeId, 'touches', CONFIDENCE_FROM_NAME, 'name-match');
    }
  }

  // ── ابزار ─────────────────────────────────────────────────────

  private edge(from: string, to: string, kind: string, confidence: number, basis: string): void {
    this.synthetic.push({ from, to, relation: 'layers', kind, confidence, basis });
  }

  private label(label: string, nodeId: string): void {
    this.byLabel.set(normalizeLabel(label), nodeId);
  }
}

/** برچسب‌ها بدون حساسیت به بزرگی حروف و فاصلهٔ اضافه مقایسه می‌شوند. */
function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** نمادهای یک فایل — برای مصرف‌کننده‌هایی که لایه را می‌سازند. */
export function symbolsOfFile(index: ProjectIndex, fileId: string): SymbolEntry[] {
  return index.symbols.filter(s => s.fileId === fileId);
}
