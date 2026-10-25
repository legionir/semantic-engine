import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { contentHash, OverlayStore, TransactionalEditEngine } from './Phase2Transactions';

describe('Phase 2 transactional edits', () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'semantic-engine-p2-')); await fs.mkdir(path.join(root, 'src')); await fs.writeFile(path.join(root, 'src/a.ts'), 'const value = 1;\n'); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
  test('preview is read-only and apply requires explicit approval', async () => {
    const file = 'src/a.ts'; const original = await fs.readFile(path.join(root, file), 'utf8'); const engine = new TransactionalEditEngine(root);
    const plan = await engine.plan([{ path: file, start: 14, end: 15, replacement: '2', expectedHash: contentHash(original) }]);
    expect(plan.diff).toContain('-1'); expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(original);
    await expect(engine.apply(plan.id, 'wrong')).rejects.toThrow('APPROVAL_REQUIRED');
    const token = engine.approve(plan.id); const record = await engine.apply(plan.id, token);
    expect(record.status).toBe('applied'); expect(await fs.readFile(path.join(root, file), 'utf8')).toContain('2');
  });
  test('rejects stale snapshots and overlapping edits', async () => {
    const file = 'src/a.ts'; const original = await fs.readFile(path.join(root, file), 'utf8'); const engine = new TransactionalEditEngine(root);
    const plan = await engine.plan([{ path: file, start: 14, end: 15, replacement: '2', expectedHash: contentHash(original) }]); await fs.writeFile(path.join(root, file), 'const value = 3;\n'); await expect(engine.apply(plan.id, engine.approve(plan.id))).rejects.toThrow('STALE_SNAPSHOT');
    await expect(engine.plan([{ path: file, start: 0, end: 5, replacement: 'let', expectedHash: contentHash('const value = 3;\n') }, { path: file, start: 4, end: 8, replacement: 'x', expectedHash: contentHash('const value = 3;\n') }])).rejects.toThrow('overlapping');
  });
  test('journals and restores originals on rollback', async () => {
    const file = 'src/a.ts'; const original = await fs.readFile(path.join(root, file), 'utf8'); const engine = new TransactionalEditEngine(root);
    const plan = await engine.plan([{ path: file, start: 14, end: 15, replacement: '9', expectedHash: contentHash(original) }]); const record = await engine.apply(plan.id, engine.approve(plan.id)); await engine.rollback(record.transactionId);
    expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(original); expect((await engine.recover()).some(r => r.status === 'rolled_back')).toBe(true);
  });
  test('plans against an unsaved overlay without persisting it', async () => { const overlay = new OverlayStore(); overlay.set('src/a.ts', 'const value = 7;\n'); const engine = new TransactionalEditEngine(root, '.semantic-engine/transactions', [], overlay); const plan = await engine.plan([{ path: 'src/a.ts', start: 14, end: 15, replacement: '8', expectedHash: contentHash('const value = 7;\n') }]); expect(plan.diff).toContain('-7'); expect(await fs.readFile(path.join(root, 'src/a.ts'), 'utf8')).toContain('1'); });
  test('denies traversal and protected paths', async () => { const engine = new TransactionalEditEngine(root); await expect(engine.plan([{ path: '../x.ts', start: 0, end: 0, replacement: '', expectedHash: 'x' }])).rejects.toThrow('DENIED'); await expect(engine.plan([{ path: '.env', start: 0, end: 0, replacement: 'x', expectedHash: 'x' }])).rejects.toThrow('DENIED'); });
});
