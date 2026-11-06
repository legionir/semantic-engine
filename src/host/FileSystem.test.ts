/**
 * پورت فایل‌سیستم — MIG-14 و SE-EXP-01.
 *
 * دو مشکل واقعی که این فایل حل می‌کند:
 *
 * ۱. **نوشتن غیراتمیک.** امروز `JsonExporter` مستقیم روی مسیر مقصد
 *    می‌نویسد. کرش یا Ctrl-C وسط نوشتن، یک `project-index.json` نصفه و
 *    غیرقابل parse باقی می‌گذارد — و ایندکس قبلی هم رفته است.
 * ۲. **سریالایز کامل در حافظه.** `JSON.stringify` روی کل ایندکس یک رشتهٔ
 *    واحد می‌سازد. سقف طول رشته در V8 یک دیوار سخت است و با embedding
 *    فعال (۳۸۴ عدد به‌ازای هر chunk) دور نیست.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { Writable } from 'stream';
import { NodeFileSystem, jsonChunks, stringifyToStream } from './FileSystem';

let dir: string;
let port: NodeFileSystem;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-fs-'));
  port = new NodeFileSystem();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const target = (name = 'out.json') => path.join(dir, name);

describe('jsonChunks', () => {

  const cases: Array<[string, unknown]> = [
    ['null', null],
    ['a number', 42],
    ['a negative float', -0.5],
    ['a boolean', true],
    ['a plain string', 'hello'],
    ['a string with quotes and backslashes', 'he said "hi"\\ok'],
    ['a string with control characters', 'tab\there\nnewline\u0001'],
    ['a string with non-ascii text', 'مسیر فایل — ✓ 🚀'],
    ['an empty object', {}],
    ['an empty array', []],
    ['a flat object', { a: 1, b: 'two', c: false }],
    ['a nested object', { a: { b: { c: [1, 2, { d: null }] } } }],
    ['an array of objects', [{ id: 'a' }, { id: 'b' }]],
    ['an object with an undefined value', { kept: 1, dropped: undefined }],
    ['an array with holes and undefined', [1, undefined, 3]],
    ['an object with a function value', { fn: () => 1, kept: 2 }],
    ['NaN and Infinity', { a: NaN, b: Infinity, c: -Infinity }],
    ['a Date, which has toJSON', { at: new Date('2026-08-18T09:00:00.000Z') }],
    ['an object whose toJSON returns a primitive', { x: { toJSON: () => 'flat' } }],
    ['keys needing escapes', { 'a"b': 1, 'c\nd': 2 }],
    ['a deep array', [[[[[[1]]]]]]],
  ];

  /*
  | خروجی باید *بایت‌به‌بایت* با JSON.stringify یکی باشد. هر تفاوتی —
  | حتی در escape یک کاراکتر کنترلی — یعنی خروجی این ابزار با هر ابزار
  | دیگری فرق دارد و snapshot طلایی بی‌معنی می‌شود.
  */
  it.each(cases)('matches JSON.stringify for %s (compact)', (_name, value) => {
    expect([...jsonChunks(value)].join('')).toBe(JSON.stringify(value));
  });

  it.each(cases)('matches JSON.stringify for %s (pretty)', (_name, value) => {
    expect([...jsonChunks(value, { pretty: true })].join('')).toBe(JSON.stringify(value, null, 2));
  });

  it('matches JSON.stringify on a realistic index shape', () => {
    const index = {
      schemaVersion: '1.0.0',
      files: Array.from({ length: 50 }, (_, i) => ({
        id: `f${i}`,
        path: `src/a/b${i}.ts`,
        language: 'typescript',
        imports: [],
        metrics: { loc: i, complexity: null },
      })),
      vectorChunks: Array.from({ length: 20 }, (_, i) => ({
        id: `v${i}`,
        embedding: Array.from({ length: 16 }, (_, j) => j / 3),
      })),
    };

    expect([...jsonChunks(index, { pretty: true })].join(''))
      .toBe(JSON.stringify(index, null, 2));
  });

  /*
  | این تستِ کل هدف است. اگر روزی کسی پیاده‌سازی را به یک
  | `yield JSON.stringify(value)` ساده برگرداند، اینجا می‌شکند — و همان
  | لحظه‌ای است که سقف طول رشته دوباره وارد میدان می‌شود.
  */
  it('never builds the whole document as one string', () => {
    const big = { items: Array.from({ length: 5_000 }, (_, i) => ({ i, name: `item ${i}` })) };

    const chunks = [...jsonChunks(big, { pretty: true })];
    const longest = Math.max(...chunks.map(chunk => chunk.length));

    expect(chunks.length).toBeGreaterThan(5_000);
    expect(longest).toBeLessThan(1_024);
  });

  it('refuses a circular structure the same way JSON.stringify does', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => [...jsonChunks(cyclic)]).toThrow(TypeError);
  });

  it('reports the path to the circular reference, which JSON.stringify hides', () => {
    const cyclic: Record<string, unknown> = { files: [{ deps: {} }] };
    ((cyclic.files as Array<Record<string, unknown>>)[0].deps as Record<string, unknown>).back =
      cyclic;

    expect(() => [...jsonChunks(cyclic)]).toThrow(/files\[0\]\.deps\.back/);
  });

  it('yields nothing for a value JSON.stringify turns into undefined', () => {
    expect([...jsonChunks(undefined)]).toEqual([]);
    expect([...jsonChunks(() => 1)]).toEqual([]);
  });
});

