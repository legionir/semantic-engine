/**
 * InteractiveOps — عملیات تک‌درخواستی برای لایهٔ عامل — LSP-16.
 *
 * سند LSP در بخش ۴.۰ دو حالت مصرف را از هم جدا کرد و این فایل نیمهٔ
 * دوم است:
 *
 * ```
 *              Batch (فازهای ۳۳ و ۳۴)      Interactive (این فاز)
 * محرک        اجرای index یا watch         یک تماس ابزار از سوی مدل
 * واحد کار    هزاران فایل                  یک فایل، یک موقعیت
 * بودجه       لازم — ۳۶× کندتر             ندارد؛ سرور از قبل گرم است
 * خروجی       در ایندکس ذخیره می‌شود        مستقیم به مدل
 * ```
 *
 * تفاوت عملی‌اش این است که اینجا **بودجه معنی ندارد**: یک
 * `textDocument/diagnostic` روی سرور گرم ۴ میلی‌ثانیه طول می‌کشد و
 * جایگزینش (اجرای `tsc`) ثانیه‌ها. کندی مسئلهٔ حالت انبوه بود، نه
 * این حالت. سررسید هست — ولی به‌عنوان محافظ، نه سهمیه.
 *
 * ── چرا خروجی، شکل LSP نیست ────────────────────────────────────────
 *
 * مصرف‌کننده یک مدل زبانی است. `file:///home/user/project/src/a.ts` و
 * `"line": 0` برای آن هم پرحجم است هم گمراه‌کننده (هر ابزار دیگری در
 * این پروژه یک‌مبنا و نسبی جواب می‌دهد). پس مسیرها نسبت به ریشه و
 * شماره‌ها یک‌مبنا برمی‌گردند — همان قراردادی که `ProjectIndex` دارد.
 *
 * ── `dry_run` ──────────────────────────────────────────────────────
 *
 * `rename` و `organizeImports` روی دیسک می‌نویسند. هر دو با
 * `dryRun: true` (پیش‌فرض) فقط **نقشه** برمی‌گردانند. نکتهٔ مهم این
 * است که نقشه از همان تابعی می‌آید که اعمال هم از آن می‌گذرد، پس
 * پیش‌نمایش نمی‌تواند با نتیجه واگرا شود.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Diagnostic } from '../core/types/project-index.types';
import { ILogger, silentLogger } from '../host/Logger';
import { LspClient, pathOf } from './LspClient';
import { DiagnosticsProvider } from './DiagnosticsProvider';
import { LspSymbolKind } from '../symbols/types';
import {
  PlannedFileEdit,
  WorkspaceEditError,
  WorkspaceEditLike,
  applyEditPlan,
  planWorkspaceEdit,
} from './WorkspaceEdit';

/** موقعیت یک‌مبنا — همان قراردادی که کل ایندکس دارد. */
export interface SourcePosition {
  readonly line: number;
  readonly column?: number;
}

export interface SourceLocation {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
}

export interface IncomingCall {
  /** نام فراخوان — یا نام فایل، وقتی فراخوانی در سطح ماژول است. */
  readonly caller: string;
  readonly kind: string;
  readonly from: SourceLocation;
  /** جای دقیق هر فراخوانی داخل فراخوان. */
  readonly callSites: readonly SourceLocation[];
}

export interface EditPreview {
  readonly path: string;
  readonly editCount: number;
  /** فقط در حالت `dryRun`. متن کامل فایل پس از تغییر. */
  readonly after?: string;
}

export interface EditOutcome {
  readonly ok: boolean;
  readonly dryRun: boolean;
  readonly files: readonly EditPreview[];
  readonly totalEdits: number;
  /** فایل‌هایی که واقعاً نوشته شدند. در `dryRun` همیشه خالی. */
  readonly written: readonly string[];
  readonly message?: string;
}

export interface InteractiveOpsOptions {
  readonly acquire: (languageId: string) => Promise<LspClient | null>;
  readonly rootPath: string;
  readonly logger?: ILogger;
  /** محافظ، نه سهمیه. */
  readonly timeoutMs?: number;
  /** برای تست؛ پیش‌فرض یک `DiagnosticsProvider` روی همان `acquire`. */
  readonly diagnostics?: DiagnosticsProvider;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class LspOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LspOperationError';
  }
}

