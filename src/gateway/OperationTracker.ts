/**
 * What the gateway is doing to each project right now.
 *
 * Start, stop, restart and reindex take seconds to minutes (a MiniLM reindex of
 * a large project took six). A request that blocks that long gives the dashboard
 * nothing to show, so these actions run as tracked operations: the request can
 * return at once, and any client can poll the operation (and the log tail) to
 * draw a progress bar. The tracker is in memory; after a gateway restart a
 * client simply sees no operation.
 */

export type OperationAction = 'start' | 'stop' | 'restart' | 'reindex';
export type OperationStatus = 'running' | 'done' | 'failed';

export interface OperationSnapshot {
  readonly id: string;
  readonly projectId: string;
  readonly action: OperationAction;
  readonly status: OperationStatus;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly elapsedMs: number;
  readonly error?: string;
}

interface Operation {
  readonly id: string;
  readonly projectId: string;
  readonly action: OperationAction;
  status: OperationStatus;
  readonly startedAt: number;
  finishedAt?: number;
  error?: string;
}

export class OperationTracker {
  private readonly byProject = new Map<string, Operation>();
  private counter = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Starts an operation; `undefined` when one is already running for the project.
   * Stop and restart are the way out of a long reindex, so they take over from it
   * instead of being refused: the reindex is recorded as interrupted.
   */
  begin(projectId: string, action: OperationAction): string | undefined {
    const running = this.byProject.get(projectId);
    if (running?.status === 'running') {
      const takesOver = running.action === 'reindex' && (action === 'stop' || action === 'restart');
      if (!takesOver) return undefined;
      running.status = 'failed';
      running.finishedAt = this.now();
      running.error = `interrupted by ${action}`;
    }
    this.counter += 1;
    const id = `op-${this.now().toString(36)}-${this.counter}`;
    this.byProject.set(projectId, { id, projectId, action, status: 'running', startedAt: this.now() });
    return id;
  }

  finish(projectId: string, id: string, error?: string): void {
    const operation = this.byProject.get(projectId);
    if (!operation || operation.id !== id) return;
    operation.status = error === undefined ? 'done' : 'failed';
    operation.finishedAt = this.now();
    if (error !== undefined) operation.error = error;
  }

  /** The running operation, or — for a short while after — the one that just ended. */
  get(projectId: string): OperationSnapshot | null {
    const operation = this.byProject.get(projectId);
    return operation ? this.snapshot(operation) : null;
  }

  running(projectId: string): OperationSnapshot | null {
    const operation = this.byProject.get(projectId);
    return operation?.status === 'running' ? this.snapshot(operation) : null;
  }

  forget(projectId: string): void {
    this.byProject.delete(projectId);
  }

  private snapshot(operation: Operation): OperationSnapshot {
    const end = operation.finishedAt ?? this.now();
    return {
      id: operation.id,
      projectId: operation.projectId,
      action: operation.action,
      status: operation.status,
      startedAt: new Date(operation.startedAt).toISOString(),
      ...(operation.finishedAt !== undefined ? { finishedAt: new Date(operation.finishedAt).toISOString() } : {}),
      elapsedMs: end - operation.startedAt,
      ...(operation.error !== undefined ? { error: operation.error } : {}),
    };
  }
}

/** Display phase of a project; one vocabulary for the console and for clients. */
export type ProjectPhase =
  | 'stopped'
  | 'starting'
  | 'indexing'
  | 'ready'
  | 'degraded'
  | 'crashed'
  | 'stopping'
  | 'restarting';

export function projectPhase(input: {
  readonly operation: OperationSnapshot | null;
  readonly workerState: string | undefined;
  readonly queueSize: number | undefined;
  readonly degraded?: boolean;
}): ProjectPhase {
  const { operation, workerState, queueSize, degraded } = input;
  if (operation?.status === 'running') {
    switch (operation.action) {
      case 'start':
        return 'starting';
      case 'stop':
        return 'stopping';
      case 'restart':
        return 'restarting';
      case 'reindex':
        return 'indexing';
    }
  }
  switch (workerState) {
    case 'ready':
      if (degraded) return 'degraded';
      return (queueSize ?? 0) > 0 ? 'indexing' : 'ready';
    case 'degraded':
      return 'degraded';
    case 'crashed':
      return 'crashed';
    case 'starting':
      return 'starting';
    case 'stopping':
      return 'stopping';
    default:
      return 'stopped';
  }
}
