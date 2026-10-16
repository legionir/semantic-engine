/**
 * Phase 2 fuzz + crash recovery — deterministic seeded checks.
 *
 * - Seeded apply→rollback fuzz: every cycle must restore the exact bytes.
 * - Cross-instance recovery: a journal written by one engine instance is
 *   listed and rolled back by a fresh instance (process-restart shape).
 * - Partial-failure restore: when a later file write fails, already-written
 *   files are restored from in-memory originals (fault injection via a
 *   read-only directory).
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { contentHash, TransactionalEditEngine } from './Phase2Transactions';

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const ALPHABET = 'abcXYZ019 \n\t;(){}فارسی🎉';

function randomText(rand: () => number, maxLength: number): string {
  const length = Math.floor(rand() * maxLength);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return out;
}

describe('Phase 2 fuzz and recovery', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'semantic-engine-p2fuzz-'));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
  });
  afterEach(async () => {
    await fs.chmod(path.join(root, 'locked'), 0o755).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  });

  test('seeded apply→rollback fuzz restores exact bytes every cycle', async () => {
    const rand = seededRandom(0xC0DE);
    const file = 'src/a.ts';
    const engine = new TransactionalEditEngine(root);
    await fs.writeFile(path.join(root, file), randomText(rand, 400) || 'seed\n', 'utf8');
    const cycles = 60;
    for (let cycle = 0; cycle < cycles; cycle++) {
      const original = await fs.readFile(path.join(root, file), 'utf8');
      const at = Math.floor(rand() * (original.length + 1));
      const span = Math.min(original.length - at, Math.floor(rand() * 12));
      const replacement = randomText(rand, 12);
      // Skip edits that cannot change bytes; the engine rejects them by design.
      if (original.slice(at, at + span) === replacement) continue;
      const plan = await engine.plan([{ path: file, start: at, end: at + span, replacement, expectedHash: contentHash(original) }]);
      const applied = await engine.apply(plan.id, engine.approve(plan.id));
      expect(applied.status).toBe('applied');
      const rolled = await engine.rollback(applied.transactionId);
      expect(rolled.status).toBe('rolled_back');
      expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(original);
    }
  }, 60000);

  test('a fresh engine instance recovers and rolls back a durable journal', async () => {
    const file = 'src/a.ts';
    const original = 'const value = 1;\n';
    await fs.writeFile(path.join(root, file), original, 'utf8');
    const first = new TransactionalEditEngine(root);
    const plan = await first.plan([{ path: file, start: 14, end: 15, replacement: '2', expectedHash: contentHash(original) }]);
    const applied = await first.apply(plan.id, first.approve(plan.id));
    expect(await fs.readFile(path.join(root, file), 'utf8')).toContain('2');

    // Simulate a process restart: drop the engine, create a new one.
    const second = new TransactionalEditEngine(root);
    const recovered = await second.recover();
    expect(recovered.some(r => r.transactionId === applied.transactionId && r.status === 'applied')).toBe(true);
    const rolled = await second.rollback(applied.transactionId);
    expect(rolled.status).toBe('rolled_back');
    expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(original);
  });

  test('rollback refuses with UNDO_CONFLICT when files changed after apply', async () => {
    const file = 'src/a.ts';
    const original = 'const value = 1;\n';
    await fs.writeFile(path.join(root, file), original, 'utf8');
    const engine = new TransactionalEditEngine(root);
    const plan = await engine.plan([{ path: file, start: 14, end: 15, replacement: '2', expectedHash: contentHash(original) }]);
    const applied = await engine.apply(plan.id, engine.approve(plan.id));
    expect(applied.after).toEqual([{ path: file, hash: contentHash('const value = 2;\n') }]);
    await fs.writeFile(path.join(root, file), 'const value = 3;\n', 'utf8');
    await expect(engine.rollback(applied.transactionId)).rejects.toThrow('UNDO_CONFLICT');
    // The conflicting content is left untouched for a human/tool to resolve.
    expect(await fs.readFile(path.join(root, file), 'utf8')).toBe('const value = 3;\n');
  });

  test('a failed multi-file apply restores already-written files', async () => {
    if (process.getuid?.() === 0) return; // read-only directories do not stop root
    await fs.mkdir(path.join(root, 'locked'), { recursive: true });
    const fileA = 'src/a.ts';
    const fileB = 'locked/b.ts';
    const originalA = 'const a = 1;\n';
    const originalB = 'const b = 1;\n';
    await fs.writeFile(path.join(root, fileA), originalA, 'utf8');
    await fs.writeFile(path.join(root, fileB), originalB, 'utf8');
    const engine = new TransactionalEditEngine(root);
    const plan = await engine.plan([
      { path: fileA, start: 10, end: 11, replacement: '2', expectedHash: contentHash(originalA) },
      { path: fileB, start: 10, end: 11, replacement: '2', expectedHash: contentHash(originalB) },
    ]);
    const token = engine.approve(plan.id);
    await fs.chmod(path.join(root, 'locked'), 0o555);
    try {
      await expect(engine.apply(plan.id, token)).rejects.toThrow();
    } finally {
      await fs.chmod(path.join(root, 'locked'), 0o755);
    }
    expect(await fs.readFile(path.join(root, fileA), 'utf8')).toBe(originalA);
    expect(await fs.readFile(path.join(root, fileB), 'utf8')).toBe(originalB);
  });
});