export class InteractiveOps {
  private readonly logger: ILogger;
  private readonly diagnosticsProvider: DiagnosticsProvider;

  constructor(private readonly options: InteractiveOpsOptions) {
    this.logger = (options.logger ?? silentLogger).child('lsp:ops');
    this.diagnosticsProvider =
      options.diagnostics ??
      new DiagnosticsProvider({ acquire: options.acquire, logger: options.logger });
  }

  /** خطاهای یک فایل. همان مسیر فاز ۳۴، بدون بودجه. */
  async diagnostics(
    filePath: string,
    languageId: string,
    content?: string
  ): Promise<readonly Diagnostic[]> {
    const absolute = this.absolute(filePath);
    const text = content ?? readFile(absolute);
    return this.diagnosticsProvider.diagnosticsFor(absolute, languageId, text, '');
  }

  /** «این کجا تعریف شده؟» */
  async definition(
    filePath: string,
    languageId: string,
    position: SourcePosition,
    content?: string
  ): Promise<readonly SourceLocation[]> {
    const result = await this.withOpenDocument(filePath, languageId, content, (client, absolute) =>
      client.request<unknown>(
        'textDocument/definition',
        {
          textDocument: { uri: client.uriFor(absolute) },
          position: toLspPosition(position),
        },
        { timeoutMs: this.timeout() }
      )
    );
    return this.toLocations(result);
  }

  /**
   * «چه کسی این را صدا می‌زند؟»
   *
   * این همان جوابی است که `CallGraphBuilder` امروز حدس می‌زند
   * (SE-GRAPH-03: fallback سراسری `findByName` هر `log()` را به یک
   * symbol بی‌ربط وصل می‌کند). اینجا جواب از خود کامپایلر می‌آید.
   * جایگزینی گراف، کار فاز ۳۷ است؛ این فقط ابزار تک‌درخواستی است.
   */
  async incomingCalls(
    filePath: string,
    languageId: string,
    position: SourcePosition,
    content?: string
  ): Promise<readonly IncomingCall[]> {
    return this.withOpenDocument(filePath, languageId, content, async (client, absolute) => {
      const prepared = await client.request<CallHierarchyItem[] | null>(
        'textDocument/prepareCallHierarchy',
        {
          textDocument: { uri: client.uriFor(absolute) },
          position: toLspPosition(position),
        },
        { timeoutMs: this.timeout() }
      );

      if (!prepared || prepared.length === 0) {
        /*
        | «اینجا چیزی نیست که صدا زده شود» — مثلاً یک `const`. این
        | خطا نیست؛ فهرست خالی است. (SE-LSP-09 همین را از سمت
        | کاوش قابلیت نشان داد.)
        */
        return [];
      }

      const calls = await client.request<IncomingCallResult[] | null>(
        'callHierarchy/incomingCalls',
        { item: prepared[0] },
        { timeoutMs: this.timeout() }
      );

      return (calls ?? []).map(call => this.toIncomingCall(call));
    });
  }

  /**
   * تغییر نام در سطح workspace.
   *
   * پیش‌فرض `dryRun: true` است. نوشتن روی فایل کاربر باید یک تصمیم
   * صریح باشد، نه پیش‌فرضِ فراموش‌شدنی.
   */
  async rename(
    filePath: string,
    languageId: string,
    position: SourcePosition,
    newName: string,
    options: { dryRun?: boolean; content?: string } = {}
  ): Promise<EditOutcome> {
    if (!isPlausibleIdentifier(newName)) {
      throw new LspOperationError(`"${newName}" does not look like an identifier`);
    }

    const edit = await this.withOpenDocument(
      filePath,
      languageId,
      options.content,
      (client, absolute) =>
        client.request<WorkspaceEditLike | null>(
          'textDocument/rename',
          {
            textDocument: { uri: client.uriFor(absolute) },
            position: toLspPosition(position),
            newName,
          },
          { timeoutMs: this.timeout() }
        )
    );

    return this.applyOrPreview(edit, options.dryRun !== false, 'rename');
  }

