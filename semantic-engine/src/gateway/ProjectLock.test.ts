import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { acquireLock, readLock, DEFAULT_STALE_AFTER_MS } from './ProjectLock';

describe('ProjectLock — one owner at a time, recoverable after a crash', () => {
  let base: string;
  let lockPath: string;

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-lock-')));
    lockPath = path.join(base, 'locks', 'worker.lock');
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('grants the lock once and reports the holder to everyone else', () => {
    const first = acquireLock(lockPath, 'prj-a-11111111', 'worker', { pid: 111 });
    expect(first.ok).toBe(true);

    const second = acquireLock(lockPath, 'prj-a-11111111', 'worker', {
      pid: 222,
      isProcessAlive: () => true,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe('held');
      expect(second.holder?.pid).toBe(111);
    }

    if (first.ok) first.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('release only removes our own lock', () => {
    const first = acquireLock(lockPath, 'prj-a-11111111', 'worker', { pid: 111 });
    expect(first.ok).toBe(true);

    /* A second holder object for the same path must not delete someone else's file. */
    const impostor = acquireLock(lockPath, 'prj-a-11111111', 'worker', {
      pid: 333,
      isProcessAlive: () => true,
    });
    expect(impostor.ok).toBe(false);

    expect(fs.existsSync(lockPath)).toBe(true);
    if (first.ok) first.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('takes over a lock whose owner is dead', () => {
    const first = acquireLock(lockPath, 'prj-a-11111111', 'worker', { pid: 111 });
    expect(first.ok).toBe(true);

    const taken = acquireLock(lockPath, 'prj-a-11111111', 'worker', {
      pid: 444,
      isProcessAlive: () => false,
    });

    expect(taken.ok).toBe(true);
    if (taken.ok) {
      expect(taken.recovered).toBe(true);
      expect(readLock(lockPath)?.pid).toBe(444);
      taken.release();
    }
  });

  it('takes over a lock whose heartbeat went quiet', () => {
    let current = Date.UTC(2026, 7, 26, 12, 0, 0);
    const first = acquireLock(lockPath, 'prj-a-11111111', 'worker', {
      pid: 111,
      now: () => new Date(current),
      isProcessAlive: () => true,
    });
    expect(first.ok).toBe(true);

    /* A heartbeat keeps it alive. */
    if (first.ok) first.heartbeat();

    const stillHeld = acquireLock(lockPath, 'prj-a-11111111', 'worker', {
      pid: 555,
      now: () => new Date(current + 1_000),
      isProcessAlive: () => true,
    });
    expect(stillHeld.ok).toBe(false);

    /* …until it does not. */
    const stale = acquireLock(lockPath, 'prj-a-11111111', 'worker', {
      pid: 555,
      now: () => new Date(current + DEFAULT_STALE_AFTER_MS + 1_000),
      isProcessAlive: () => true,
    });
    expect(stale.ok).toBe(true);
    if (stale.ok) {
      expect(stale.recovered).toBe(true);
      stale.release();
    }
  });

  it('records what the lock is for', () => {
    const acquired = acquireLock(lockPath, 'prj-a-11111111', 'index', { pid: 111 });
    expect(acquired.ok).toBe(true);

    const info = readLock(lockPath);
    expect(info?.kind).toBe('index');
    expect(info?.projectId).toBe('prj-a-11111111');
    expect(info?.pid).toBe(111);
    expect(Date.parse(info?.heartbeatAt ?? '')).not.toBeNaN();

    if (acquired.ok) acquired.release();
  });

  it('never steals a half-written lock whose owner is still alive', () => {
    /*
    | F-0026 — یک JSONِ نیمه‌نوشته parse نمی‌شود و `readLock` تهی می‌دهد؛
    | «تهی» دیگر به‌خودی‌خود نشانهٔ رهاشدن نیست. pid خام از متن درمی‌آید
    | و صاحب زنده باشد، قفلش دست‌نخورده می‌ماند. وگرنه یک heartbeat
    | نیمه‌نوشته می‌توانست صاحبِ زنده را بی‌قفل کند و دو worker روی یک
    | پروژه بنشیند.
    */
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, '{"pid": 11');

    const acquired = acquireLock(lockPath, 'prj-a-11111111', 'worker', {
      pid: 666,
      isProcessAlive: () => true,
    });

    expect(acquired.ok).toBe(false);
    if (!acquired.ok) expect(acquired.reason).toBe('held');
    /* فایل صاحب اول نباید پاک شده باشد. */
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it('recovers from a half-written lock file whose owner is gone', () => {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, '{"pid": 11');

    const acquired = acquireLock(lockPath, 'prj-a-11111111', 'worker', {
      pid: 666,
      isProcessAlive: () => false,
    });

    expect(acquired.ok).toBe(true);
    if (acquired.ok) {
      expect(acquired.recovered).toBe(true);
      acquired.release();
    }
  });
});
