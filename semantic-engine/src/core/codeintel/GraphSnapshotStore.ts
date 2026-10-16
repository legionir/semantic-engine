/**
 * GraphSnapshotStore — persisted semantic-graph snapshot store (G-3.1 / G-3.5, D-0021).
 *
 * Layout and contract: docs/validation/phase3-store/graph-store-design.md.
 *
 * Invariants (each is executed-tested in GraphSnapshotStore.test.ts):
 * - `current.json` only ever names a COMPLETE generation (publication is
 *   tmp-dir + rename + pointer tmp + rename; both renames are atomic).
 * - A crash mid-publication leaves an orphan generation or a tmp dir — never
 *   a torn pointer, never a half-written graph served.
 * - Handles are references to persisted state, not suggestions: a stale,
 *   mismatched or malformed handle fails closed; the store never falls back
 *   to `current()` behind the caller's back.
 * - Loading validates the record (snapshotId binding, recorded counts,
 *   schema version); older store schemas migrate, future ones reject.
 * - Cleanup never deletes the generation the pointer names.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { SemanticGraph } from './Phase3SemanticGraph';

export const GRAPH_STORE_SCHEMA_VERSION = 1;
export const STORE_POINTER_FILE = 'current.json';
export const STORE_GENERATIONS_DIR = 'generations';
const TMP_PREFIX = '.tmp-publish-';
const GENERATION_RE = /^gen-(\d{6})$/;

export interface GraphSnapshotMeta {
  readonly storeSchemaVersion: number;
  readonly graphSchemaVersion: string;
  readonly graphSnapshotId: string;
  readonly sourceIndexDigest: string;
  readonly engineVersion: string;
  readonly createdAt: string;
  readonly counts: {
    references: number; unresolved: number; hardBindings: number;
    occurrenceAudit: number; fileDeps: number;
  };
}

export interface GraphSnapshotRecord {
  readonly handle: string;
  readonly generation: number;
  readonly meta: GraphSnapshotMeta;
  readonly graph: SemanticGraph;
}

export type CrashPoint = 'before-generation-rename' | 'before-pointer-swap';

export interface PublishOptions {
  /** Test-only crash injection: throws at the named step (recovery tests). */
  readonly crashAt?: CrashPoint;
  /** Generations to keep after publication (default 3, always including the new one). */
  readonly keep?: number;
}

export type GraphSnapshotStoreErrorKind =
  | 'INVALID_HANDLE' | 'STALE_HANDLE' | 'SNAPSHOT_MISMATCH'
  | 'FUTURE_SCHEMA' | 'CORRUPT_STATE' | 'IO_ERROR';

export class GraphSnapshotStoreError extends Error {
  constructor(readonly kind: GraphSnapshotStoreErrorKind, message: string) {
    super(message);
    this.name = 'GraphSnapshotStoreError';
  }
}

interface PointerFile {
  readonly storeSchemaVersion: number;
  readonly generation: number;
  readonly handle: string;
  readonly graphSnapshotId: string;
}

function fail(kind: GraphSnapshotStoreErrorKind, message: string): never {
  throw new GraphSnapshotStoreError(kind, message);
}

