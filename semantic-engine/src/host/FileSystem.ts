/**
 * پورت فایل‌سیستم — تنها جایی که مسیر ایندکس با دیسک حرف می‌زند.
 *
 * دو تضمین اینجا حرف اصلی را می‌زنند:
 *
 * **اتمیک بودن.** نوشتن روی فایل موقتِ کنارِ مقصد، `fsync`، بعد `rename`.
 * `rename` در همان فایل‌سیستم اتمیک است، پس خواننده یا نسخهٔ قبلی را
 * می‌بیند یا نسخهٔ کامل جدید را — هرگز نیمه‌کاره. امروز `JsonExporter`
 * مستقیم روی مقصد می‌نویسد و یک Ctrl-C کافی است تا ایندکس نابود شود.
 *
 * **سریالایز جریانی.** `JSON.stringify` روی کل ایندکس یک رشتهٔ واحد
 * می‌سازد و سقف طول رشته در V8 (اینجا ۵۳۶٬۸۷۰٬۸۸۸ کاراکتر) یک دیوار
 * سخت است. `jsonChunks` درخت را قطعه‌قطعه بیرون می‌دهد و فقط برگ‌ها را
 * — که کوچک‌اند — با `JSON.stringify` می‌سازد. همین باعث می‌شود escape
 * کردن دقیقاً با استاندارد یکی بماند.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface JsonChunkOptions {
  readonly pretty?: boolean;
  readonly indent?: string;
}

export interface WritableLike {
  write(chunk: string): boolean;
  once(event: string, listener: (...args: never[]) => void): unknown;
  removeListener?(event: string, listener: (...args: never[]) => void): unknown;
}

export interface FileSystemPort {
  readFile(filePath: string): Promise<string>;
  readJson<T = unknown>(filePath: string): Promise<T>;
  exists(filePath: string): Promise<boolean>;
  mkdirp(dirPath: string): Promise<void>;
  remove(filePath: string): Promise<void>;
  writeFileAtomic(filePath: string, data: string | Buffer): Promise<void>;
  writeJsonAtomic(filePath: string, value: unknown, options?: JsonChunkOptions): Promise<void>;
}

// ── سریالایز جریانی ───────────────────────────────────────────────────────

/**
 * همان خروجی `JSON.stringify`، ولی قطعه‌قطعه.
 *
 * هیچ‌جا کل سند به‌صورت یک رشته ساخته نمی‌شود. برگ‌ها با خود
 * `JSON.stringify` تبدیل می‌شوند تا escape، نمایش عدد و برخورد با
 * `toJSON` مو‌به‌مو با استاندارد یکی بماند.
 */
export function* jsonChunks(value: unknown, options: JsonChunkOptions = {}): Generator<string> {
  const indentUnit = options.pretty ? (options.indent ?? '  ') : '';

  if (serializesToNothing(value)) return;

  yield* emit(value, indentUnit, '', new Set<object>(), '');
}