  /** مرتب کردن importهای یک فایل، از خود سرور. */
  async organizeImports(
    filePath: string,
    languageId: string,
    options: { dryRun?: boolean; content?: string } = {}
  ): Promise<EditOutcome> {
    const actions = await this.withOpenDocument(
      filePath,
      languageId,
      options.content,
      (client, absolute) =>
        client.request<CodeAction[] | null>(
          'textDocument/codeAction',
          {
            textDocument: { uri: client.uriFor(absolute) },
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            context: { diagnostics: [], only: ['source.organizeImports'] },
          },
          { timeoutMs: this.timeout() }
        )
    );

    const action = (actions ?? []).find(candidate => candidate?.edit);
    if (!action) {
      /*
      | فاز ۳۳ نشان داد `codeActionProvider` اعلام‌شده لزوماً برای
      | هر `only` نتیجه ندارد (`quickfix` همیشه خالی بود). نبودِ
      | اقدام یک نتیجهٔ معتبر است، نه خطا.
      */
      return {
        ok: true,
        dryRun: options.dryRun !== false,
        files: [],
        totalEdits: 0,
        written: [],
        message: 'the server offered no organize-imports action for this file',
      };
    }

    return this.applyOrPreview(action.edit ?? null, options.dryRun !== false, 'organizeImports');
  }

  dispose(): void {
    this.diagnosticsProvider.dispose();
  }

  // ── درون ────────────────────────────────────────────────────────────

