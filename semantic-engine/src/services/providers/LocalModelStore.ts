/**
 * LocalModelStore — the catalogue of local embedding models and their
 * on-disk state.
 *
 * Models are plain Hugging Face repositories in the layout
 * `@xenova/transformers` reads when `env.localModelPath` points at a folder:
 *
 * ```text
 * <modelsDir>/Xenova/all-MiniLM-L6-v2/config.json
 *                                     tokenizer.json
 *                                     onnx/model_quantized.onnx
 * ```
 *
 * Only ids from the catalogue can be downloaded, and every URL is built from
 * the id plus a fixed file list. A caller therefore cannot make the server
 * fetch an arbitrary host or write outside `modelsDir`.
 *
 * `hashing-256` is built in: always ready, nothing to download.
 */

import * as fs from 'fs';
import * as path from 'path';
import { LOCAL_DEFAULT_EMBEDDING_MODEL } from '../../core/config/GlobalConfig';

export const HUGGING_FACE_BASE = 'https://huggingface.co';
const COMPLETE_MARKER = '.complete.json';

export interface CatalogModel {
  readonly id: string;
  readonly name: string;
  readonly dimensions: number;
  /** Approximate download size of the quantised ONNX model, in MB. */
  readonly sizeMb: number;
  readonly languages: string;
  readonly description: string;
  readonly builtIn?: boolean;
}

export const LOCAL_MODEL_CATALOG: readonly CatalogModel[] = [
  {
    id: LOCAL_DEFAULT_EMBEDDING_MODEL,
    name: 'Deterministic hashing',
    dimensions: 256,
    sizeMb: 0,
    languages: 'any',
    description: 'Built in. Offline and instant, but keyword-level only — not a neural model.',
    builtIn: true,
  },
  {
    id: 'Xenova/all-MiniLM-L6-v2',
    name: 'all-MiniLM-L6-v2',
    dimensions: 384,
    sizeMb: 23,
    languages: 'English',
    description: 'Small and fast general-purpose sentence embeddings.',
  },
  {
    id: 'Xenova/bge-small-en-v1.5',
    name: 'bge-small-en-v1.5',
    dimensions: 384,
    sizeMb: 34,
    languages: 'English',
    description: 'Strong retrieval quality for its size.',
  },
  {
    id: 'Xenova/gte-small',
    name: 'gte-small',
    dimensions: 384,
    sizeMb: 34,
    languages: 'English',
    description: 'General text embeddings, good on code-adjacent text.',
  },
  {
    id: 'Xenova/bge-base-en-v1.5',
    name: 'bge-base-en-v1.5',
    dimensions: 768,
    sizeMb: 110,
    languages: 'English',
    description: 'Higher quality, larger and slower.',
  },
  {
    id: 'Xenova/multilingual-e5-small',
    name: 'multilingual-e5-small',
    dimensions: 384,
    sizeMb: 118,
    languages: 'multilingual (incl. Persian)',
    description: 'Use when comments or docs are not only English.',
  },
  {
    id: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
    name: 'paraphrase-multilingual-MiniLM-L12-v2',
    dimensions: 384,
    sizeMb: 118,
    languages: 'multilingual (incl. Persian)',
    description: 'Multilingual sentence embeddings.',
  },
];

interface ModelFile {
  readonly path: string;
  readonly optional: boolean;
}

const MODEL_FILES: readonly ModelFile[] = [
  { path: 'config.json', optional: false },
  { path: 'tokenizer.json', optional: false },
  { path: 'tokenizer_config.json', optional: false },
  { path: 'special_tokens_map.json', optional: true },
  { path: 'onnx/model_quantized.onnx', optional: false },
];

export type ModelStatus = 'ready' | 'missing' | 'downloading' | 'failed';

export interface LocalModelInfo extends CatalogModel {
  readonly status: ModelStatus;
  readonly receivedBytes?: number;
  readonly totalBytes?: number;
  readonly error?: string;
  /** Absolute folder of a downloaded model. */
  readonly location?: string;
}