function* emit(
  raw: unknown,
  indentUnit: string,
  currentIndent: string,
  ancestors: Set<object>,
  location: string
): Generator<string> {
  const value = applyToJson(raw);

  if (value === null || typeof value !== 'object') {
    yield JSON.stringify(value) as string;
    return;
  }

  const container = value as object;
  if (ancestors.has(container)) {
    /*
    | پیام استاندارد V8 نمی‌گوید حلقه کجاست. روی یک ایندکس با هزاران
    | گره، آن پیام عملاً بی‌فایده است؛ مسیر را اضافه می‌کنیم.
    */
    throw new TypeError(
      `Converting circular structure to JSON at ${location || '<root>'}`
    );
  }
  ancestors.add(container);

  const childIndent = currentIndent + indentUnit;
  const pretty = indentUnit.length > 0;

  if (Array.isArray(value)) {
    if (value.length === 0) {
      yield '[]';
    } else {
      yield '[';
      for (let index = 0; index < value.length; index++) {
        yield index === 0
          ? (pretty ? '\n' + childIndent : '')
          : (pretty ? ',\n' + childIndent : ',');

        const item = value[index];
        if (serializesToNothing(item)) {
          // JSON.stringify یک عضو حذف‌شدنی آرایه را null می‌کند.
          yield 'null';
        } else {
          const flat = stringifyArrayItem(item, indentUnit, childIndent);
          if (flat !== null) yield flat;
          else yield* emit(item, indentUnit, childIndent, ancestors, `${location}[${index}]`);
        }
      }
      yield pretty ? '\n' + currentIndent + ']' : ']';
    }
  } else {
    const source = value as Record<string, unknown>;
    const keys = Object.keys(source).filter(key => !serializesToNothing(source[key]));

    if (keys.length === 0) {
      yield '{}';
    } else {
      yield '{';
      for (let index = 0; index < keys.length; index++) {
        yield index === 0
          ? (pretty ? '\n' + childIndent : '')
          : (pretty ? ',\n' + childIndent : ',');

        const key = keys[index];
        yield JSON.stringify(key) + (pretty ? ': ' : ':');
        yield* emit(
          source[key],
          indentUnit,
          childIndent,
          ancestors,
          location ? `${location}.${key}` : key
        );
      }
      yield pretty ? '\n' + currentIndent + '}' : '}';
    }
  }

  ancestors.delete(container);
}

/**
 * Fast path for an array element: one native `JSON.stringify` call instead of a
 * generator yield per token. The result is identical (same `toJSON` and
 * omission rules), re-indented to the element's depth. Elements are bounded, so
 * the "never build the whole document as one string" property is kept. Returns
 * null for anything `JSON.stringify` rejects (cycles, BigInt, ...) so the slow
 * path can report the precise location.
 */
function stringifyArrayItem(item: unknown, indentUnit: string, childIndent: string): string | null {
  if (item === null || typeof item !== 'object') return null;
  try {
    if (indentUnit.length === 0) return JSON.stringify(item);
    /* `\n` only occurs as structure in pretty output (string contents escape it). */
    return JSON.stringify(item, null, indentUnit).replace(/\n/g, '\n' + childIndent);
  } catch {
    return null;
  }
}

function applyToJson(value: unknown): unknown {
  if (
    value !== null &&
    (typeof value === 'object' || typeof value === 'bigint') &&
    typeof (value as { toJSON?: unknown }).toJSON === 'function'
  ) {
    return (value as { toJSON: () => unknown }).toJSON();
  }
  return value;
}

/** آیا `JSON.stringify` این مقدار را `undefined` می‌کند (یعنی حذفش می‌کند). */
function serializesToNothing(value: unknown): boolean {
  const resolved = applyToJson(value);
  const type = typeof resolved;
  return type === 'undefined' || type === 'function' || type === 'symbol';
}

/**
 * نوشتن جریانی با احترام به backpressure.
 *
 * بدون انتظار برای `drain`، تمام قطعه‌ها در بافر داخلی stream جمع
 * می‌شوند و همان مصرف حافظه‌ای برمی‌گردد که قرار بود حذف شود.
 */
/**
 * هر چند قطعه یک‌بار، کنترل به event loop برگردانده می‌شود.
 *
 * SE-PERF-01 — سریالایز جریانی حافظه را نجات می‌داد ولی event loop
 * را نه: `jsonChunks` یک generator همگام است و بین دو backpressure،
 * هزاران قطعه پشت سر هم بدون هیچ وقفه‌ای نوشته می‌شوند.
 *
 * اندازه‌گیری‌شده روی یک ایندکس ۲۹MB (۴۰۱ فایل، ۲۰۴۰۱ نماد):
 *
 *     WORST BLOCK: 7306ms during: "WRITE"
 *
 * `await` روی `waitForDrain` فقط وقتی رخ می‌داد که بافر پر شود؛ روی
 * دیسک سریع اصلاً پر نمی‌شد و کل نوشتن یک بلوک همگام می‌شد.
 */
