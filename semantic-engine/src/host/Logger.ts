/**
 * لاگر میزبان — جایگزین `console.*` و `vscode.window.showXMessage`.
 *
 * سه چیز اینجا مهم است و بقیه جزئیات است:
 *
 * ۱. **stdio**: وقتی پروسه سرور MCP است، stdout کانال JSON-RPC است. هر
 *    بایتی که لاگر آنجا بنویسد یک قاب Content-Length را خراب می‌کند و
 *    ارتباط می‌میرد. در آن حالت همه‌چیز — حتی debug — به stderr می‌رود.
 * ۲. **دو قالب**: متن برای آدم، NDJSON برای ماشین (CI، بازپخش لاگ).
 * ۳. **لاگر نباید منبع خرابی شود**: نه ساختار حلقوی، نه EPIPE روی یک
 *    لولهٔ بسته، نباید ایندکس را متوقف کند.
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';
export type LogLevelSetting = LogLevel | 'silent';
export type LogFormat = 'text' | 'ndjson';

/** ترتیب از پرحجم‌ترین اهمیت به کم‌اهمیت‌ترین. */
export const LOG_LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug'] as const;

const LEVEL_RANK: Record<LogLevelSetting, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

/** کمینهٔ چیزی که برای نوشتن لازم است — `process.stdout` این را دارد. */
export interface LogSink {
  write(chunk: string): unknown;
}

export type LogMeta = Record<string, unknown>;

export interface LoggerOptions {
  readonly level?: LogLevelSetting;
  readonly format?: LogFormat;
  /** حالت سرور stdio: همه‌چیز به stderr. */
  readonly stdio?: boolean;
  readonly scope?: string;
  readonly stdout?: LogSink;
  readonly stderr?: LogSink;
  readonly now?: () => Date;
}

export interface ILogger {
  error(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  debug(message: string, meta?: LogMeta): void;
  child(scope: string): ILogger;
}

/*
| وضعیت مشترک بین یک لاگر و فرزندانش. فرزند فقط scope متفاوتی دارد؛
| تغییر سطح روی والد باید روی فرزند هم اثر کند، پس سطح اینجا می‌نشیند
| نه در نمونه.
*/
interface LoggerState {
  level: LogLevelSetting;
  readonly format: LogFormat;
  readonly stdio: boolean;
  readonly stdout: LogSink;
  readonly stderr: LogSink;
  readonly now: () => Date;
}

export class Logger implements ILogger {
  private readonly state: LoggerState;
  private readonly scope: string | undefined;

  constructor(options: LoggerOptions = {}, state?: LoggerState) {
    this.state = state ?? {
      level: options.level ?? 'info',
      format: options.format ?? 'text',
      stdio: options.stdio ?? false,
      stdout: options.stdout ?? process.stdout,
      stderr: options.stderr ?? process.stderr,
      now: options.now ?? (() => new Date()),
    };
    this.scope = options.scope;
  }

  error(message: string, meta?: LogMeta): void {
    this.emit('error', message, meta);
  }

  warn(message: string, meta?: LogMeta): void {
    this.emit('warn', message, meta);
  }

  info(message: string, meta?: LogMeta): void {
    this.emit('info', message, meta);
  }

  debug(message: string, meta?: LogMeta): void {
    this.emit('debug', message, meta);
  }

  child(scope: string): Logger {
    const nested = this.scope ? `${this.scope}.${scope}` : scope;
    return new Logger({ scope: nested }, this.state);
  }

  setLevel(level: LogLevelSetting): void {
    this.state.level = level;
  }

  getLevel(): LogLevelSetting {
    return this.state.level;
  }

  isEnabled(level: LogLevel): boolean {
    return LEVEL_RANK[level] <= LEVEL_RANK[this.state.level];
  }

  private emit(level: LogLevel, message: string, meta?: LogMeta): void {
    if (!this.isEnabled(level)) return;

    const line = this.state.format === 'ndjson'
      ? this.formatNdjson(level, message, meta)
      : this.formatText(level, message, meta);

    /*
    | stdio: هیچ‌چیز روی stdout. در حالت عادی، error و warn روی stderr
    | می‌روند تا خروجی قابل‌مصرفِ دستور (مثلاً JSON) روی stdout تمیز
    | بماند و بشود آن را pipe کرد.
    */
    const sink = this.state.stdio || level === 'error' || level === 'warn'
      ? this.state.stderr
      : this.state.stdout;

    try {
      sink.write(line + '\n');
    } catch {
      /*
      | لولهٔ بسته (EPIPE) وقتی خروجی به `head` داده شده، یا یک sink
      | خراب در تست. لاگ‌نشدن یک پیام بهتر از سقوط ایندکس است.
      */
    }
  }