interface DownloadState {
  status: 'downloading' | 'failed';
  receivedBytes: number;
  totalBytes: number;
  error?: string;
  readonly done: Promise<void>;
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: unknown;
}>;

export interface LocalModelStoreOptions {
  readonly modelsDir: string;
  /** Abort a download that receives nothing for this long. Default 60 s. */
  readonly idleTimeoutMs?: number;
  readonly fetchImpl?: FetchLike;
  readonly baseUrl?: string;
}

export class LocalModelStore {
  private readonly downloads = new Map<string, DownloadState>();
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;

  constructor(private readonly options: LocalModelStoreOptions) {
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.baseUrl = options.baseUrl ?? HUGGING_FACE_BASE;
  }

  get modelsDir(): string {
    return this.options.modelsDir;
  }

  catalogEntry(id: string): CatalogModel | undefined {
    return LOCAL_MODEL_CATALOG.find(model => model.id === id);
  }

  modelDir(id: string): string {
    const entry = this.catalogEntry(id);
    if (!entry || entry.builtIn) throw new Error(`"${id}" is not a downloadable model`);
    return path.join(this.options.modelsDir, ...id.split('/'));
  }

  /** Downloaded and complete — safe to hand to the runtime. */
  isReady(id: string): boolean {
    const entry = this.catalogEntry(id);
    if (!entry) return false;
    if (entry.builtIn) return true;

    const dir = this.modelDir(id);
    try {
      const marker = JSON.parse(fs.readFileSync(path.join(dir, COMPLETE_MARKER), 'utf8')) as {
        files?: Record<string, number>;
      };
      const files = marker.files ?? {};
      const required = MODEL_FILES.filter(file => !file.optional);
      return required.every(file => {
        const expected = files[file.path];
        if (expected === undefined) return false;
        try {
          return fs.statSync(path.join(dir, ...file.path.split('/'))).size === expected;
        } catch {
          return false;
        }
      });
    } catch {
      return false;
    }
  }

  list(): LocalModelInfo[] {
    return LOCAL_MODEL_CATALOG.map(entry => {
      const download = this.downloads.get(entry.id);
      if (download?.status === 'downloading') {
        return {
          ...entry,
          status: 'downloading' as const,
          receivedBytes: download.receivedBytes,
          totalBytes: download.totalBytes,
        };
      }
      if (this.isReady(entry.id)) {
        return {
          ...entry,
          status: 'ready' as const,
          ...(entry.builtIn ? {} : { location: this.modelDir(entry.id) }),
        };
      }
      if (download?.status === 'failed') {
        return { ...entry, status: 'failed' as const, ...(download.error ? { error: download.error } : {}) };
      }
      return { ...entry, status: 'missing' as const };
    });
  }

  /** Start (or join) a download. Resolves once it is *started*, not finished. */
  start(id: string): LocalModelInfo {
    const entry = this.catalogEntry(id);
    if (!entry) throw new Error(`unknown model: ${id}`);
    if (entry.builtIn || this.isReady(id)) return this.info(id);

    const running = this.downloads.get(id);
    if (running?.status === 'downloading') return this.info(id);

    const state: DownloadState = {
      status: 'downloading',
      receivedBytes: 0,
      totalBytes: 0,
      done: Promise.resolve(),
    };
    (state as { done: Promise<void> }).done = this.run(id, state).then(
      () => {
        this.downloads.delete(id);
      },
      error => {
        state.status = 'failed';
        state.error = error instanceof Error ? error.message : String(error);
      }
    );
    this.downloads.set(id, state);
    return this.info(id);
  }

  /** Wait for a started download (tests, CLI). */
  async finished(id: string): Promise<void> {
    await this.downloads.get(id)?.done;
  }

  remove(id: string): boolean {
    const entry = this.catalogEntry(id);
    if (!entry || entry.builtIn) return false;
    if (this.downloads.get(id)?.status === 'downloading') {
      throw new Error('model is being downloaded; wait for it to finish');
    }
    this.downloads.delete(id);
    fs.rmSync(this.modelDir(id), { recursive: true, force: true });
    return true;
  }

