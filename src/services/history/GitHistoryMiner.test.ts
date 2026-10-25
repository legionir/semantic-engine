import { GitHistoryMiner } from './GitHistoryMiner';

describe('GitHistoryMiner (V2 Hotspots & Co-Churn)', () => {
  it('calculates hotspots and co-churn matrices from commit records', () => {
    const miner = new GitHistoryMiner();

    miner.recordCommit(['src/auth.ts', 'src/user.ts']);
    miner.recordCommit(['src/auth.ts', 'src/user.ts']);
    miner.recordCommit(['src/auth.ts', 'src/token.ts']);

    const hotspots = miner.getHotspots(5);
    expect(hotspots.length).toBeGreaterThan(0);
    expect(hotspots[0]?.filePath).toBe('src/auth.ts');

    const coChurn = miner.getCoChurn('src/auth.ts');
    expect(coChurn.length).toBe(2);
    expect(coChurn[0]?.targetFile).toBe('src/user.ts');
    expect(coChurn[0]?.coOccurrenceCount).toBe(2);
  });

  // F-0019 — a file's co-churn partner map must stay bounded even when it
  // co-occurs with a huge number of distinct files.
  it('bounds co-churn partners per file', () => {
    const miner = new GitHistoryMiner();
    const hub = 'src/hub.ts';
    const partners = Array.from({ length: 250 }, (_, i) => `src/f${i}.ts`);
    // One commit touching the hub plus 250 distinct partners.
    miner.recordCommit('p', [hub, ...partners]);

    // Requesting more than the cap still cannot exceed it.
    const churn = miner.getCoChurn('p', hub, 1000);
    expect(churn.length).toBe(200);
  });
});