describe('stringifyToStream', () => {

  it('writes the same bytes as JSON.stringify', async () => {
    const value = { a: [1, 2, 3], b: 'x' };
    const file = target();
    const stream = fs.createWriteStream(file);

    await stringifyToStream(value, stream, { pretty: true });
    await new Promise(resolve => stream.end(resolve));

    expect(fs.readFileSync(file, 'utf8')).toBe(JSON.stringify(value, null, 2));
  });

  /*
  | بدون احترام به backpressure، یک ایندکس بزرگ کل بافر را در حافظه
  | نگه می‌دارد و همان مشکلی را می‌سازد که قرار بود حل شود.
  */
  it('waits for drain instead of buffering everything', async () => {
    const written: string[] = [];
    let drainListener: (() => void) | undefined;
    const stream = {
      write(chunk: string): boolean {
        written.push(chunk);
        // فقط اولین نوشتن بافر را پر می‌کند؛ بعد از drain راه باز است.
        return written.length !== 1;
      },
      once(event: string, listener: () => void): void {
        if (event === 'drain') drainListener = listener;
      },
      removeListener(): void {},
    };

    const done = stringifyToStream(
      { items: Array.from({ length: 100 }, (_, i) => i) },
      stream as never,
      { pretty: true }
    );

    await new Promise(resolve => setImmediate(resolve));
    expect(written).toHaveLength(1);
    expect(drainListener).toBeDefined();

    drainListener?.();
    await done;

    expect(written.length).toBeGreaterThan(100);
    expect(written.join('')).toBe(
      JSON.stringify({ items: Array.from({ length: 100 }, (_, i) => i) }, null, 2)
    );
  });
});