  private info(id: string): LocalModelInfo {
    return this.list().find(model => model.id === id)!;
  }

  private async run(id: string, state: DownloadState): Promise<void> {
    const dir = this.modelDir(id);
    fs.mkdirSync(dir, { recursive: true });
    fs.rmSync(path.join(dir, COMPLETE_MARKER), { force: true });

    const sizes: Record<string, number> = {};
    const idleMs = this.options.idleTimeoutMs ?? 60_000;

    for (const file of MODEL_FILES) {
      const url = `${this.baseUrl}/${id}/resolve/main/${file.path}`;

      /*
      | A connection that stays open but sends nothing would leave the model
      | "downloading" forever, with no way to retry. The timer is re-armed on
      | every chunk, so only a genuine stall aborts.
      */
      const controller = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      const arm = (): void => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => controller.abort(), idleMs);
      };
      arm();

      try {
        let response: Awaited<ReturnType<FetchLike>>;
        try {
          response = await this.fetchImpl(url, { signal: controller.signal });
        } catch (error) {
          if (controller.signal.aborted) {
            throw new Error(`download of ${file.path} stalled (no data for ${Math.round(idleMs / 1000)}s)`);
          }
          /* undici reports only "fetch failed"; the cause names the host and reason. */
          const cause = (error as { cause?: { code?: string; message?: string } }).cause;
          const reason = cause?.code ?? cause?.message ?? (error as Error).message;
          throw new Error(
            `cannot reach ${new URL(url).host} (${reason}). Set models.hubUrl to a mirror if this network blocks it.`
          );
        }

        if (response.status === 404 && file.optional) continue;
        if (!response.ok) {
          throw new Error(`download failed for ${file.path}: HTTP ${response.status}`);
        }

        const length = Number(response.headers.get('content-length') ?? 0);
        if (length > 0) state.totalBytes += length;

        const target = path.join(dir, ...file.path.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const temp = `${target}.part`;
        let written: number;
        try {
          written = await writeStream(response.body, temp, chunk => {
            arm();
            state.receivedBytes += chunk;
            if (state.receivedBytes > state.totalBytes) state.totalBytes = state.receivedBytes;
          });
        } catch (error) {
          if (controller.signal.aborted) {
            throw new Error(`download of ${file.path} stalled (no data for ${Math.round(idleMs / 1000)}s)`);
          }
          throw error;
        }

        if (length > 0 && written !== length) {
          fs.rmSync(temp, { force: true });
          throw new Error(`download of ${file.path} was cut short (${written} of ${length} bytes)`);
        }
        fs.renameSync(temp, target);
        sizes[file.path] = written;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    fs.writeFileSync(
      path.join(dir, COMPLETE_MARKER),
      JSON.stringify({ id, files: sizes, downloadedAt: new Date().toISOString() }, null, 2)
    );
  }
}

/** Stream a fetch body to disk without holding it in memory. */
async function writeStream(
  body: unknown,
  target: string,
  onChunk: (bytes: number) => void
): Promise<number> {
  if (!body) throw new Error('empty response body');

  const out = fs.createWriteStream(target);
  /* A disk error (full, read-only) must fail the download, not hang on 'drain'. */
  let streamError: Error | null = null;
  out.on('error', error => { streamError = error; });
  let written = 0;
  try {
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      if (streamError) throw streamError;
      written += chunk.byteLength;
      onChunk(chunk.byteLength);
      if (!out.write(chunk)) {
        /* `once` pairs on a long-lived stream leak a listener per wait. */
        await new Promise<void>((resolve, reject) => {
          const onDrain = (): void => { out.off('error', onError); resolve(); };
          const onError = (error: Error): void => { out.off('drain', onDrain); reject(error); };
          out.once('drain', onDrain);
          out.once('error', onError);
        });
      }
    }
  } catch (error) {
    out.destroy();
    fs.rmSync(target, { force: true });
    throw error;
  }
  await new Promise<void>((resolve, reject) => {
    if (streamError) return reject(streamError);
    out.once('error', reject);
    out.end(resolve);
  });
  return written;
}
