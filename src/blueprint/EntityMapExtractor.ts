/**
 * EntityMapExtractor و WorkflowExtractor — دو بخشِ باقی‌ماندهٔ
 * SE-BP-02، که پیش‌نیازِ گرافِ چندلایه‌اند (GAP-09).
 *
 * فاز ۴۶ `apiMap` و `layers` را ساخت. این دو باقی مانده بودند:
 *
 * ```js
 * entityTechnicalMapping: [],   // فاز ۷
 * workflowExecutionMap: [],     // فاز ۷
 * ```
 *
 * GAP-09 صریح گفته بود «بدون `apiMap` و `workflowExecutionMap`،
 * لایه‌های بالای گراف گرهی ندارند». پس تا این دو ساخته نشوند، گرافِ
 * چندلایه فقط یک ایده است.
 *
 * ## هر دو قطعی‌اند، نه استنتاجی
 *
 * **Entity** از نمادهایی می‌آید که ساختارِ داده تعریف می‌کنند
 * (`class`, `interface`, `type-alias`) و در فایلی با نقشِ `model`
 * نشسته‌اند یا دکوراتورِ ORM دارند. هیچ حدسی دربارهٔ «مفهومِ
 * کسب‌وکار» زده نمی‌شود.
 *
 * **Workflow** زنجیرهٔ فراخوانی از یک handlerِ API است. یال‌های
 * فراخوانی از قبل در گراف‌اند؛ کاری که اینجا می‌شود مرتب کردنشان به
 * یک دنبالهٔ خطی است.
 */

import {
  ProjectIndex,
  SymbolEntry,
  FileEntry,
  CallEdge,
} from '../core/types/project-index.types';
import { classifyFileRole } from '../core/fileRole';
import { sha256 } from '../core/utils/hash';
import {
  ApiEntry,
  EntityTechnicalMapping,
  EntityField,
  WorkflowExecutionEntry,
  WorkflowStep,
} from '../core/types/blueprint.types';

/** نمادهایی که می‌توانند یک entity باشند. */
const ENTITY_KINDS = new Set(['class', 'interface', 'type-alias', 'struct']);

/** دکوراتورها و پایه‌کلاس‌هایی که یک ORM را لو می‌دهند. */
const ORM_MARKERS: readonly { readonly pattern: RegExp; readonly orm: string }[] = Object.freeze([
  { pattern: /@Entity\b/, orm: 'typeorm' },
  { pattern: /@Table\b/, orm: 'sequelize' },
  { pattern: /extends\s+Model\b/, orm: 'sequelize' },
  { pattern: /@Schema\b/, orm: 'mongoose' },
  { pattern: /extends\s+Document\b/, orm: 'mongoose' },
  { pattern: /@Document\b/, orm: 'mongoose' },
]);

export interface EntityExtractionInput {
  readonly projectIndex: ProjectIndex;
  /** سورسِ فایل، اگر در دسترس باشد — برای تشخیص ORM. */
  readonly sourceOf?: (file: FileEntry) => string | undefined;
}

export class EntityMapExtractor {
  extract(input: EntityExtractionInput): EntityTechnicalMapping[] {
    const { projectIndex, sourceOf } = input;
    const fileById = new Map(projectIndex.files.map(f => [f.id, f]));
    const symbolsByFile = new Map<string, SymbolEntry[]>();

    for (const symbol of projectIndex.symbols) {
      const list = symbolsByFile.get(symbol.fileId) ?? [];
      list.push(symbol);
      symbolsByFile.set(symbol.fileId, list);
    }

    /*
    | SE-BP-10 — نام به‌تنهایی شناسه نیست.
    |
    | روی fixture واقعی سه نمادِ `User` در سه فایل (TypeScript،
    | Kotlin، Swift) وجود دارد و هر سه `entity-User` می‌گرفتند. در
    | گراف چندلایه بدتر می‌شود: هر سه به یک گره نگاشت می‌شوند و آن
    | گره سه یالِ `models` به سه نمادِ متفاوت پیدا می‌کند، پس مسیرِ
    | «از این endpoint به این entity» می‌تواند از فایلی کاملاً
    | بی‌ربط رد شود.
    |
    | همان راه‌حلِ SE-BP-01: نامِ خوانا می‌ماند و فقط وقتی تکراری
    | باشد یک پسوندِ کوتاهِ هش می‌گیرد.
    */
    const nameCounts = new Map<string, number>();
    for (const symbol of projectIndex.symbols) {
      if (!ENTITY_KINDS.has(symbol.kind)) continue;
      nameCounts.set(symbol.name, (nameCounts.get(symbol.name) ?? 0) + 1);
    }

    const out: EntityTechnicalMapping[] = [];

    for (const symbol of projectIndex.symbols) {
      if (!ENTITY_KINDS.has(symbol.kind)) continue;

      const file = fileById.get(symbol.fileId);
      if (!file) continue;

      const source = sourceOf?.(file);
      const orm = source ? detectOrm(source) : null;

      /*
      | یک نماد فقط وقتی entity است که یا در فایلی با نقشِ `model`
      | باشد، یا نشانهٔ صریحِ ORM داشته باشد. بدون این شرط، هر
      | interfaceی در پروژه یک «موجودیت کسب‌وکار» می‌شد — همان
      | اشتباهی که SE-BP-05 در سطح ماژول مرتکب می‌شد.
      */
      /*
      | `role` را خودمان حساب می‌کنیم اگر نبود.
      |
      | تکیه بر `file.role` یعنی blueprint فقط وقتی کار می‌کند که
      | ایندکس را `JsonExporter` ساخته باشد. blueprint اما «کاملاً
      | derived» است و باید از هر `ProjectIndex` معتبری بتواند
      | ساخته شود — از جمله یکی که دستی یا با نسخهٔ قدیمی‌تر
      | ساخته شده.
      */
      const role = file.role ?? classifyFileRole(file.path);
      if (role !== 'model' && !orm) continue;

      const ambiguous = (nameCounts.get(symbol.name) ?? 0) > 1;

      out.push({
        conceptualEntityId: ambiguous
          ? `entity-${symbol.name}-${sha256(symbol.id).substring(0, 6)}`
          : `entity-${symbol.name}`,
        symbolId: symbol.id,
        modelName: symbol.name,
        storage: orm ? storageOf(orm) : 'in-memory',
        fields: fieldsOf(symbol, symbolsByFile.get(symbol.fileId) ?? []),
        tableOrCollectionName: source ? tableNameOf(source, symbol.name) : null,
        ormType: orm,
      });
    }

    return out.sort(
      (a, b) =>
        a.modelName.localeCompare(b.modelName) ||
        a.conceptualEntityId.localeCompare(b.conceptualEntityId)
    );
  }
}