const generationName = (n: number): string => `gen-${String(n).padStart(6, '0')}`;
const handleFor = (n: number, snapshotId: string): string => `${generationName(n)}@${snapshotId.slice(0, 12)}`;

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function writeFileSynced(p: string, content: string): Promise<void> {
  const handle = await fs.open(p, 'w');
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Best-effort integrity check of a deserialized graph record (fail-closed). */
function validateGraph(graph: unknown, meta: GraphSnapshotMeta): SemanticGraph {
  if (!graph || typeof graph !== 'object') fail('CORRUPT_STATE', 'graph.json is not an object');
  const g = graph as Partial<SemanticGraph>;
  if (g.schemaVersion !== meta.graphSchemaVersion) {
    fail('CORRUPT_STATE', `graph schemaVersion '${String(g.schemaVersion)}' does not match meta '${meta.graphSchemaVersion}'`);
  }
  if (g.snapshotId !== meta.graphSnapshotId) {
    fail('SNAPSHOT_MISMATCH', `graph.snapshotId '${String(g.snapshotId)}' does not match meta '${meta.graphSnapshotId}'`);
  }
  if (!Array.isArray(g.references) || !Array.isArray(g.unresolved) || !Array.isArray(g.hardBindings) || !Array.isArray(g.fileDeps)) {
    fail('CORRUPT_STATE', 'graph is missing one of references/unresolved/hardBindings/fileDeps');
  }
  if (g.references.length !== meta.counts.references || g.unresolved.length !== meta.counts.unresolved ||
      g.hardBindings.length !== meta.counts.hardBindings || g.fileDeps.length !== meta.counts.fileDeps ||
      (g.occurrenceAudit?.length ?? 0) !== meta.counts.occurrenceAudit) {
    fail('CORRUPT_STATE', 'recorded counts do not match the loaded arrays (torn or edited record)');
  }
  return g as SemanticGraph;
}

/** Migration of known-older store schemas to the current shape (design §4). */
function migrateMetaAndGraph(rawMeta: Record<string, unknown>, rawGraph: Record<string, unknown>): { meta: GraphSnapshotMeta; graph: SemanticGraph } {
  const version = typeof rawMeta.storeSchemaVersion === 'number' ? rawMeta.storeSchemaVersion : -1;
  if (version > GRAPH_STORE_SCHEMA_VERSION) {
    fail('FUTURE_SCHEMA', `store schema ${version} is newer than supported ${GRAPH_STORE_SCHEMA_VERSION} — refusing to guess`);
  }
  if (typeof rawGraph.occurrenceAudit !== 'object' || !Array.isArray(rawGraph.occurrenceAudit)) {
    // store schema 0 predates the occurrence audit: absent means empty.
    (rawGraph as { occurrenceAudit?: unknown }).occurrenceAudit = [];
  }
  const graphSnapshotId = typeof rawMeta.graphSnapshotId === 'string' ? rawMeta.graphSnapshotId
    : typeof rawGraph.snapshotId === 'string' ? rawGraph.snapshotId as string
    : fail('CORRUPT_STATE', 'record has no graphSnapshotId');
  const graph = rawGraph as unknown as SemanticGraph;
  const meta: GraphSnapshotMeta = {
    storeSchemaVersion: GRAPH_STORE_SCHEMA_VERSION,
    graphSchemaVersion: typeof rawMeta.graphSchemaVersion === 'string' ? rawMeta.graphSchemaVersion : String(graph.schemaVersion),
    graphSnapshotId,
    sourceIndexDigest: typeof rawMeta.sourceIndexDigest === 'string' ? rawMeta.sourceIndexDigest : '',
    engineVersion: typeof rawMeta.engineVersion === 'string' ? rawMeta.engineVersion : 'pre-store',
    createdAt: typeof rawMeta.createdAt === 'string' ? rawMeta.createdAt : 'unknown',
    counts: typeof rawMeta.counts === 'object' && rawMeta.counts !== null ? rawMeta.counts as GraphSnapshotMeta['counts'] : {
      references: graph.references?.length ?? 0,
      unresolved: graph.unresolved?.length ?? 0,
      hardBindings: graph.hardBindings?.length ?? 0,
      occurrenceAudit: graph.occurrenceAudit?.length ?? 0,
      fileDeps: graph.fileDeps?.length ?? 0,
    },
  };
  return { meta, graph };
}

export class GraphSnapshotStore {
  constructor(private readonly rootDir: string) {}

  private get generationsDir(): string { return path.join(this.rootDir, STORE_GENERATIONS_DIR); }
  private pointerPath(): string { return path.join(this.rootDir, STORE_POINTER_FILE); }
  private generationDir(n: number): string { return path.join(this.generationsDir, generationName(n)); }

  /** Publishes the next generation and atomically swaps the pointer (design §2). */
  async publish(graph: SemanticGraph, sourceIndexDigest: string, engineVersion = '0.1.0', options: PublishOptions = {}): Promise<GraphSnapshotRecord> {
    await fs.mkdir(this.generationsDir, { recursive: true });
    await this.sweepTmpDirs();
    const n = (await this.maxGeneration()) + 1;
    const meta: GraphSnapshotMeta = {
      storeSchemaVersion: GRAPH_STORE_SCHEMA_VERSION,
      graphSchemaVersion: graph.schemaVersion,
      graphSnapshotId: graph.snapshotId,
      sourceIndexDigest,
      engineVersion,
      createdAt: new Date().toISOString(),
      counts: {
        references: graph.references.length,
        unresolved: graph.unresolved.length,
        hardBindings: graph.hardBindings.length,
        occurrenceAudit: graph.occurrenceAudit.length,
        fileDeps: graph.fileDeps.length,
      },
    };
    const tmpDir = path.join(this.generationsDir, `${TMP_PREFIX}${n}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
    await fs.mkdir(tmpDir, { recursive: true });
    await writeFileSynced(path.join(tmpDir, 'meta.json'), JSON.stringify(meta, null, 2));
    await writeFileSynced(path.join(tmpDir, 'graph.json'), JSON.stringify(graph));
    if (options.crashAt === 'before-generation-rename') {
      fail('IO_ERROR', `CRASH-INJECTED at before-generation-rename (generation ${n})`);
    }
    await fs.rename(tmpDir, this.generationDir(n));
    if (options.crashAt === 'before-pointer-swap') {
      fail('IO_ERROR', `CRASH-INJECTED at before-pointer-swap (generation ${n})`);
    }
    const pointer: PointerFile = {
      storeSchemaVersion: GRAPH_STORE_SCHEMA_VERSION,
      generation: n,
      handle: handleFor(n, graph.snapshotId),
      graphSnapshotId: graph.snapshotId,
    };
    const pointerTmp = path.join(this.rootDir, `${STORE_POINTER_FILE}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
    await writeFileSynced(pointerTmp, JSON.stringify(pointer, null, 2));
    await fs.rename(pointerTmp, this.pointerPath());
    const record: GraphSnapshotRecord = { handle: pointer.handle, generation: n, meta, graph };
    await this.cleanup(options.keep ?? 3);
    return record;
  }

  /**
   * The current published snapshot, or `null` for a fresh store. Any pointer
   * that names a missing/incoherent generation is a hard error — the store
   * never silently serves a partial or fallback graph (design §3).
   */
  async current(): Promise<GraphSnapshotRecord | null> {
    let pointerRaw: string;
    try {
      pointerRaw = await fs.readFile(this.pointerPath(), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      fail('IO_ERROR', `cannot read pointer: ${String(error)}`);
    }
    let pointer: PointerFile;
    try {
      pointer = JSON.parse(pointerRaw) as PointerFile;
    } catch (error) {
      fail('CORRUPT_STATE', `pointer is not valid JSON: ${String(error)}`);
    }
    if (typeof pointer.generation !== 'number' || typeof pointer.graphSnapshotId !== 'string') {
      fail('CORRUPT_STATE', 'pointer is missing generation/graphSnapshotId');
    }
    const record = await this.loadGeneration(pointer.generation);
    if (record.graph.snapshotId !== pointer.graphSnapshotId) {
      fail('CORRUPT_STATE', `pointer snapshotId '${pointer.graphSnapshotId}' does not match generation ${pointer.generation} ('${record.graph.snapshotId}')`);
    }
    return record;
  }

  /**
   * Durable-handle resolution. Missing generation → STALE_HANDLE; id-suffix
   * mismatch → SNAPSHOT_MISMATCH; malformed → INVALID_HANDLE. Never falls
   * back to `current()` (D-0021 handle lifecycle).
   */
  async resolveHandle(handle: string): Promise<GraphSnapshotRecord> {
    if (typeof handle !== 'string' || !/^gen-\d{6}@[0-9a-f]{12}$/.test(handle)) {
      fail('INVALID_HANDLE', `malformed snapshot handle '${String(handle)}'`);
    }
    const at = handle.indexOf('@');
    const generation = Number(handle.slice(4, at));
    const idSuffix = handle.slice(at + 1);
    if (!(await exists(this.generationDir(generation)))) {
      fail('STALE_HANDLE', `snapshot generation ${generationName(generation)} is no longer retained (handle '${handle}')`);
    }
    const record = await this.loadGeneration(generation);
    if (record.graph.snapshotId.slice(0, 12) !== idSuffix) {
      fail('SNAPSHOT_MISMATCH', `handle '${handle}' does not match generation ${generationName(generation)} snapshot '${record.graph.snapshotId.slice(0, 12)}'`);
    }
    return record;
  }

  async listGenerations(): Promise<number[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.generationsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      fail('IO_ERROR', `cannot list generations: ${String(error)}`);
    }
    return entries
      .map(name => GENERATION_RE.exec(name))
      .filter((m): m is RegExpExecArray => m !== null)
      .map(m => Number(m[1]))
      .sort((a, b) => a - b);
  }

  /**
   * Safe old-generation cleanup (design §3): keeps the newest `keep`
   * generations; the pointer's target is never a deletion candidate.
   */
  async cleanup(keep: number): Promise<number[]> {
    const kept: number[] = [];
    if (keep <= 0) return kept;
    const generations = await this.listGenerations();
    const survivors = new Set(generations.slice(-keep));
    let pointerGeneration: number | undefined;
    try {
      const pointer = JSON.parse(await fs.readFile(this.pointerPath(), 'utf8')) as PointerFile;
      pointerGeneration = typeof pointer.generation === 'number' ? pointer.generation : undefined;
    } catch {
      pointerGeneration = undefined; /* fresh or unreadable pointer: keep the newest anyway */
    }
    const removed: number[] = [];
    for (const n of generations) {
      if (survivors.has(n) || n === pointerGeneration) continue;
      try {
        await fs.rm(this.generationDir(n), { recursive: true, force: true });
        removed.push(n);
      } catch {
        /* a generation that cannot be removed now is retried on the next cleanup */
      }
    }
    return removed;
  }

  private async loadGeneration(n: number): Promise<GraphSnapshotRecord> {
    const dir = this.generationDir(n);
    let metaRaw: string, graphRaw: string;
    try {
      metaRaw = await fs.readFile(path.join(dir, 'meta.json'), 'utf8');
      graphRaw = await fs.readFile(path.join(dir, 'graph.json'), 'utf8');
    } catch (error) {
      fail('CORRUPT_STATE', `generation ${generationName(n)} is incomplete: ${String(error)}`);
    }
    let rawMeta: Record<string, unknown>, rawGraph: Record<string, unknown>;
    try {
      rawMeta = JSON.parse(metaRaw) as Record<string, unknown>;
      rawGraph = JSON.parse(graphRaw) as Record<string, unknown>;
    } catch (error) {
      fail('CORRUPT_STATE', `generation ${generationName(n)} is not valid JSON: ${String(error)}`);
    }
    const { meta, graph } = migrateMetaAndGraph(rawMeta, rawGraph);
    const validated = validateGraph(graph, meta);
    return { handle: handleFor(n, validated.snapshotId), generation: n, meta, graph: validated };
  }

  private async maxGeneration(): Promise<number> {
    const generations = await this.listGenerations();
    return generations.length ? generations[generations.length - 1] : 0;
  }

  /** Removes leftover in-flight publication dirs (crash recovery, design §2). */
  private async sweepTmpDirs(): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.generationsDir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(TMP_PREFIX)) {
        await fs.rm(path.join(this.generationsDir, name), { recursive: true, force: true });
      }
    }
  }
}
