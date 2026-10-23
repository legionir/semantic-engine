/**
 * LspClient — یک پروسهٔ زبان‌سرور، یک اتصال JSON-RPC روی stdio.
 *
 * تا فاز ۱۰، «کلاینت LSP» این پروژه یک خواهش از VS Code بود:
 * `executeCommand('vscode.executeDocumentSymbolProvider')`. یعنی
 * ویرایشگر سرور را نصب و spawn و initialize می‌کرد و ما فقط نتیجه را
 * می‌گرفتیم. با حذف VS Code، این مسئولیت به خود ما رسید و این فایل
 * پایین‌ترین لایهٔ آن است: بالا آوردن پروسه، دست‌دادن، و نگه داشتن
 * قرارداد سند.
 *
 * ── چهار چیزی که probe روی `tsgo --lsp --stdio` نشان داد ────────────
 *
 * ۱. **سرور از کلاینت سؤال می‌پرسد و منتظر می‌ماند.** بلافاصله بعد از
 *    `initialize`، `workspace/configuration` (چهار section) و
 *    `client/registerCapability` آمد. اگر جواب ندهیم، سرور معطل
 *    می‌ماند — و چون هیچ خطایی رخ نداده، تشخیصش سخت است.
 *
 * ۲. **خروج تمیز، کد خروج غیرصفر می‌دهد.** پس از `shutdown` و `exit`:
 *
 *    ```
 *    STDERR> "context canceled\n"
 *    EXIT 1 null
 *    ```
 *
 *    کد ۱ اینجا سلامت است، نه کرش. مدیر سرور (فاز ۳۶) اگر این را کرش
 *    بشمارد، بی‌دلیل restart می‌کند.
 *
 * ۳. **متد ناشناخته کد ‎-32600 می‌دهد، نه ‎-32601.** یعنی «پشتیبانی
 *    نمی‌شود» را نمی‌شود از کد خطا نتیجه گرفت.
 *
 * ۴. **کتابخانهٔ JSON-RPC در پرواز را رها نمی‌کند.** در
 *    `vscode-jsonrpc@8`، بسته شدن اتصال فقط یک رویداد `close` می‌فرستد؛
 *    `responsePromises` دست‌نخورده می‌ماند و فقط `dispose()` آن‌ها را
 *    رد می‌کند. یعنی اگر سرور وسط کار بمیرد، هر درخواست در پرواز تا
 *    سررسید timeout خودش معلق می‌ماند — و در طرح اولیهٔ
 *    `LSP-ARCHITECTURE.md` هیچ timeoutای برای بیشتر درخواست‌ها نبود.
 *    اینجا خودمان در پرواز‌ها را نگه می‌داریم و روی مرگ سرور ردشان
 *    می‌کنیم.
 *
 * ── شمارش مرجع سند ─────────────────────────────────────────────────
 *
 * دو مصرف‌کننده (استخراج symbol و لایهٔ ابزار عامل) ممکن است هم‌زمان
 * یک فایل را لازم داشته باشند. `didClose` زودهنگام یعنی دیگری روی سند
 * بسته کار می‌کند؛ `didClose` نزدن یعنی حافظهٔ سرور خطی بالا می‌رود
 * (روی ۱۶۴ فایل، ۸۰۹MB). شمارش مرجع تنها چیزی است که هر دو را
 * هم‌زمان می‌دهد.
 */

import * as cp from 'child_process';
import { pathToFileURL, fileURLToPath } from 'url';
import * as rpc from 'vscode-jsonrpc/node';
import { ILogger, silentLogger } from '../host/Logger';
import { LspClientOptions, LspClientState, LspError, LspExitInfo, LspNotRunningError, RequestOptions } from './LspClientTypes';
import { LspDocumentStore } from './lspDocuments';
import { Pending, RequestContext, sendRequest } from './lspRequest';
import { SpawnedServer, spawnServer, waitForChildExit, killChild } from './lspSpawn';
import { registerClientHandlers } from './lspClientHandlers';
import { buildInitializeParams } from './lspInitializeParams';
import { pipeServerStderr } from './lspProcessIo';
import {
  DocumentSymbolResult,
  InitializeResult,
  PublishDiagnosticsParams,
  ServerCapabilities,
  ServerInfo,
} from './protocol';

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_INITIALIZE_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

// ── کلاینت ────────────────────────────────────────────────────────────