const CHUNKS_BETWEEN_YIELDS = 2048;

export async function stringifyToStream(
  value: unknown,
  stream: WritableLike,
  options: JsonChunkOptions = {}
): Promise<void> {
  let sinceYield = 0;

  /*
  | An async stream error (ENOSPC, EACCES after open, ...) can be emitted while
  | `write()` keeps returning true; without a listener for the whole write it is
  | either an unhandled 'error' event or silently ignored until the end. Keep a
  | listener for the full duration and surface the first error to the caller.
  */
  let failure: Error | undefined;
  const onStreamError = (error: Error): void => {
    failure ??= error;
  };
  stream.once('error', onStreamError as never);

  try {
    for (const chunk of jsonChunks(value, options)) {
      if (failure) throw failure;

      if (!stream.write(chunk)) {
        await waitForDrain(stream);
        sinceYield = 0;
        continue;
      }

      sinceYield += 1;

      if (sinceYield >= CHUNKS_BETWEEN_YIELDS) {
        sinceYield = 0;
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    }
    if (failure) throw failure;
  } finally {
    stream.removeListener?.('error', onStreamError as never);
  }
}

function waitForDrain(stream: WritableLike): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      stream.removeListener?.('drain', onDrain as never);
      stream.removeListener?.('error', onError as never);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    stream.once('drain', onDrain as never);
    stream.once('error', onError as never);
  });
}

// ── پورت ──────────────────────────────────────────────────────────────────

export interface NodeFileSystemOptions {
  /** برای تست: تزریق یک `fs.promises` بدلی. */
  readonly fsImpl?: typeof fs.promises;
  readonly createWriteStream?: typeof fs.createWriteStream;
  /**
   * سن لازم برای اینکه یک فایل موقتِ جامانده «مرده» حساب شود.
   * پیش‌فرض یک ساعت — به‌قدری بلند که نویسندهٔ هم‌زمانِ در حال کار
   * قربانی نشود.
   */
  readonly staleTmpMs?: number;
}

export class NodeFileSystem implements FileSystemPort {
  private readonly fs: typeof fs.promises;
  private readonly createWriteStream: typeof fs.createWriteStream;
  private readonly staleTmpMs: number;

  constructor(options: NodeFileSystemOptions = {}) {
    this.fs = options.fsImpl ?? fs.promises;
    this.createWriteStream = options.createWriteStream ?? fs.createWriteStream;
    this.staleTmpMs = options.staleTmpMs ?? 60 * 60 * 1000;
  }

  async readFile(filePath: string): Promise<string> {
    return this.fs.readFile(filePath, 'utf8');
  }

  async readJson<T = unknown>(filePath: string): Promise<T> {
    const text = await this.readFile(filePath);
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      // یک SyntaxError خالی نمی‌گوید کدام فایل؛ روی ایندکس بی‌فایده است.
      throw new Error(`${filePath} is not valid JSON: ${(error as Error).message}`);
    }
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await this.fs.stat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async mkdirp(dirPath: string): Promise<void> {
    await this.fs.mkdir(dirPath, { recursive: true });
  }

  async remove(filePath: string): Promise<void> {
    try {
      await this.fs.rm(filePath, { recursive: true, force: true });
    } catch {
      // force: true نبودِ فایل را می‌بلعد؛ بقیه هم نباید فراخوان را بترساند.
    }
  }

  async writeFileAtomic(filePath: string, data: string | Buffer): Promise<void> {
    await this.mkdirp(path.dirname(filePath));
    await this.sweepStaleTemporaries(filePath);
    const tmp = temporaryPathFor(filePath);

    try {
      await this.fs.writeFile(tmp, data);
      await this.flush(tmp);
      await this.fs.rename(tmp, filePath);
    } catch (error) {
      await this.discard(tmp);
      throw error;
    }
  }