describe('writeFileAtomic', () => {

  it('writes the content', async () => {
    await port.writeFileAtomic(target('a.txt'), 'hello');

    expect(fs.readFileSync(target('a.txt'), 'utf8')).toBe('hello');
  });

  it('creates missing parent directories', async () => {
    const nested = path.join(dir, 'deep', 'deeper', 'file.txt');

    await port.writeFileAtomic(nested, 'x');

    expect(fs.readFileSync(nested, 'utf8')).toBe('x');
  });

  it('replaces existing content completely, leaving no tail of the old file', async () => {
    fs.writeFileSync(target('a.txt'), 'a very long previous content');

    await port.writeFileAtomic(target('a.txt'), 'short');

    expect(fs.readFileSync(target('a.txt'), 'utf8')).toBe('short');
  });

  it('leaves no temporary file behind', async () => {
    await port.writeFileAtomic(target('a.txt'), 'x');

    expect(fs.readdirSync(dir)).toEqual(['a.txt']);
  });

  it('accepts a Buffer as well as a string', async () => {
    await port.writeFileAtomic(target('a.bin'), Buffer.from([0, 1, 2, 255]));

    expect([...fs.readFileSync(target('a.bin'))]).toEqual([0, 1, 2, 255]);
  });

  /*
  | معیار پذیرش فاز: خرابی وسط نوشتن نباید فایل مقصد را نابود کند.
  | اینجا خرابی تزریق می‌شود تا تست قطعی باشد؛ نسخهٔ واقعیِ SIGKILL در
  | سند فاز ثبت شده است.
  */
  it('keeps the previous file intact when the write fails midway', async () => {
    fs.writeFileSync(target(), '{"previous":"index"}');
    const failing = new NodeFileSystem({
      fsImpl: {
        ...fs.promises,
        writeFile: async () => {
          throw new Error('ENOSPC: no space left on device');
        },
      } as unknown as typeof fs.promises,
    });

    await expect(failing.writeFileAtomic(target(), 'new')).rejects.toThrow('ENOSPC');

    expect(fs.readFileSync(target(), 'utf8')).toBe('{"previous":"index"}');
  });

  /*
  | Windows refuses to rename over a file another process has open (EPERM) and
  | allows it a moment later. A job must not die at 90% because a reader or a
  | virus scanner held the index for a few milliseconds.
  */
  const renameFailing = (times: number, code: string) => {
    let calls = 0;
    const impl = {
      ...fs.promises,
      rename: async (from: string, to: string) => {
        calls += 1;
        if (calls <= times) throw Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
        return fs.promises.rename(from, to);
      },
    } as unknown as typeof fs.promises;
    return { port: new NodeFileSystem({ fsImpl: impl, renamePausesMs: [1, 1, 1, 1, 1] }), calls: () => calls };
  };
  const onlyOn = (platform: NodeJS.Platform) => (process.platform === platform ? it : it.skip);

  onlyOn('win32')('retries a rename that fails with EPERM while the target is briefly held open', async () => {
    fs.writeFileSync(target(), 'previous');
    const { port: flaky, calls } = renameFailing(3, 'EPERM');

    await flaky.writeFileAtomic(target(), 'new');

    expect(fs.readFileSync(target(), 'utf8')).toBe('new');
    expect(calls()).toBe(4);
    expect(fs.readdirSync(dir)).toEqual(['out.json']);
  });

  onlyOn('win32')('gives up on a rename that keeps failing and removes the temporary file', async () => {
    fs.writeFileSync(target(), 'previous');
    const { port: stuck } = renameFailing(1_000, 'EBUSY');

    await expect(stuck.writeFileAtomic(target(), 'new')).rejects.toThrow('EBUSY');

    expect(fs.readFileSync(target(), 'utf8')).toBe('previous');
    expect(fs.readdirSync(dir)).toEqual(['out.json']);
  });

  it('cleans up its temporary file when the write fails', async () => {
    fs.writeFileSync(target(), 'previous');
    const failing = new NodeFileSystem({
      fsImpl: {
        ...fs.promises,
        rename: async () => {
          throw new Error('EXDEV: cross-device link');
        },
      } as unknown as typeof fs.promises,
    });

    await expect(failing.writeFileAtomic(target(), 'new')).rejects.toThrow('EXDEV');

    expect(fs.readdirSync(dir)).toEqual(['out.json']);
  });

  /*
  | دو نویسنده روی یک مسیر: فایل نهایی باید *یکی از دو* محتوای کامل
  | باشد، نه ترکیب. اگر نام فایل موقت ثابت باشد، دقیقاً ترکیب می‌شود.
  */
  it('survives two concurrent writers to the same path', async () => {
    const first = 'a'.repeat(200_000);
    const second = 'b'.repeat(200_000);

    await Promise.all([
      port.writeFileAtomic(target('c.txt'), first),
      port.writeFileAtomic(target('c.txt'), second),
    ]);

    const content = fs.readFileSync(target('c.txt'), 'utf8');
    expect([first, second]).toContain(content);
    expect(fs.readdirSync(dir)).toEqual(['c.txt']);
  });

  it('flushes to disk before renaming, so a power cut cannot lose the body', async () => {
    const calls: string[] = [];
    const port2 = new NodeFileSystem({
      fsImpl: new Proxy(fs.promises, {
        get(base, key: string) {
          const value = (base as unknown as Record<string, unknown>)[key];
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            calls.push(key);
            return (value as (...a: unknown[]) => unknown)(...args);
          };
        },
      }) as typeof fs.promises,
    });

    await port2.writeFileAtomic(target('d.txt'), 'x');

    expect(calls.indexOf('open')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('rename')).toBeGreaterThan(calls.indexOf('open'));
  });
});

