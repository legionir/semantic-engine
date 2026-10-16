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
import * as fs from 'fs';
import { pathToFileURL, fileURLToPath } from 'url';
import * as rpc from 'vscode-jsonrpc/node';
import { ILogger, silentLogger } from '../host/Logger';
import {
  DocumentSymbolResult,
  InitializeResult,
  ProgressParams,
  PublishDiagnosticsParams,
  ServerCapabilities,
  ServerInfo,
} from './protocol';

/** نام و نسخه‌ای که به سرور معرفی می‌کنیم. */
const CLIENT_NAME = 'semantic-engine';

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_INITIALIZE_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

export type LspClientState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'crashed';

export interface LspExitInfo {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** آیا ما خواسته بودیم که خارج شود؟ */
  readonly expected: boolean;
}

export interface LspClientOptions {
  /** شناسهٔ سرور — فقط برای لاگ و پیام خطا. */
  readonly id: string;
  readonly command: string;
  readonly args?: readonly string[];
  /** ریشهٔ workspace؛ هم `cwd` پروسه است هم `rootUri` دست‌دادن. */
  readonly rootPath: string;
  readonly logger?: ILogger;
  readonly env?: NodeJS.ProcessEnv;
  readonly requestTimeoutMs?: number;
  readonly initializeTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly initializationOptions?: unknown;
  /** پاسخ به `workspace/configuration`. پیش‌فرض: یک شیء خالی برای هر آیتم. */
  readonly configuration?: (section: string | undefined) => unknown;
  readonly onDiagnostics?: (params: PublishDiagnosticsParams) => void;
  readonly onProgress?: (params: ProgressParams) => void;
  readonly onExit?: (info: LspExitInfo) => void;
  /** برای تست: جایگزین `child_process.spawn`. */
  readonly spawn?: typeof cp.spawn;
}

export interface RequestOptions {
  readonly timeoutMs?: number;
}

// ── خطاها ─────────────────────────────────────────────────────────────

