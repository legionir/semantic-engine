import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { FetchLike, LocalModelStore } from './LocalModelStore';

const MODEL = 'Xenova/all-MiniLM-L6-v2';

function fakeFetch(files: Record<string, string>, calls: string[] = []): FetchLike {
  return async url => {
    calls.push(url);
    const name = url.split('/resolve/main/')[1]!;
    const body = files[name];
    if (body === undefined) {
      return { ok: false, status: 404, headers: { get: () => null }, body: null };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: key => (key === 'content-length' ? String(Buffer.byteLength(body)) : null) },
      body: Readable.from([Buffer.from(body)]),
    };
  };
}

const ALL_FILES = {
  'config.json': '{}',
  'tokenizer.json': '{"t":1}',
  'tokenizer_config.json': '{}',
  'onnx/model_quantized.onnx': 'onnx-bytes',
};

describe('LocalModelStore', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-models-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('lists the catalogue: hashing is ready, the rest are missing', () => {
    const models = new LocalModelStore({ modelsDir: dir }).list();
    expect(models.find(m => m.id === 'hashing-256')?.status).toBe('ready');
    expect(models.find(m => m.id === MODEL)?.status).toBe('missing');
  });

  it('downloads into <modelsDir>/<org>/<name> and then reports ready', async () => {
    const calls: string[] = [];
    const store = new LocalModelStore({ modelsDir: dir, fetchImpl: fakeFetch(ALL_FILES, calls) });

    expect(store.start(MODEL).status).toBe('downloading');
    await store.finished(MODEL);

    expect(store.isReady(MODEL)).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'Xenova', 'all-MiniLM-L6-v2', 'onnx', 'model_quantized.onnx'), 'utf8')).toBe('onnx-bytes');
    expect(calls.every(url => url.startsWith(`https://huggingface.co/${MODEL}/resolve/main/`))).toBe(true);
    expect(fs.readdirSync(path.join(dir, 'Xenova', 'all-MiniLM-L6-v2')).some(f => f.endsWith('.part'))).toBe(false);
  });

  it('a failed download is reported and leaves the model not ready', async () => {
    const { 'onnx/model_quantized.onnx': _omit, ...incomplete } = ALL_FILES;
    const store = new LocalModelStore({ modelsDir: dir, fetchImpl: fakeFetch(incomplete) });

    store.start(MODEL);
    await store.finished(MODEL);

    const info = store.list().find(m => m.id === MODEL)!;
    expect(info.status).toBe('failed');
    expect(info.error).toMatch(/HTTP 404/);
    expect(store.isReady(MODEL)).toBe(false);
  });

  it('only catalogue ids can be downloaded — no arbitrary repos or paths', () => {
    const store = new LocalModelStore({ modelsDir: dir, fetchImpl: fakeFetch({}) });
    expect(() => store.start('evil/../../etc')).toThrow(/unknown model/);
    expect(() => store.modelDir('hashing-256')).toThrow(/not a downloadable/);
  });

  it('a truncated file is not ready even if the marker exists', async () => {
    const store = new LocalModelStore({ modelsDir: dir, fetchImpl: fakeFetch(ALL_FILES) });
    store.start(MODEL);
    await store.finished(MODEL);

    fs.writeFileSync(path.join(dir, 'Xenova', 'all-MiniLM-L6-v2', 'tokenizer.json'), 'x');
    expect(store.isReady(MODEL)).toBe(false);
  });

  it('remove deletes the folder', async () => {
    const store = new LocalModelStore({ modelsDir: dir, fetchImpl: fakeFetch(ALL_FILES) });
    store.start(MODEL);
    await store.finished(MODEL);

    expect(store.remove(MODEL)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'Xenova', 'all-MiniLM-L6-v2'))).toBe(false);
    expect(store.remove('hashing-256')).toBe(false);
  });

  it('a connection that goes silent fails the download instead of hanging', async () => {
    const stalling: FetchLike = async (_url, init) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: (async function* () {
        yield Buffer.from('partial');
        await new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      })(),
    });
    const store = new LocalModelStore({ modelsDir: dir, fetchImpl: stalling, idleTimeoutMs: 50 });

    store.start(MODEL);
    await store.finished(MODEL);

    const info = store.list().find(m => m.id === MODEL)!;
    expect(info.status).toBe('failed');
    expect(info.error).toMatch(/stalled/);
    expect(fs.readdirSync(path.join(dir, 'Xenova', 'all-MiniLM-L6-v2')).some(f => f.endsWith('.part'))).toBe(false);
  });

  it('a large download under backpressure leaks no stream listeners', async () => {
    /* Node's own MaxListeners warning is emitted on the real process, which
       Jest's sandboxed `process` cannot see — so count the listeners instead. */
    const streams: fs.WriteStream[] = [];
    const realFs = require('fs') as typeof fs;
    const original = realFs.createWriteStream;
    const spy = jest.spyOn(realFs, 'createWriteStream').mockImplementation(((...args: Parameters<typeof original>) => {
      const stream = original(...args);
      streams.push(stream);
      return stream;
    }) as typeof original);

    const chunk = Buffer.alloc(256 * 1024, 'x');
    const big: FetchLike = async url => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: Readable.from(url.endsWith('.onnx') ? Array.from({ length: 120 }, () => chunk) : [Buffer.from('{}')]),
    });
    const store = new LocalModelStore({ modelsDir: dir, fetchImpl: big });
    try {
      store.start(MODEL);
      await store.finished(MODEL);
    } finally {
      spy.mockRestore();
    }

    expect(store.isReady(MODEL)).toBe(true);
    expect(streams.length).toBeGreaterThan(0);
    for (const stream of streams) expect(stream.listenerCount('error')).toBeLessThanOrEqual(2);
  });
});
