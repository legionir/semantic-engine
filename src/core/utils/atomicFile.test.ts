import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileLockTimeoutError, atomicWriteFileSync, atomicWriteJsonSync, withFileLockSync } from './atomicFile';

describe('atomicFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-atomic-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('writes the whole file, creates the directory and leaves no temp file', () => {
    const target = path.join(dir, 'nested', 'a.json');
    atomicWriteJsonSync(target, { a: 1 });
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ a: 1 });
    expect(fs.readdirSync(path.dirname(target))).toEqual(['a.json']);
  });

  it('replaces an existing file and removes its temp file when the rename fails', () => {
    const target = path.join(dir, 'a.txt');
    atomicWriteFileSync(target, 'one');
    atomicWriteFileSync(target, 'two');
    expect(fs.readFileSync(target, 'utf8')).toBe('two');

    /* a directory cannot be replaced by a file: rename fails, temp is cleaned */
    const blocked = path.join(dir, 'blocked');
    fs.mkdirSync(path.join(blocked, 'child'), { recursive: true });
    expect(() => atomicWriteFileSync(blocked, 'x')).toThrow();
    expect(fs.readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([]);
  });

  it('runs the critical section and releases the lock, even when it throws', () => {
    const lock = path.join(dir, 'x.lock');
    expect(withFileLockSync(lock, () => 42)).toBe(42);
    expect(fs.existsSync(lock)).toBe(false);
    expect(() => withFileLockSync(lock, () => { throw new Error('boom'); })).toThrow('boom');
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('times out instead of stealing the lock of a live owner', () => {
    const lock = path.join(dir, 'x.lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid + 0, token: 'other' }));
    /* same pid is "alive"; a fresh lock must be respected */
    expect(() => withFileLockSync(lock, () => 1, { waitMs: 80, staleMs: 60_000 })).toThrow(FileLockTimeoutError);
    expect(fs.existsSync(lock)).toBe(true);
  });

  it('takes over a lock whose owner process is gone', () => {
    const lock = path.join(dir, 'x.lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: 2_147_483_646, token: 'dead' }));
    expect(withFileLockSync(lock, () => 'ok', { waitMs: 500, staleMs: 60_000 })).toBe('ok');
  });
});
