/**
 * Log of agent tool calls that pass through the Gateway.
 *
 * Every `tools/call` on `/mcp` is recorded once it has an answer: which
 * project and tool, a preview of the arguments, how long it took, whether it
 * failed and how large the result was. The newest entries are kept in memory
 * for the console (filter, sort, statistics) and every entry is appended to
 * `<dataRoot>/gateway/requests.jsonl`, so the log survives a restart.
 *
 * Only a bounded preview of the arguments is stored, never the result text.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface RequestLogEntry {
  /** Monotonic within one log file generation; unique together with `at`. */
  readonly id: number;
  /** Epoch milliseconds when the call finished. */
  readonly at: number;
  /** Project id, or '' when the call never resolved to a project. */
  readonly project: string;
  readonly tool: string;
  /** JSON of the arguments, cut to `MAX_ARGS_CHARS`. */
  readonly args: string;
  readonly durationMs: number;
  readonly ok: boolean;
  /** First line of the failure, when `ok` is false. */
  readonly error?: string;
  /** Size of the answer sent to the agent, in bytes. */
  readonly resultBytes: number;
  /** Name of the API key that made the call. */
  readonly key: string;
  /** Client software, from the User-Agent header. */
  readonly client: string;
}

export type RequestLogInput = Omit<RequestLogEntry, 'id' | 'at'> & { readonly at?: number };

export type RequestSortKey = 'at' | 'durationMs' | 'tool' | 'project' | 'resultBytes' | 'status' | 'client';

export interface RequestQuery {
  readonly project?: string;
  readonly tool?: string;
  readonly status?: 'ok' | 'error';
  readonly client?: string;
  /** Case-insensitive substring matched against tool, project, arguments and error. */
  readonly q?: string;
  readonly from?: number;
  readonly to?: number;
  readonly sort?: RequestSortKey;
  readonly order?: 'asc' | 'desc';
  readonly limit?: number;
  readonly offset?: number;
}

export interface RequestPage {
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly items: readonly RequestLogEntry[];
  /** Distinct values in the whole log, for the filter controls. */
  readonly facets: { readonly projects: string[]; readonly tools: string[]; readonly clients: string[] };
}

export interface GroupStat {
  readonly name: string;
  readonly count: number;
  readonly errors: number;
  readonly avgMs: number;
  readonly p95Ms: number;
}

export interface RequestStats {
  readonly windowMs: number;
  readonly total: number;
  readonly errors: number;
  /** 0–1. */
  readonly errorRate: number;
  readonly avgMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly resultBytes: number;
  readonly byTool: readonly GroupStat[];
  readonly byProject: readonly GroupStat[];
  readonly byClient: readonly GroupStat[];
  /** Equal-width buckets covering the window, oldest first. */
  readonly timeline: readonly { readonly at: number; readonly count: number; readonly errors: number }[];
}

export interface RequestLogOptions {
  /** File to append to; omit for a memory-only log (tests). */
  readonly filePath?: string;
  /** Entries kept in memory. */
  readonly capacity?: number;
  /** The file is rotated to `<file>.1` once it grows past this. */
  readonly maxFileBytes?: number;
  readonly onRecord?: (entry: RequestLogEntry) => void;
  readonly now?: () => number;
}

export const MAX_ARGS_CHARS = 500;
const MAX_ERROR_CHARS = 300;
const DEFAULT_CAPACITY = 5000;
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const TIMELINE_BUCKETS = 24;
const SORT_KEYS: ReadonlySet<string> = new Set(['at', 'durationMs', 'tool', 'project', 'resultBytes', 'status', 'client']);

/** JSON preview of tool arguments, bounded so one large argument cannot bloat the log. */
export function previewArgs(args: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(args ?? {});
  } catch {
    text = '[unserializable]';
  }
  return text.length > MAX_ARGS_CHARS ? `${text.slice(0, MAX_ARGS_CHARS)}…` : text;
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}

