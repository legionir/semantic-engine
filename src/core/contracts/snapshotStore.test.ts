import { CODEINTEL_ERROR_CODES, Handle } from './codeintel';
import { InMemorySnapshotStore } from './snapshotStore';

describe('InMemorySnapshotStore — stale-handle runtime contract', () => {
  test('issues and verifies a handle against the same snapshot', () => {
    const store = new InMemorySnapshotStore();
    store.publish('s1', { 'src/a.ts': 'alpha()' });
    const handle = store.issueHandle('s1', 'src/a.ts', 0, 5);
    const result = store.readHandle('r1', 's1', handle);
    expect(result).toMatchObject({ ok: true, data: { path: 'src/a.ts', text: 'alpha' } });
  });

  test('rejects a handle after the snapshot bytes change without returning source', () => {
    const store = new InMemorySnapshotStore();
    store.publish('s1', { 'a.ts': 'old' });
    const handle = store.issueHandle('s1', 'a.ts', 0, 3);
    store.publish('s2', { 'a.ts': 'new' });
    const result = store.readHandle('r2', 's2', handle);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(CODEINTEL_ERROR_CODES.STALE_HANDLE);
    expect(result.data).toBeUndefined();
  });

  test('rejects a handle when its snapshot is unavailable', () => {
    const store = new InMemorySnapshotStore();
    store.publish('s1', { 'a.ts': 'old' });
    const handle = store.issueHandle('s1', 'a.ts', 0, 3);
    const result = store.readHandle('r3', 'missing', handle);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(CODEINTEL_ERROR_CODES.STALE_SNAPSHOT);
    expect(result.data).toBeUndefined();
  });

  test('rejects an out-of-range handle without source content', () => {
    const store = new InMemorySnapshotStore();
    store.publish('s1', { 'a.ts': 'old' });
    const forged = 'a.ts:0-99#' + 'a'.repeat(8) as Handle;
    const result = store.readHandle('r4', 's1', forged);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(CODEINTEL_ERROR_CODES.STALE_HANDLE);
    expect(result.data).toBeUndefined();
  });
});