describe('writeJsonAtomic', () => {

  it('produces exactly what JSON.stringify would', async () => {
    const value = { b: 2, a: [1, null, 'x'] };

    await port.writeJsonAtomic(target(), value, { pretty: true });

    expect(fs.readFileSync(target(), 'utf8')).toBe(JSON.stringify(value, null, 2));
  });

  it('writes compact output when asked', async () => {
    await port.writeJsonAtomic(target(), { a: 1 });

    expect(fs.readFileSync(target(), 'utf8')).toBe('{"a":1}');
  });

  it('is atomic too: a failure leaves the old index readable', async () => {
    fs.writeFileSync(target(), '{"good":true}');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    await expect(port.writeJsonAtomic(target(), cyclic)).rejects.toThrow(TypeError);

    expect(JSON.parse(fs.readFileSync(target(), 'utf8'))).toEqual({ good: true });
    expect(fs.readdirSync(dir)).toEqual(['out.json']);
  });

  it('round-trips an index far larger than a comfortable single string', async () => {
    const value = {
      vectorChunks: Array.from({ length: 12_000 }, (_, i) => ({
        id: `chunk-${i}`,
        text: 'lorem ipsum dolor sit amet '.repeat(4),
        embedding: Array.from({ length: 64 }, (_, j) => (i + j) / 7),
      })),
    };

    await port.writeJsonAtomic(target(), value, { pretty: true });

    const size = fs.statSync(target()).size;
    expect(size).toBeGreaterThan(20_000_000);
    expect(JSON.parse(fs.readFileSync(target(), 'utf8')).vectorChunks).toHaveLength(12_000);
  }, 120_000);
});

describe('temporary files left by a hard kill', () => {

  /*
  | کشتن واقعی پروسه با SIGKILL وسط نوشتن ثبت شد: فایل مقصد سالم ماند
  | (خوب) ولی یک `index.json.<id>.tmp` ده‌مگابایتی جا ماند (بد). هیچ
  | مسیر خطایی اجرا نمی‌شود وقتی پروسه اصلاً فرصت اجرا ندارد، پس
  | پاک‌سازی باید در *نوشتن بعدی* اتفاق بیفتد. — SE-EXP-12
  */

  const stale = (name: string): string => path.join(dir, name);

  it('removes an orphan temporary of the same target on the next write', async () => {
    const orphan = stale('out.json.abc123.tmp');
    fs.writeFileSync(orphan, 'half written');
    fs.utimesSync(orphan, new Date(Date.now() - 7_200_000), new Date(Date.now() - 7_200_000));

    await port.writeFileAtomic(target(), '{"fresh":true}');

    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual(['out.json']);
  });

  it('also sweeps before a json write', async () => {
    const orphan = stale('out.json.old999.tmp');
    fs.writeFileSync(orphan, 'x');
    fs.utimesSync(orphan, new Date(Date.now() - 7_200_000), new Date(Date.now() - 7_200_000));

    await port.writeJsonAtomic(target(), { fresh: true });

    expect(fs.readdirSync(dir)).toEqual(['out.json']);
  });

  /*
  | مهم‌تر از جاروکردن: *جارو نکردنِ* فایل موقتی که همین حالا یک
  | نویسندهٔ دیگر دارد پرش می‌کند. حذف آن، خرابی‌ای می‌سازد بدتر از
  | چیزی که قرار بود درست شود.
  */
  it('leaves a fresh temporary of a concurrent writer alone', async () => {
    const inFlight = stale('out.json.live42.tmp');
    fs.writeFileSync(inFlight, 'being written right now');

    await port.writeFileAtomic(target(), 'x');

    expect(fs.existsSync(inFlight)).toBe(true);
  });

  it('does not touch temporaries belonging to a different target', async () => {
    const other = stale('blueprint.json.abc.tmp');
    fs.writeFileSync(other, 'x');
    fs.utimesSync(other, new Date(Date.now() - 7_200_000), new Date(Date.now() - 7_200_000));

    await port.writeFileAtomic(target(), 'x');

    expect(fs.existsSync(other)).toBe(true);
  });

  it('does not touch ordinary files that merely share the prefix', async () => {
    const neighbour = stale('out.json.backup');
    fs.writeFileSync(neighbour, 'x');
    fs.utimesSync(neighbour, new Date(Date.now() - 7_200_000), new Date(Date.now() - 7_200_000));

    await port.writeFileAtomic(target(), 'x');

    expect(fs.existsSync(neighbour)).toBe(true);
  });

  it('still writes when the sweep itself fails', async () => {
    const failing = new NodeFileSystem({
      fsImpl: {
        ...fs.promises,
        readdir: async () => {
          throw new Error('EACCES');
        },
      } as unknown as typeof fs.promises,
    });

    await failing.writeFileAtomic(target(), 'written anyway');

    expect(fs.readFileSync(target(), 'utf8')).toBe('written anyway');
  });
});