  async writeJsonAtomic(
    filePath: string,
    value: unknown,
    options: JsonChunkOptions = {}
  ): Promise<void> {
    await this.mkdirp(path.dirname(filePath));
    await this.sweepStaleTemporaries(filePath);
    const tmp = temporaryPathFor(filePath);

    try {
      const stream = this.createWriteStream(tmp, { encoding: 'utf8' });
      /*
      | Listener for the stream's whole life: an error emitted after the last
      | write but before/while `end()` completes must reach the caller, not
      | crash the process as an unhandled 'error' event.
      */
      let streamFailure: Error | undefined;
      stream.on('error', (error: Error) => {
        streamFailure ??= error;
      });
      let writeError: unknown;
      try {
        await stringifyToStream(value, stream as unknown as WritableLike, options);
      } catch (error) {
        writeError = error;
      } finally {
        await new Promise<void>(resolve => {
          stream.end(() => resolve());
        });
      }
      if (writeError) throw writeError;
      if (streamFailure) throw streamFailure;
      await this.flush(tmp);
      await this.fs.rename(tmp, filePath);
    } catch (error) {
      await this.discard(tmp);
      throw error;
    }
  }

  /**
   * `rename` تنها وقتی معنی می‌دهد که بدنه واقعاً روی دیسک باشد. بدون
   * `fsync`، یک قطع برق می‌تواند فایلِ تغییرنام‌یافتهٔ خالی باقی بگذارد.
   */
  private async flush(filePath: string): Promise<void> {
    const handle = await this.fs.open(filePath, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async discard(filePath: string): Promise<void> {
    try {
      await this.fs.unlink(filePath);
    } catch {
      // فایل موقت ممکن است اصلاً ساخته نشده باشد.
    }
  }

  /**
   * جاروی فایل‌های موقتِ جامانده.
   *
   * پاک‌سازی در مسیر خطا فقط وقتی کار می‌کند که پروسه فرصت اجرا داشته
   * باشد. `SIGKILL` و قطع برق چنین فرصتی نمی‌دهند و یک
   * `project-index.json.<id>.tmp` نیمه‌کاره کنار ایندکس جا می‌ماند —
   * که هم انباشته می‌شود و هم توسط اسکنر به‌عنوان فایل پروژه دیده
   * می‌شود. آستانهٔ سنی لازم است تا نویسندهٔ هم‌زمانِ در حال کار حذف
   * نشود.
   */
  private async sweepStaleTemporaries(filePath: string): Promise<void> {
    const dir = path.dirname(filePath);
    const prefix = path.basename(filePath) + '.';
    const cutoff = Date.now() - this.staleTmpMs;

    try {
      const entries = await this.fs.readdir(dir);
      for (const entry of entries) {
        if (!entry.startsWith(prefix) || !entry.endsWith('.tmp')) continue;

        const candidate = path.join(dir, entry);
        try {
          const stats = await this.fs.stat(candidate);
          if (stats.mtimeMs < cutoff) await this.fs.unlink(candidate);
        } catch {
          // مسابقه با یک نویسندهٔ دیگر — بی‌اهمیت.
        }
      }
    } catch {
      /*
      | جارو کردن یک کار جانبی است؛ شکستش نباید نوشتن اصلی را باطل
      | کند.
      */
    }
  }
}

/**
 * نام فایل موقت باید برای هر نویسنده یکتا باشد.
 *
 * با نام ثابت، دو اجرای هم‌زمان روی یک مسیر در همان فایل موقت
 * می‌نویسند و نتیجه ترکیب دو خروجی است — دقیقاً همان خرابی‌ای که
 * نوشتن اتمیک قرار بود جلویش را بگیرد.
 */
function temporaryPathFor(filePath: string): string {
  const unique = `${process.pid.toString(36)}${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  return `${filePath}.${unique}.tmp`;
}