function summarize(durations: number[]): { avgMs: number; p50Ms: number; p95Ms: number } {
  if (durations.length === 0) return { avgMs: 0, p50Ms: 0, p95Ms: 0 };
  const sorted = [...durations].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return { avgMs: Math.round(sum / sorted.length), p50Ms: percentile(sorted, 0.5), p95Ms: percentile(sorted, 0.95) };
}

function groupBy(entries: readonly RequestLogEntry[], key: (entry: RequestLogEntry) => string): GroupStat[] {
  const groups = new Map<string, RequestLogEntry[]>();
  for (const entry of entries) {
    const name = key(entry) || '(none)';
    const list = groups.get(name);
    if (list) list.push(entry);
    else groups.set(name, [entry]);
  }
  return Array.from(groups, ([name, list]) => {
    const { avgMs, p95Ms } = summarize(list.map(entry => entry.durationMs));
    return { name, count: list.length, errors: list.filter(entry => !entry.ok).length, avgMs, p95Ms };
  }).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function isEntry(value: unknown): value is RequestLogEntry {
  const entry = value as Partial<RequestLogEntry> | null;
  return (
    typeof entry === 'object' && entry !== null &&
    typeof entry.at === 'number' && typeof entry.tool === 'string' && typeof entry.ok === 'boolean' &&
    typeof entry.durationMs === 'number'
  );
}

export class RequestLog {
  private entries: RequestLogEntry[] = [];
  private nextId = 1;
  private fileBytes = 0;
  private writing: Promise<void> = Promise.resolve();
  private readonly capacity: number;
  private readonly maxFileBytes: number;
  private readonly now: () => number;

  constructor(private readonly options: RequestLogOptions = {}) {
    this.capacity = options.capacity ?? DEFAULT_CAPACITY;
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.now = options.now ?? Date.now;
    if (options.filePath) this.restore(options.filePath);
  }

  /** Reads back what earlier runs wrote, newest `capacity` entries. A damaged line is skipped. */
  private restore(filePath: string): void {
    const read = (file: string): RequestLogEntry[] => {
      let text: string;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        return [];
      }
      const out: RequestLogEntry[] = [];
      for (const line of text.split('\n')) {
        if (line === '') continue;
        try {
          const parsed: unknown = JSON.parse(line);
          if (isEntry(parsed)) out.push(parsed);
        } catch {
          /* a line cut short by a crash */
        }
      }
      return out;
    };
    const current = read(filePath);
    const all = current.length >= this.capacity ? current : [...read(`${filePath}.1`), ...current];
    this.entries = all.slice(-this.capacity);
    this.nextId = this.entries.reduce((max, entry) => Math.max(max, entry.id ?? 0), 0) + 1;
    try {
      this.fileBytes = fs.statSync(filePath).size;
    } catch {
      this.fileBytes = 0;
    }
  }

  record(input: RequestLogInput): RequestLogEntry {
    const entry: RequestLogEntry = {
      id: this.nextId++,
      at: input.at ?? this.now(),
      project: input.project,
      tool: input.tool,
      args: input.args,
      durationMs: Math.max(0, Math.round(input.durationMs)),
      ok: input.ok,
      ...(input.error ? { error: input.error.split('\n')[0]!.slice(0, MAX_ERROR_CHARS) } : {}),
      resultBytes: input.resultBytes,
      key: input.key,
      client: input.client,
    };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
    this.persist(entry);
    try {
      this.options.onRecord?.(entry);
    } catch {
      /* a listener must not break the call that is being logged */
    }
    return entry;
  }

  private persist(entry: RequestLogEntry): void {
    const filePath = this.options.filePath;
    if (!filePath) return;
    const line = `${JSON.stringify(entry)}\n`;
    this.writing = this.writing
      .then(async () => {
        if (this.fileBytes + line.length > this.maxFileBytes && this.fileBytes > 0) {
          await fs.promises.rename(filePath, `${filePath}.1`);
          this.fileBytes = 0;
        }
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.appendFile(filePath, line, { mode: 0o600 });
        this.fileBytes += Buffer.byteLength(line);
      })
      .catch(() => {
        /* logging is best effort: a full disk must not fail tool calls */
      });
  }

  /** Resolves once everything recorded so far is on disk. */
  flush(): Promise<void> {
    return this.writing;
  }

  get size(): number {
    return this.entries.length;
  }

  query(query: RequestQuery = {}): RequestPage {
    const needle = query.q?.trim().toLowerCase();
    const matched = this.entries.filter(entry => {
      if (query.project && entry.project !== query.project) return false;
      if (query.tool && entry.tool !== query.tool) return false;
      if (query.client && entry.client !== query.client) return false;
      if (query.status === 'ok' && !entry.ok) return false;
      if (query.status === 'error' && entry.ok) return false;
      if (query.from !== undefined && entry.at < query.from) return false;
      if (query.to !== undefined && entry.at > query.to) return false;
      if (needle) {
        const haystack = `${entry.tool} ${entry.project} ${entry.args} ${entry.error ?? ''}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });

    const sort: RequestSortKey = query.sort && SORT_KEYS.has(query.sort) ? query.sort : 'at';
    const direction = (query.order ?? (sort === 'at' ? 'desc' : 'asc')) === 'asc' ? 1 : -1;
    const value = (entry: RequestLogEntry): string | number =>
      sort === 'status' ? (entry.ok ? 1 : 0) : entry[sort];
    matched.sort((a, b) => {
      const left = value(a);
      const right = value(b);
      const compared = typeof left === 'number' && typeof right === 'number'
        ? left - right
        : String(left).localeCompare(String(right));
      /* ties keep the newest first, so a sorted column still reads chronologically */
      return compared !== 0 ? compared * direction : b.at - a.at || b.id - a.id;
    });

    const limit = Math.min(500, Math.max(1, Math.floor(query.limit ?? 50)));
    const offset = Math.max(0, Math.floor(query.offset ?? 0));
    const distinct = (pick: (entry: RequestLogEntry) => string): string[] =>
      Array.from(new Set(this.entries.map(pick).filter(text => text !== ''))).sort();
    return {
      total: matched.length,
      offset,
      limit,
      items: matched.slice(offset, offset + limit),
      facets: {
        projects: distinct(entry => entry.project),
        tools: distinct(entry => entry.tool),
        clients: distinct(entry => entry.client),
      },
    };
  }

  stats(windowMs: number): RequestStats {
    const end = this.now();
    const start = end - windowMs;
    const inWindow = this.entries.filter(entry => entry.at >= start && entry.at <= end);
    const errors = inWindow.filter(entry => !entry.ok).length;
    const bucketMs = windowMs / TIMELINE_BUCKETS;
    const timeline = Array.from({ length: TIMELINE_BUCKETS }, (_, index) => ({
      at: Math.round(start + index * bucketMs),
      count: 0,
      errors: 0,
    }));
    for (const entry of inWindow) {
      const bucket = timeline[Math.min(TIMELINE_BUCKETS - 1, Math.floor((entry.at - start) / bucketMs))]!;
      bucket.count += 1;
      if (!entry.ok) bucket.errors += 1;
    }
    return {
      windowMs,
      total: inWindow.length,
      errors,
      errorRate: inWindow.length === 0 ? 0 : errors / inWindow.length,
      ...summarize(inWindow.map(entry => entry.durationMs)),
      resultBytes: inWindow.reduce((total, entry) => total + entry.resultBytes, 0),
      byTool: groupBy(inWindow, entry => entry.tool),
      byProject: groupBy(inWindow, entry => entry.project),
      byClient: groupBy(inWindow, entry => entry.client),
      timeline,
    };
  }
}
