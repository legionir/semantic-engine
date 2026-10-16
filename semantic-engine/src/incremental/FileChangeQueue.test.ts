import { FileChangeQueue } from './FileChangeQueue';
import { FileChangeEvent } from '../core/types/common.types';

describe('FileChangeQueue', () => {
  it('should debounce events and emit a batch', (done) => {
    const queue = new FileChangeQueue({ debounceMs: 50 });
    const received: FileChangeEvent[][] = [];

    queue.enqueue({ type: 'modified', path: 'a.ts' }, events => received.push(events));
    queue.enqueue({ type: 'modified', path: 'a.ts' }, events => received.push(events));
    queue.enqueue({ type: 'modified', path: 'b.ts' }, events => received.push(events));

    setTimeout(() => {
      expect(received.length).toBe(1);
      expect(received[0]).toHaveLength(2);
      queue.dispose();
      done();
    }, 120);
  });

  it('should merge duplicate modify events into a single modified', () => {
    const queue = new FileChangeQueue({ debounceMs: 0 });
    const batch = queue.drain();
    expect(batch).toEqual([]);

    queue.enqueue({ type: 'modified', path: 'a.ts' }, () => {});
    queue.enqueue({ type: 'modified', path: 'a.ts' }, () => {});
    const result = queue.drain();

    expect(result).toEqual([{ type: 'modified', path: 'a.ts' }]);
    queue.dispose();
  });

  it('should convert deleted + created into modified', () => {
    const queue = new FileChangeQueue({ debounceMs: 0 });
    queue.enqueue({ type: 'deleted', path: 'a.ts' }, () => {});
    queue.enqueue({ type: 'created', path: 'a.ts' }, () => {});
    const result = queue.drain();

    expect(result).toEqual([{ type: 'modified', path: 'a.ts' }]);
    queue.dispose();
  });

  it('should keep renamed events intact', () => {
    const queue = new FileChangeQueue({ debounceMs: 0 });
    queue.enqueue({ type: 'renamed', path: 'new.ts', oldPath: 'old.ts' }, () => {});
    const result = queue.drain();

    expect(result).toEqual([{ type: 'renamed', path: 'new.ts', oldPath: 'old.ts' }]);
    queue.dispose();
  });
});