  private timeout(): number {
    return this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private absolute(filePath: string): string {
    return path.isAbsolute(filePath) ? filePath : path.join(this.options.rootPath, filePath);
  }

  private relative(filePath: string): string {
    const relative = path.relative(this.options.rootPath, filePath);
    return relative && !relative.startsWith('..') ? relative : filePath;
  }

  private async withOpenDocument<T>(
    filePath: string,
    languageId: string,
    content: string | undefined,
    run: (client: LspClient, absolute: string) => Promise<T>
  ): Promise<T> {
    const client = await this.options.acquire(languageId);
    if (!client || !client.isRunning) {
      throw new LspOperationError(`no language server is available for ${languageId}`);
    }
    const absolute = this.absolute(filePath);
    return client.withDocument(absolute, languageId, () => run(client, absolute), content);
  }

  private async applyOrPreview(
    edit: WorkspaceEditLike | null,
    dryRun: boolean,
    operation: string
  ): Promise<EditOutcome> {
    if (!edit || (!edit.changes && !edit.documentChanges)) {
      return {
        ok: true,
        dryRun,
        files: [],
        totalEdits: 0,
        written: [],
        message: `${operation} produced no changes`,
      };
    }

    let plan;
    try {
      plan = planWorkspaceEdit(edit, { rootPath: this.options.rootPath });
    } catch (error) {
      if (error instanceof WorkspaceEditError) {
        this.logger.warn('refused a workspace edit', { operation, reason: error.message });
        return {
          ok: false,
          dryRun,
          files: [],
          totalEdits: 0,
          written: [],
          message: error.message,
        };
      }
      throw error;
    }

    const files: EditPreview[] = plan.files.map((file: PlannedFileEdit) => ({
      path: file.relativePath,
      editCount: file.editCount,
      ...(dryRun ? { after: file.after } : {}),
    }));

    if (dryRun) {
      return { ok: true, dryRun: true, files, totalEdits: plan.totalEdits, written: [] };
    }

    const written = await applyEditPlan(plan);
    this.logger.info('applied a workspace edit', { operation, files: written.length });
    return { ok: true, dryRun: false, files, totalEdits: plan.totalEdits, written };
  }

  private toLocations(result: unknown): readonly SourceLocation[] {
    if (!result) return [];
    const list = Array.isArray(result) ? result : [result];
    const out: SourceLocation[] = [];

    for (const item of list) {
      /*
      | سه شکل ممکن است بیاید: `Location`، `Location[]`، و
      | `LocationLink[]` (که `targetUri`/`targetRange` دارد). سرورها
      | بسته به قابلیت اعلام‌شدهٔ کلاینت یکی را می‌فرستند.
      */
      const link = item as {
        uri?: string;
        range?: LspRange;
        targetUri?: string;
        targetSelectionRange?: LspRange;
        targetRange?: LspRange;
      };
      const uri = link.uri ?? link.targetUri;
      const range = link.range ?? link.targetSelectionRange ?? link.targetRange;
      if (!uri || !range) continue;
      out.push(this.toLocation(uri, range));
    }
    return out;
  }

  private toLocation(uri: string, range: LspRange): SourceLocation {
    let filePath: string;
    try {
      filePath = this.relative(pathOf(uri));
    } catch {
      filePath = uri;
    }
    return {
      path: filePath,
      line: range.start.line + 1,
      column: range.start.character + 1,
      endLine: range.end.line + 1,
      endColumn: range.end.character + 1,
    };
  }

  private toIncomingCall(call: IncomingCallResult): IncomingCall {
    const from = call.from;
    const location = this.toLocation(from.uri, from.selectionRange ?? from.range);
    /*
    | SE-LSP-13: وقتی فراخوانی در سطح ماژول است، سرور نام آیتم را
    | **مسیر مطلق فایل** می‌گذارد (`kind: 2` یعنی Module). آن مسیر
    | نباید همان‌طور به بیرون برود: هم به ماشین سازنده وابسته است و
    | هم مسیر خانهٔ کاربر را لو می‌دهد.
    */
    const caller =
      from.kind === LspSymbolKind.Module && path.isAbsolute(from.name)
        ? this.relative(from.name)
        : from.name;

    return {
      caller,
      kind: kindName(from.kind),
      from: location,
      callSites: (call.fromRanges ?? []).map(range => this.toLocation(from.uri, range)),
    };
  }
}

// ── تایپ‌های سیم ──────────────────────────────────────────────────────

interface LspRange {
  readonly start: { readonly line: number; readonly character: number };
  readonly end: { readonly line: number; readonly character: number };
}

interface CallHierarchyItem {
  readonly name: string;
  readonly kind: number;
  readonly uri: string;
  readonly range: LspRange;
  readonly selectionRange?: LspRange;
}

interface IncomingCallResult {
  readonly from: CallHierarchyItem;
  readonly fromRanges?: readonly LspRange[];
}

interface CodeAction {
  readonly title?: string;
  readonly kind?: string;
  readonly edit?: WorkspaceEditLike;
}

// ── کمکی ──────────────────────────────────────────────────────────────

function toLspPosition(position: SourcePosition): { line: number; character: number } {
  return {
    line: Math.max(0, position.line - 1),
    character: Math.max(0, (position.column ?? 1) - 1),
  };
}

function kindName(kind: number): string {
  const names: Record<number, string> = {
    [LspSymbolKind.File]: 'file',
    [LspSymbolKind.Module]: 'module',
    [LspSymbolKind.Namespace]: 'namespace',
    [LspSymbolKind.Class]: 'class',
    [LspSymbolKind.Method]: 'method',
    [LspSymbolKind.Property]: 'property',
    [LspSymbolKind.Constructor]: 'constructor',
    [LspSymbolKind.Function]: 'function',
    [LspSymbolKind.Variable]: 'variable',
    [LspSymbolKind.Constant]: 'constant',
    [LspSymbolKind.Interface]: 'interface',
    [LspSymbolKind.Enum]: 'enum',
    [LspSymbolKind.Struct]: 'struct',
  };
  return names[kind] ?? `kind-${kind}`;
}

/**
 * نگهبان سبک روی `newName`.
 *
 * سرور خودش هرچه بدهیم را جای می‌گذارد — از جمله `);  drop()` یا یک
 * خط کامل کد. تشخیص «شناسهٔ معتبر» در همهٔ زبان‌ها ممکن نیست، ولی رد
 * کردن چیزی که آشکارا شناسه نیست (فاصله، پرانتز، خط جدید) جلوی
 * بدترین حالت را می‌گیرد.
 */
export function isPlausibleIdentifier(name: string): boolean {
  return /^[\p{L}\p{Nl}$_][\p{L}\p{Nl}\p{Nd}$_]*$/u.test(name);
}

function readFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}