export class LspClient {
  private readonly options: LspClientOptions;
  private readonly logger: ILogger;
  private readonly documents: LspDocumentStore;
  private readonly pending = new Set<Pending>();
  private readonly exitListeners: ((info: LspExitInfo) => void)[] = [];
  private readonly diagnosticsListeners: ((params: PublishDiagnosticsParams) => void)[] = [];
  private readonly notificationListeners = new Map<string, ((params: unknown) => void)[]>();

  private child?: cp.ChildProcess;
  private connection?: rpc.MessageConnection;
  private currentState: LspClientState = 'idle';
  private initializeResult?: InitializeResult;
  private exitReported = false;
  private childExit?: Promise<void>;

  private readonly requestContext: RequestContext;

  constructor(options: LspClientOptions) {
    this.options = options;
    this.requestContext = {
      serverId: options.id,
      pending: this.pending,
      connection: () => this.connection,
      isChannelDead: () => this.isChannelDead(),
      state: () => this.currentState,
    };
    this.logger = (options.logger ?? silentLogger).child(`lsp:${options.id}`);
    this.documents = new LspDocumentStore({
      serverId: options.id,
      assertRunning: what => this.assertRunning(what),
      notify: (method, params) => this.notifyQuietly(method, params),
      isRunning: () => this.currentState === 'running',
    });
    if (options.onExit) this.exitListeners.push(options.onExit);
  }

  get state(): LspClientState {
    return this.currentState;
  }

  get isRunning(): boolean {
    return this.currentState === 'running';
  }

  get processId(): number | undefined {
    return this.child?.pid;
  }

  /**
   * شناسهٔ یکتای این نمونه: سرور × ریشه.
   *
   * یک سرور به‌ازای هر (زبان × workspace) بالا می‌آید، پس کشی که به
   * نتیجهٔ یک سرور خاص وابسته است (مثل کاوش قابلیت فاز ۳۳) باید با
   * همین کلید بشناسدش، نه فقط با `id`.
   */
  get serverKey(): string {
    return `${this.options.id}@${this.options.rootPath}`;
  }

  /** مسیر → URI، با همان تبدیلی که خودِ کلاینت روی سیم می‌فرستد. */
  uriFor(filePath: string): string {
    return uriOf(filePath);
  }

  get capabilities(): ServerCapabilities | undefined {
    return this.initializeResult?.capabilities;
  }

  get serverInfo(): ServerInfo | undefined {
    return this.initializeResult?.serverInfo;
  }

  /** چند سند الان باز است — بدون شمردن بازکردن‌های تکراری. */
  get openDocumentCount(): number {
    return this.documents.size;
  }

  onExit(listener: (info: LspExitInfo) => void): void {
    this.exitListeners.push(listener);
  }

  /**
   * اشتراک در `textDocument/publishDiagnostics`.
   *
   * گزینهٔ `onDiagnostics` سازنده یک شنونده بیشتر نمی‌پذیرد، و از فاز
   * ۳۴ دو مصرف‌کننده وجود دارد (سازنده و `DiagnosticsProvider`).
   */
  onDiagnostics(listener: (params: PublishDiagnosticsParams) => void): void {
    this.diagnosticsListeners.push(listener);
  }

  /**
   * اشتراک در هر اعلان سرور — از `$/progress` تا افزونه‌های مخصوص
   * یک سرور مثل `experimental/serverStatus` در rust-analyzer.
   *
   * بدون این، تشخیص آمادگی (فاز ۳۶) باید یا به `LspClient` وصله
   * می‌خورد یا اعلان‌ها را از دست می‌داد.
   */
  onNotification(method: string, listener: (params: unknown) => void): void {
    const existing = this.notificationListeners.get(method);
    if (existing) existing.push(listener);
    else this.notificationListeners.set(method, [listener]);
  }

  // ── چرخهٔ عمر ───────────────────────────────────────────────────────

