import { OperationTracker, projectPhase } from './OperationTracker';

describe('OperationTracker', () => {
  it('runs one operation per project and reports how long it has been running', () => {
    let clock = 1_000;
    const tracker = new OperationTracker(() => clock);

    const id = tracker.begin('p1', 'reindex');
    expect(id).toBeDefined();
    expect(tracker.begin('p1', 'start')).toBeUndefined();
    expect(tracker.begin('p2', 'start')).toBeDefined();

    clock += 4_500;
    expect(tracker.running('p1')).toMatchObject({ action: 'reindex', status: 'running', elapsedMs: 4_500 });

    tracker.finish('p1', id!);
    expect(tracker.running('p1')).toBeNull();
    expect(tracker.get('p1')).toMatchObject({ status: 'done', elapsedMs: 4_500 });
    expect(tracker.begin('p1', 'stop')).toBeDefined();
  });

  it('lets stop and restart take over from a running reindex, but nothing else', () => {
    const tracker = new OperationTracker();
    const reindex = tracker.begin('p', 'reindex')!;
    expect(tracker.begin('p', 'start')).toBeUndefined();
    expect(tracker.begin('p', 'reindex')).toBeUndefined();

    const stop = tracker.begin('p', 'stop');
    expect(stop).toBeDefined();
    expect(tracker.running('p')).toMatchObject({ action: 'stop' });

    tracker.finish('p', reindex); // the interrupted reindex ending later must not touch the stop
    expect(tracker.running('p')?.id).toBe(stop);
    expect(tracker.begin('p', 'restart')).toBeUndefined(); // a stop is not interruptible
  });

  it('keeps the error of a failed operation, and ignores a stale finish', () => {
    const tracker = new OperationTracker();
    const first = tracker.begin('p', 'start')!;
    tracker.finish('p', first, 'did not become ready');
    expect(tracker.get('p')).toMatchObject({ status: 'failed', error: 'did not become ready' });

    const second = tracker.begin('p', 'restart')!;
    tracker.finish('p', first); // belongs to the earlier operation
    expect(tracker.running('p')?.id).toBe(second);
  });
});

describe('projectPhase', () => {
  const op = (action: 'start' | 'stop' | 'restart' | 'reindex') => ({
    id: 'x', projectId: 'p', action, status: 'running' as const, startedAt: 't', elapsedMs: 1,
  });

  it('shows what a running operation is doing before the worker state', () => {
    expect(projectPhase({ operation: op('start'), workerState: undefined, queueSize: undefined })).toBe('starting');
    expect(projectPhase({ operation: op('stop'), workerState: 'ready', queueSize: 0 })).toBe('stopping');
    expect(projectPhase({ operation: op('restart'), workerState: 'ready', queueSize: 0 })).toBe('restarting');
    expect(projectPhase({ operation: op('reindex'), workerState: 'ready', queueSize: 0 })).toBe('indexing');
  });

  it('derives the phase from the worker when nothing is running', () => {
    expect(projectPhase({ operation: null, workerState: undefined, queueSize: undefined })).toBe('stopped');
    expect(projectPhase({ operation: null, workerState: 'ready', queueSize: 0 })).toBe('ready');
    expect(projectPhase({ operation: null, workerState: 'ready', queueSize: 1 })).toBe('indexing');
    expect(projectPhase({ operation: null, workerState: 'ready', queueSize: 0, degraded: true })).toBe('degraded');
    expect(projectPhase({ operation: null, workerState: 'starting', queueSize: undefined })).toBe('starting');
    expect(projectPhase({ operation: null, workerState: 'crashed', queueSize: undefined })).toBe('crashed');
  });
});