  private formatText(level: LogLevel, message: string, meta?: LogMeta): string {
    const parts = [
      this.timestamp(),
      level.padEnd(5, ' '),
    ];
    if (this.scope) parts.push(`[${this.scope}]`);
    parts.push(oneLine(message));

    const rendered = renderMetaAsPairs(meta);
    if (rendered) parts.push(rendered);

    return parts.join(' ');
  }

  private formatNdjson(level: LogLevel, message: string, meta?: LogMeta): string {
    const record: Record<string, unknown> = {
      ts: this.timestamp(),
      level,
      message,
    };
    if (this.scope) record.scope = this.scope;
    if (meta && Object.keys(meta).length > 0) record.meta = safeJsonValue(meta);

    /*
    | JSON.stringify خودش newline داخل رشته‌ها را escape می‌کند، پس یک
    | رکورد همیشه یک خط است — شرط لازم NDJSON.
    */
    return JSON.stringify(record);
  }

  private timestamp(): string {
    return this.state.now().toISOString();
  }
}

/** لاگر بی‌صدا برای تست‌ها و مسیرهایی که لاگ نمی‌خواهند. */
export const silentLogger: ILogger = new Logger({ level: 'silent' });

/**
 * لاگر پیش‌فرض کتابخانه.
 *
 * جای `console.warn` را می‌گیرد. سطح `warn` است و نه بالاتر: یک
 * کتابخانه نباید بدون اینکه از او خواسته باشند حرف بزند، ولی خطایی که
 * بی‌صدا بلعیده شود بدتر است. مثل `console.warn` روی stderr می‌نویسد،
 * با این تفاوت که فراخوان می‌تواند جایش لاگر خودش را بگذارد.
 */
export const defaultLogger: ILogger = new Logger({ level: 'warn' });

/**
 * ساخت لاگر از متغیرهای محیطی.
 *
 * مقدار ناشناخته «خطا» نیست: لاگر نباید مانع بالا آمدن پروسه شود، پس
 * روی پیش‌فرض می‌افتد.
 */
export function createLoggerFromEnv(
  env: Record<string, string | undefined> = process.env,
  overrides: Partial<LoggerOptions> = {}
): Logger {
  const rawLevel = (env.SEMANTIC_ENGINE_LOG_LEVEL ?? '').toLowerCase();
  const rawFormat = (env.SEMANTIC_ENGINE_LOG_FORMAT ?? '').toLowerCase();

  const level = rawLevel in LEVEL_RANK ? (rawLevel as LogLevelSetting) : undefined;
  const format = rawFormat === 'ndjson' || rawFormat === 'text'
    ? (rawFormat as LogFormat)
    : undefined;
  const stdio = isTruthy(env.SEMANTIC_ENGINE_STDIO);

  return new Logger({
    level,
    format,
    stdio,
    ...overrides,
  });
}

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function oneLine(value: string): string {
  return value.replace(/\r?\n/g, ' ');
}

/** `key=value` با نقل‌قول فقط وقتی لازم است. */
function renderMetaAsPairs(meta: LogMeta | undefined): string {
  if (!meta) return '';
  const pairs: string[] = [];

  for (const [key, value] of Object.entries(meta)) {
    pairs.push(`${key}=${renderScalar(value)}`);
  }

  return pairs.join(' ');
}

function renderScalar(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (value instanceof Error) return quoteIfNeeded(`${value.name}: ${value.message}`);
  if (typeof value === 'object') return quoteIfNeeded(safeStringify(value));
  return quoteIfNeeded(String(value));
}

function quoteIfNeeded(value: string): string {
  const flat = oneLine(value);
  return /[\s"]/.test(flat) ? JSON.stringify(flat) : flat;
}

/**
 * تبدیل metadata به چیزی که حتماً serializable است.
 *
 * دو مورد واقعی: `Error` که با JSON.stringify به `{}` تبدیل می‌شود و
 * ارجاع حلقوی که پرتاب می‌کند.
 */
function safeJsonValue(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (value === null || typeof value !== 'object') return value;

  if (seen.has(value as object)) return '[Circular]';
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map(item => safeJsonValue(item, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = safeJsonValue(item, seen);
  }
  return out;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(safeJsonValue(value)) ?? String(value);
  } catch {
    return String(value);
  }
}