  async start(): Promise<InitializeResult> {
    if (this.currentState !== 'idle') {
      throw new LspError(
        `server ${this.options.id} was already started (state: ${this.currentState})`,
        this.options.id
      );
    }
    this.currentState = 'starting';

    let spawned: SpawnedServer;
    try {
      spawned = await spawnServer(this.options, {
        onChild: child => {
          this.child = child;
        },
        onExit: (code, signal) => this.handleExit(code, signal),
      });
    } catch (error) {
      this.currentState = 'stopped';
      this.child = undefined;
      throw error;
    }
    const { child, spawnFailure } = spawned;
    this.childExit = spawned.childExit;

    pipeServerStderr(child, this.logger);

    const connection = rpc.createMessageConnection(
      new rpc.StreamMessageReader(child.stdout!),
      new rpc.StreamMessageWriter(child.stdin!)
    );
    this.connection = connection;
    registerClientHandlers(connection, {
      options: this.options,
      logger: this.logger,
      diagnosticsListeners: this.diagnosticsListeners,
      state: () => this.currentState,
      markCrashed: () => {
        this.currentState = 'crashed';
      },
      dispatchNotification: (method, params) => this.dispatchNotification(method, params),
      rejectPending: error => this.rejectPending(error),
    });
    connection.listen();

    try {
      const result = await Promise.race([
        sendRequest<InitializeResult>(
          this.requestContext,
          'initialize',
          buildInitializeParams(this.options.rootPath, this.options.initializationOptions),
          this.options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS
        ),
        spawnFailure,
      ]);
      this.initializeResult = result;
      connection.sendNotification('initialized', {}).catch(error => {
        this.logger.debug('initialized notification failed', { error: String(error) });
      });
      this.currentState = 'running';
      this.logger.debug('server ready', {
        server: result.serverInfo?.name,
        version: result.serverInfo?.version,
      });
      return result;
    } catch (error) {
      /*
      | یک start شکست‌خورده نباید پروسه‌ای پشت سرش بگذارد. اینجا
      | مؤدب بودن (shutdown/exit) بی‌معنی است: سروری که به
      | `initialize` جواب نداده، به `shutdown` هم نمی‌دهد.
      */
      await this.killNow();
      this.currentState = 'stopped';
      throw error;
    }
  }

  /**
   * خاموشی مؤدب: `shutdown` → `exit` → مهلت → `SIGKILL`.
   *
   * چندبار صدا زدن بی‌ضرر است، و روی کلاینتی که اصلاً بالا نیامده هم.
   */
  async stop(): Promise<void> {
    if (this.currentState === 'idle' || this.currentState === 'stopped') {
      this.currentState = 'stopped';
      return;
    }
    if (this.currentState === 'crashed') {
      await this.killNow();
      return;
    }
    if (this.currentState === 'stopping') {
      await this.childExit;
      return;
    }

    this.currentState = 'stopping';

    this.documents.closeAll();

    const timeout = this.options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    try {
      await sendRequest<null>(this.requestContext, 'shutdown', undefined, timeout);
      this.notifyQuietly('exit', undefined);
    } catch (error) {
      this.logger.debug('shutdown request failed; killing instead', { error: String(error) });
    }

    const exited = await this.waitForExit(timeout);
    if (!exited) {
      this.logger.debug('server ignored exit; sending SIGKILL');
      await this.killNow();
    }

    this.connection?.dispose();
    this.connection = undefined;
    this.rejectPending(
      new LspNotRunningError(`server ${this.options.id} has been stopped`, this.options.id)
    );
    this.currentState = 'stopped';
  }

  // ── درخواست و اعلان ─────────────────────────────────────────────────

  async request<T>(method: string, params?: unknown, options: RequestOptions = {}): Promise<T> {
    if (!this.isRunning) {
      throw new LspNotRunningError(
        `cannot send ${method}: server ${this.options.id} is ${this.currentState}`,
        this.options.id
      );
    }
    return sendRequest<T>(
      this.requestContext,
      method,
      params,
      options.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    );
  }

  notify(method: string, params?: unknown): void {
    if (!this.isRunning) {
      throw new LspNotRunningError(
        `cannot send ${method}: server ${this.options.id} is ${this.currentState}`,
        this.options.id
      );
    }
    this.notifyQuietly(method, params);
  }

  // ── سند ─────────────────────────────────────────────────────────────

  /**
   * سند را باز می‌کند یا مرجعش را یکی زیاد می‌کند.
   *
   * `text` اختیاری است: اگر ندهید از دیسک خوانده می‌شود. اگر بدهید و
   * سند از قبل باز باشد و متن فرق کند، یک `didChange` می‌رود — چون
   * فراخوان انتظار دارد سرور همان متنی را ببیند که داده است.
   */
  openDocument(filePath: string, languageId: string, text?: string): void {
    this.documents.open(filePath, languageId, text);
  }

