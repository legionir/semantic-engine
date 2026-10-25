import * as crypto from 'crypto';
import { fail, Handle, LineIndex, makeHandle, ok, Envelope, CODEINTEL_ERROR_CODES, parseHandle } from './codeintel';

export interface SnapshotFile { readonly text: string; readonly hash: string; }
export interface SnapshotHandleResult { readonly path: string; readonly start: number; readonly end: number; readonly text: string; }

/**
 * In-memory reference issuer/verifier for read handles. Production stores may
 * replace the backing map, but must preserve the fail-closed semantics:
 * neither stale snapshots nor stale file bytes return source content.
 */
export class InMemorySnapshotStore {
  private readonly snapshots = new Map<string, ReadonlyMap<string, SnapshotFile>>();

  publish(snapshotId: string, files: Readonly<Record<string, string>>): void {
    if (!snapshotId) throw new TypeError('snapshotId must be non-empty');
    const snapshot = new Map<string, SnapshotFile>();
    for (const [relativePath, text] of Object.entries(files)) {
      const hash = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
      snapshot.set(relativePath, { text, hash });
    }
    this.snapshots.set(snapshotId, snapshot);
  }

  issueHandle(snapshotId: string, relativePath: string, start: number, end: number): Handle {
    const file = this.snapshots.get(snapshotId)?.get(relativePath);
    if (!file) throw new Error(`file is not present in snapshot: ${relativePath}`);
    const index = new LineIndex(file.text);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > index.text.length) {
      throw new RangeError('handle range is outside the snapshot');
    }
    return makeHandle(relativePath, start, end, file.hash.slice(0, 8));
  }

  readHandle(requestId: string, currentSnapshotId: string, handle: Handle): Envelope<SnapshotHandleResult> {
    let parsed: ReturnType<typeof parseHandle>;
    try {
      parsed = parseHandle(handle); 
    } catch {
      return fail(requestId, currentSnapshotId, {
        code: CODEINTEL_ERROR_CODES.INVALID_ARGUMENT,
        message: 'invalid read handle',
        retryable: false,
      });
    }
    const file = this.snapshots.get(currentSnapshotId)?.get(parsed.relativePath);
    if (!file) {
      return fail(requestId, currentSnapshotId, {
        code: CODEINTEL_ERROR_CODES.STALE_SNAPSHOT,
        message: 'snapshot is not available or the file is no longer present',
        retryable: true,
      });
    }
    const actualHash = crypto.createHash('sha256').update(file.text, 'utf8').digest('hex').slice(0, 8);
    if (actualHash !== parsed.hash8) {
      return fail(requestId, currentSnapshotId, {
        code: CODEINTEL_ERROR_CODES.STALE_HANDLE,
        message: 'file content changed since the handle was issued',
        retryable: false,
      });
    }
    const index = new LineIndex(file.text);
    if (parsed.end > index.text.length) {
      return fail(requestId, currentSnapshotId, {
        code: CODEINTEL_ERROR_CODES.STALE_HANDLE,
        message: 'handle range is outside the current file',
        retryable: false,
      });
    }
    return ok(requestId, currentSnapshotId, {
      path: parsed.relativePath,
      start: parsed.start,
      end: parsed.end,
      text: index.text.slice(parsed.start, parsed.end),
    });
  }
}