export class LspError extends Error {
  constructor(
    message: string,
    readonly serverId: string
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** سرور به‌موقع جواب نداد. درخواست لغو شد (`$/cancelRequest`). */
export class LspTimeoutError extends LspError {}

/** پروسه بالا نیامد — باینری نبود، یا فوراً مرد. */
export class LspStartError extends LspError {}

/** سرور در حال اجرا نیست (هنوز، یا دیگر). */
export class LspNotRunningError extends LspError {}

// ── سند باز ───────────────────────────────────────────────────────────

interface OpenDocument {
  readonly uri: string;
  readonly languageId: string;
  version: number;
  refCount: number;
  text: string;
}

interface Pending {
  reject(error: Error): void;
}

// ── کلاینت ────────────────────────────────────────────────────────────

export class LspClient {
  private readonly options: LspClientOptions;
  private readonly logger: ILogger;
  private readonly documents = new Map<string, OpenDocument>();
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

  constructor(options: LspClientOptions) {
    this.options = options;
    this.logger = (options.logger ?? silentLogger).child(`lsp:${options.id}`);
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

    const spawn = this.options.spawn ?? cp.spawn;
    const args = [...(this.options.args ?? [])];

    let child: cp.ChildProcess;
    try {
      child = spawn(this.options.command, args, {
        cwd: this.options.rootPath,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.options.env ?? process.env,
      });
    } catch (error) {
      this.currentState = 'stopped';
      throw new LspStartError(
        `could not spawn ${this.options.command}: ${(error as Error).message}`,
        this.options.id
      );
    }
    this.child = child;

    /*
    | خطای spawn (مثلاً ENOENT) ناهمگام می‌آید. تا وقتی start تمام
    | نشده، باید به رد شدن آن ترجمه شود؛ بعد از آن، یک کرش است.
    */
    const spawnFailure = new Promise<never>((_, reject) => {
      child.once('error', error => {
        reject(
          new LspStartError(
            `could not spawn ${this.options.command}: ${(error as Error).message}`,
            this.options.id
          )
        );
      });
    });
    spawnFailure.catch(() => undefined);

    this.childExit = new Promise<void>(resolve => {
      child.once('exit', (code, signal) => {
        this.handleExit(code, signal);
        resolve();
      });
    });

    /*
    | صبر برای رویداد `spawn` پیش از ساختن اتصال.
    |
    | بدون آن، وقتی باینری وجود ندارد، `initialize` روی یک stdin که
    | همان لحظه نابود می‌شود نوشته می‌شود و `vscode-jsonrpc` داخل یک
    | executor ناهمگام هم reject می‌کند و هم throw — یعنی یک
    | unhandled rejection که به *تست بعدی* می‌چسبد. یک‌بار دقیقاً
    | همین اتفاق افتاد و تست اشتباهی را قرمز کرد.
    */
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
    } catch (error) {
      this.currentState = 'stopped';
      this.child = undefined;
      throw new LspStartError(
        `could not spawn ${this.options.command}: ${describe(error)}`,
        this.options.id
      );
    }

    this.pipeStderr(child);

    const connection = rpc.createMessageConnection(
      new rpc.StreamMessageReader(child.stdout!),
      new rpc.StreamMessageWriter(child.stdin!)
    );
    this.connection = connection;
    this.registerHandlers(connection);
    connection.listen();

    try {
      const result = await Promise.race([
        this.sendRequest<InitializeResult>(
          'initialize',
          this.buildInitializeParams(),
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

    for (const [key, doc] of this.documents) {
      this.notifyQuietly('textDocument/didClose', { textDocument: { uri: doc.uri } });
      this.documents.delete(key);
    }

    const timeout = this.options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    try {
      await this.sendRequest<null>('shutdown', undefined, timeout);
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
    return this.sendRequest<T>(
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
    this.assertRunning(`open ${filePath}`);
    const uri = uriOf(filePath);
    const existing = this.documents.get(uri);

    if (existing) {
      existing.refCount += 1;
      if (text !== undefined && text !== existing.text) this.changeDocument(filePath, text);
      return;
    }

    const content = text ?? fs.readFileSync(filePath, 'utf8');
    this.documents.set(uri, { uri, languageId, version: 1, refCount: 1, text: content });
    this.notifyQuietly('textDocument/didOpen', {
      textDocument: { uri, languageId, version: 1, text: content },
    });
  }

  /** متن کامل جدید. sync افزایشی (change: 2) بعداً در فاز ۳۷ کنار watch. */
  changeDocument(filePath: string, text: string): void {
    this.assertRunning(`change ${filePath}`);
    const uri = uriOf(filePath);
    const doc = this.documents.get(uri);
    if (!doc) {
      throw new LspError(
        `cannot change ${filePath}: the document is not open on server ${this.options.id}`,
        this.options.id
      );
    }
    doc.version += 1;
    doc.text = text;
    this.notifyQuietly('textDocument/didChange', {
      textDocument: { uri, version: doc.version },
      contentChanges: [{ text }],
    });
  }

  /** یک مرجع را رها می‌کند؛ `didClose` فقط در صفر شدن می‌رود. */
  closeDocument(filePath: string): void {
    const uri = uriOf(filePath);
    const doc = this.documents.get(uri);
    if (!doc) return;

    doc.refCount -= 1;
    if (doc.refCount > 0) return;

    this.documents.delete(uri);
    if (this.currentState === 'running') {
      this.notifyQuietly('textDocument/didClose', { textDocument: { uri } });
    }
  }

  isDocumentOpen(filePath: string): boolean {
    return this.documents.has(uriOf(filePath));
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

  private buildInitializeParams(): Record<string, unknown> {
    const rootUri = pathToFileURL(this.options.rootPath).toString();
    return {
      processId: process.pid,
      clientInfo: { name: CLIENT_NAME },
      locale: 'en',
      // `rootPath` منسوخ است ولی چند سرور هنوز فقط همان را می‌خوانند.
      rootPath: this.options.rootPath,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: CLIENT_NAME }],
      initializationOptions: this.options.initializationOptions,
      capabilities: {
        general: { positionEncodings: ['utf-16'] },
        workspace: {
          workspaceFolders: true,
          configuration: true,
          didChangeConfiguration: { dynamicRegistration: true },
          didChangeWatchedFiles: { dynamicRegistration: true },
        },
        window: { workDoneProgress: true },
        textDocument: {
          synchronization: { dynamicRegistration: false, didSave: true },
          documentSymbol: {
            dynamicRegistration: false,
            hierarchicalDocumentSymbolSupport: true,
            symbolKind: { valueSet: Array.from({ length: 26 }, (_, index) => index + 1) },
          },
          hover: { dynamicRegistration: false, contentFormat: ['markdown', 'plaintext'] },
          publishDiagnostics: { relatedInformation: true },
          diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
        },
      },
    };
  }

  private registerHandlers(connection: rpc.MessageConnection): void {
    const configuration = this.options.configuration ?? (() => ({}));

    /*
    | این سه، اجباری‌اند. probe نشان داد `tsgo` دوتای اول را واقعاً
    | می‌فرستد و منتظر جواب می‌ماند.
    */
    connection.onRequest('workspace/configuration', (params: { items?: { section?: string }[] }) =>
      (params?.items ?? []).map(item => configuration(item?.section))
    );
    connection.onRequest('client/registerCapability', () => null);
    connection.onRequest('client/unregisterCapability', () => null);
    connection.onRequest('window/workDoneProgress/create', () => null);
    connection.onRequest('window/showMessageRequest', () => null);
    // ویرایش فایل کار ما نیست؛ «نپذیرفتم» صادقانه‌تر از سکوت است.
    connection.onRequest('workspace/applyEdit', () => ({ applied: false }));

    /*
    | هر درخواست دیگری هم باید *جوابی* بگیرد. سکوت یعنی سرور تا ابد
    | منتظر می‌ماند و هیچ‌جا خطایی ثبت نمی‌شود.
    */
    connection.onRequest((method: string) => {
      this.logger.debug('unhandled server request', { method });
      return new rpc.ResponseError(rpc.ErrorCodes.MethodNotFound, `${CLIENT_NAME} does not implement ${method}`);
    });

    connection.onNotification('$/progress', (params: ProgressParams) => {
      this.options.onProgress?.(params);
      this.dispatchNotification('$/progress', params);
    });
    connection.onNotification(
      'textDocument/publishDiagnostics',
      (params: PublishDiagnosticsParams) => {
        this.dispatchNotification('textDocument/publishDiagnostics', params);
        this.options.onDiagnostics?.(params);
        for (const listener of this.diagnosticsListeners) {
          try {
            listener(params);
          } catch (error) {
            this.logger.debug('diagnostics listener threw', { error: String(error) });
          }
        }
      }
    );
    connection.onNotification((method: string, ...params: unknown[]) => {
      this.logger.debug('server notification', { method });
      this.dispatchNotification(method, params[0]);
    });

    connection.onError(([error]) => {
      this.logger.debug('connection error', { error: String(error) });
    });
    connection.onClose(() => {
      this.logger.debug('connection closed');
      /*
      | کتابخانه در پرواز‌ها را روی close رد نمی‌کند (فقط روی
      | dispose). بدون این، مرگ سرور یعنی هر فراخوان تا سررسید
      | timeout خودش معلق می‌ماند.
      */
      if (this.currentState !== 'stopping' && this.currentState !== 'stopped') {
        /*
        | اتصال که بسته شد، سرور رفته است — رویداد `exit` پروسه یک تیک
        | بعد می‌آید. اگر تا آن لحظه حالت را «در حال اجرا» نگه داریم،
        | فراخوان بعدی درخواستی می‌فرستد که هیچ‌وقت جواب نمی‌گیرد.
        */
        if (this.currentState === 'running' || this.currentState === 'starting') {
          this.currentState = 'crashed';
        }
        this.rejectPending(
          new LspNotRunningError(
            `server ${this.options.id} closed the connection`,
            this.options.id
          )
        );
      }
    });
  }

  /**
   * stderr سرور: خط به خط به لاگر، هرگز به stdout ما.
   *
   * وقتی خودمان سرور MCP روی stdio هستیم، stdout کانال پروتکل است و
   * یک خط لاگ سرور کافی است تا قاب `Content-Length` را خراب کند.
   */
  private pipeStderr(child: cp.ChildProcess): void {
    if (!child.stderr) return;
    let buffer = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trimEnd();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) this.logger.debug(`server stderr: ${line}`);
        newline = buffer.indexOf('\n');
      }
      if (buffer.length > 64 * 1024) {
        // سروری که بدون newline حرف می‌زند نباید حافظه را ببلعد.
        this.logger.debug(`server stderr: ${buffer}`);
        buffer = '';
      }
    });
    child.stderr.on('error', error => {
      this.logger.debug('server stderr stream error', { error: String(error) });
    });
  }

  /**
   * یک درخواست با سررسید.
   *
   * روی timeout، `$/cancelRequest` هم می‌رود — وگرنه سرور تا آخر روی
   * کاری که دیگر کسی نمی‌خواهد وقت می‌گذارد.
   */
  private async sendRequest<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    const connection = this.connection;
    if (!connection || this.isChannelDead()) {
      throw new LspNotRunningError(
        `cannot send ${method}: server ${this.options.id} has no live connection`,
        this.options.id
      );
    }

    const source = new rpc.CancellationTokenSource();
    let timer: NodeJS.Timeout | undefined;
    let settled = false;

    const inFlight: Pending = { reject: () => undefined };

    const result = new Promise<T>((resolve, reject) => {
      inFlight.reject = error => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        source.cancel();
        reject(
          new LspTimeoutError(
            `${method} on server ${this.options.id} did not answer in ${timeoutMs}ms`,
            this.options.id
          )
        );
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      const sent =
        params === undefined
          ? connection.sendRequest<T>(method, source.token)
          : connection.sendRequest<T>(method, params, source.token);

      sent.then(
        value => {
          if (settled) return;
          settled = true;
          resolve(value);
        },
        error => {
          if (settled) return;
          settled = true;
          reject(this.translateError(method, error));
        }
      );
    });

    this.pending.add(inFlight);
    try {
      return await result;
    } finally {
      this.pending.delete(inFlight);
      if (timer) clearTimeout(timer);
      source.dispose();
    }
  }

  private translateError(method: string, error: unknown): Error {
    if (!this.isRunning && this.currentState !== 'starting') {
      return new LspNotRunningError(
        `${method} failed: server ${this.options.id} is ${this.currentState}`,
        this.options.id
      );
    }
    if (this.currentState === 'starting') {
      return new LspStartError(
        `${method} failed while starting server ${this.options.id}: ${describe(error)}`,
        this.options.id
      );
    }
    return error instanceof Error ? error : new LspError(describe(error), this.options.id);
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

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return true;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
    try {
      return await Promise.race([this.childExit!.then(() => true), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async killNow(): Promise<void> {
    const child = this.child;
    this.connection?.dispose();
    this.connection = undefined;
    this.documents.clear();
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await Promise.race([
        this.childExit,
        new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 2000);
          if (typeof timer.unref === 'function') timer.unref();
        }),
      ]);
    }
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

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