  /** متن کامل جدید. sync افزایشی (change: 2) بعداً در فاز ۳۷ کنار watch. */
  changeDocument(filePath: string, text: string): void {
    this.documents.change(filePath, text);
  }

  /** یک مرجع را رها می‌کند؛ `didClose` فقط در صفر شدن می‌رود. */
  closeDocument(filePath: string): void {
    this.documents.close(filePath);
  }

  isDocumentOpen(filePath: string): boolean {
    return this.documents.has(filePath);
  }

  /** باز می‌کند، کار را می‌کند، و در هر حالتی می‌بندد. */
  async withDocument<T>(
    filePath: string,
    languageId: string,
    run: () => Promise<T>,
    text?: string
  ): Promise<T> {
    this.openDocument(filePath, languageId, text);
    try {
      return await run();
    } finally {
      this.closeDocument(filePath);
    }
  }

  /**
   * `textDocument/documentSymbol` خام.
   *
   * نگاشت به `SymbolEntry` عمداً اینجا نیست — آن کار فاز ۳۳ است و
   * تصمیم‌های خودش را دارد (partial merge، اولویت استخراج‌گر).
   */
  async documentSymbol(filePath: string, options?: RequestOptions): Promise<DocumentSymbolResult> {
    return this.request<DocumentSymbolResult>(
      'textDocument/documentSymbol',
      { textDocument: { uri: uriOf(filePath) } },
      options
    );
  }

  // ── درون ────────────────────────────────────────────────────────────

  private assertRunning(what: string): void {
    if (!this.isRunning) {
      throw new LspNotRunningError(
        `cannot ${what}: server ${this.options.id} is ${this.currentState}`,
        this.options.id
      );
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of Array.from(this.pending)) pending.reject(error);
    this.pending.clear();
  }

  private notifyQuietly(method: string, params: unknown): void {
    const connection = this.connection;
    if (!connection || this.isChannelDead()) return;
    const sent =
      params === undefined ? connection.sendNotification(method) : connection.sendNotification(method, params);
    sent?.catch?.((error: unknown) => {
      this.logger.debug('notification failed', { method, error: String(error) });
    });
  }

  /** نوشتن روی stdinِ نابودشده یک استثنای بی‌صاحب می‌سازد، نه یک خطای قابل‌گرفتن. */
  private isChannelDead(): boolean {
    const stdin = this.child?.stdin;
    return !stdin || stdin.destroyed || stdin.writableEnded;
  }

  private dispatchNotification(method: string, params: unknown): void {
    const listeners = this.notificationListeners.get(method);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(params);
      } catch (error) {
        this.logger.debug('notification listener threw', { method, error: String(error) });
      }
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitReported) return;
    this.exitReported = true;

    const expected = this.currentState === 'stopping' || this.currentState === 'stopped';
    if (!expected) {
      this.currentState = 'crashed';
      this.documents.clear();
      this.logger.warn('language server exited unexpectedly', { code, signal });
      this.rejectPending(
        new LspNotRunningError(
          `server ${this.options.id} exited (code ${code}, signal ${signal})`,
          this.options.id
        )
      );
    } else {
      /*
      | `tsgo` بعد از یک shutdown سالم با کد ۱ خارج می‌شود. این را
      | فقط ثبت می‌کنیم؛ کرش نیست.
      */
      this.logger.debug('language server exited', { code, signal });
    }

    const info: LspExitInfo = { code, signal, expected };
    for (const listener of this.exitListeners) {
      try {
        listener(info);
      } catch (error) {
        this.logger.debug('exit listener threw', { error: String(error) });
      }
    }
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    return waitForChildExit(this.child, this.childExit, timeoutMs);
  }

  private async killNow(): Promise<void> {
    const child = this.child;
    this.connection?.dispose();
    this.connection = undefined;
    this.documents.clear();
    if (!child) return;
    await killChild(child, this.childExit);
    this.child = undefined;
  }
}

// ── کمکی ──────────────────────────────────────────────────────────────

/**
 * مسیر → URI.
 *
 * `pathToFileURL` و نه رشته‌بازی دستی: فاصله، `#`، و کاراکتر غیرلاتین
 * باید encode شوند وگرنه سرور فایل را پیدا نمی‌کند.
 */
export function uriOf(filePath: string): string {
  return pathToFileURL(filePath).toString();
}

/** URI → مسیر. */
export function pathOf(uri: string): string {
  return fileURLToPath(uri);
}

export * from './LspClientTypes';