describe('the rest of the port', () => {
  it('reads a file back', async () => {
    fs.writeFileSync(target('r.txt'), 'content');

    expect(await port.readFile(target('r.txt'))).toBe('content');
  });

  it('answers exists without throwing on a missing path', async () => {
    expect(await port.exists(target('nope'))).toBe(false);
    expect(await port.exists(dir)).toBe(true);
  });

  it('creates a directory tree idempotently', async () => {
    const nested = path.join(dir, 'x', 'y');

    await port.mkdirp(nested);
    await port.mkdirp(nested);

    expect(fs.statSync(nested).isDirectory()).toBe(true);
  });

  it('removes a file and stays quiet about one that is already gone', async () => {
    fs.writeFileSync(target('gone.txt'), 'x');

    await port.remove(target('gone.txt'));
    await port.remove(target('gone.txt'));

    expect(fs.existsSync(target('gone.txt'))).toBe(false);
  });

  it('reads json', async () => {
    fs.writeFileSync(target(), '{"a":[1,2]}');

    expect(await port.readJson(target())).toEqual({ a: [1, 2] });
  });

  it('names the file when the json is broken', async () => {
    fs.writeFileSync(target(), '{oops');

    await expect(port.readJson(target())).rejects.toThrow(target());
  });
});

describe('async stream errors are never dropped or left unhandled', () => {
  /** A writable whose write() reports success, then fails on the next tick (disk full). */
  function failingStreamFactory(failAt: 'write' | 'final') {
    return ((_file: unknown) =>
      new Writable({
        write(_chunk, _encoding, callback) {
          if (failAt === 'write') process.nextTick(() => callback(new Error('disk full')));
          else callback();
        },
        final(callback) {
          callback(failAt === 'final' ? new Error('flush failed') : undefined);
        },
      })) as never;
  }

  it('stringifyToStream rejects when the stream errors although write() returned true', async () => {
    const emitter = new EventEmitter() as EventEmitter & { write(chunk: string): boolean };
    let emitted = false;
    emitter.write = () => {
      if (!emitted) {
        emitted = true;
        process.nextTick(() => emitter.emit('error', new Error('async failure')));
      }
      return true;
    };
    await expect(
      stringifyToStream(Array.from({ length: 5000 }, (_, i) => i), emitter as never)
    ).rejects.toThrow('async failure');
    expect(emitter.listenerCount('error')).toBe(0);
  });

  it('writeJsonAtomic returns the write error to the caller and keeps the previous file', async () => {
    await port.writeJsonAtomic(target(), { version: 1 });
    const failing = new NodeFileSystem({ createWriteStream: failingStreamFactory('write') });

    await expect(failing.writeJsonAtomic(target(), { version: 2, big: 'x'.repeat(1000) })).rejects.toThrow('disk full');

    expect(JSON.parse(fs.readFileSync(target(), 'utf8'))).toEqual({ version: 1 });
    expect(fs.readdirSync(dir).filter(n => n.endsWith('.tmp'))).toEqual([]);
  });

  it('an error raised while the stream is being ended is also returned, not swallowed', async () => {
    await port.writeJsonAtomic(target(), { version: 1 });
    const failing = new NodeFileSystem({ createWriteStream: failingStreamFactory('final') });

    await expect(failing.writeJsonAtomic(target(), { version: 2 })).rejects.toThrow('flush failed');
    expect(JSON.parse(fs.readFileSync(target(), 'utf8'))).toEqual({ version: 1 });
  });
});