/**
 * `storage` از روی ORM.
 *
 * وقتی ORM ناشناخته است `in-memory` گفته می‌شود، نه `sql`. حدس زدنِ
 * «حتماً پایگاه‌داده است» برای یک interfaceِ ساده، همان جنس ادعایی
 * است که این فاز می‌خواهد از آن پرهیز کند.
 */
function storageOf(orm: string): EntityTechnicalMapping['storage'] {
  if (orm === 'mongoose') return 'nosql';
  if (orm === 'typeorm' || orm === 'sequelize') return 'sql';
  return 'in-memory';
}

function detectOrm(source: string): string | null {
  for (const marker of ORM_MARKERS) {
    if (marker.pattern.test(source)) return marker.orm;
  }
  return null;
}

function tableNameOf(source: string, modelName: string): string | null {
  const explicit =
    /@Entity\s*\(\s*['"]([^'"]+)['"]/.exec(source) ??
    /@Table\s*\(\s*\{[^}]*tableName\s*:\s*['"]([^'"]+)['"]/.exec(source) ??
    /@Schema\s*\(\s*\{[^}]*collection\s*:\s*['"]([^'"]+)['"]/.exec(source);

  return explicit?.[1] ?? (modelName ? null : null);
}

/**
 * فیلدهای یک entity از نمادهای فرزندش.
 *
 * فقط چیزی که در ایندکس هست گزارش می‌شود. `nullable` از `?` در امضا
 * می‌آید و `isPrimaryKey` از نامِ متعارف — هر دو محدود و قابل بازرسی.
 */
function fieldsOf(entity: SymbolEntry, siblings: readonly SymbolEntry[]): EntityField[] {
  const children = siblings.filter(
    s => s.parentId === entity.id && (s.kind === 'property' || s.kind === 'variable')
  );

  return children
    .map(child => ({
      name: child.name,
      type: child.returnType ?? 'unknown',
      nullable: child.signature?.includes('?') ?? false,
      isPrimaryKey: /^(id|_id|uuid)$/i.test(child.name),
      references: null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface WorkflowExtractionInput {
  readonly projectIndex: ProjectIndex;
  readonly apiMap: readonly ApiEntry[];
  /** سقفِ طولِ زنجیره. پیش‌فرض ۲۰. */
  readonly maxSteps?: number;
}

export class WorkflowExtractor {
  /**
   * یک workflow به‌ازای هر مسیرِ API که handlerش شناخته شده.
   *
   * مسیری که handlerش یک تابعِ درجاست، workflow نمی‌سازد: هیچ
   * نمادی برای شروع زنجیره نیست و ساختنِ یک workflowِ تک‌مرحله‌ایِ
   * تهی، فقط نویز است.
   */
  extract(input: WorkflowExtractionInput): WorkflowExecutionEntry[] {
    const { projectIndex, apiMap } = input;
    const maxSteps = input.maxSteps ?? 20;

    const callsFrom = new Map<string, CallEdge[]>();
    for (const edge of projectIndex.graphs?.callGraph ?? []) {
      const list = callsFrom.get(edge.caller) ?? [];
      list.push(edge);
      callsFrom.set(edge.caller, list);
    }

    const out: WorkflowExecutionEntry[] = [];

    for (const api of apiMap) {
      if (!api.handlerSymbolId) continue;

      const steps: WorkflowStep[] = [];
      const seen = new Set<string>();
      let current: string | undefined = api.handlerSymbolId;

      while (current && steps.length < maxSteps && !seen.has(current)) {
        seen.add(current);
        steps.push({ symbolId: current, order: steps.length, condition: null });

        /*
        | زنجیره خطی است: در هر گام پرمطمئن‌ترین فراخوانی دنبال
        | می‌شود. یک workflow یک *روایت* است، نه کل زیرگراف — آن
        | یکی کارِ `subgraph` است (فاز ۴۱).
        |
        | ترتیب با شناسه شکسته می‌شود تا نتیجه دترمینیستیک بماند.
        */
        const candidates: CallEdge[] = (callsFrom.get(current) ?? []).slice();
        candidates.sort(
          (a, b) =>
            (b.provenance?.confidence ?? 0) - (a.provenance?.confidence ?? 0) ||
            a.callee.localeCompare(b.callee)
        );

        const next: CallEdge | undefined = candidates[0];
        current = next ? next.callee : undefined;
      }

      if (steps.length < 2) continue;

      out.push({ workflowId: `wf-${api.method}-${api.path}`, steps });
    }

    return out.sort((a, b) => a.workflowId.localeCompare(b.workflowId));
  }
}
