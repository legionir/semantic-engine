import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MAX_ARGS_CHARS, RequestLog, RequestLogInput, previewArgs } from './RequestLog';

function call(overrides: Partial<RequestLogInput> = {}): RequestLogInput {
  return {
    project: 'prj-a', tool: 'find_symbol', args: '{"name":"x"}', durationMs: 10, ok: true,
    resultBytes: 100, key: 'admin', client: 'claude-code/2.1', ...overrides,
  };
}

describe('RequestLog', () => {
  it('filters by project, tool, status, client, text and time', () => {
    const log = new RequestLog();
    log.record(call({ at: 1000 }));
    log.record(call({ at: 2000, tool: 'search', args: '{"query":"token store"}' }));
    log.record(call({ at: 3000, project: 'prj-b', ok: false, error: 'NOT_FOUND: nothing\nsecond line', client: 'cursor/1' }));

    expect(log.query({ project: 'prj-b' }).items.map(e => e.at)).toEqual([3000]);
    expect(log.query({ tool: 'search' }).total).toBe(1);
    expect(log.query({ status: 'error' }).items[0]!.error).toBe('NOT_FOUND: nothing');
    expect(log.query({ status: 'ok' }).total).toBe(2);
    expect(log.query({ client: 'cursor/1' }).total).toBe(1);
    expect(log.query({ q: 'TOKEN' }).items.map(e => e.tool)).toEqual(['search']);
    expect(log.query({ q: 'not_found' }).total).toBe(1);
    expect(log.query({ from: 1500, to: 2500 }).items.map(e => e.at)).toEqual([2000]);
    expect(log.query().facets).toEqual({
      projects: ['prj-a', 'prj-b'], tools: ['find_symbol', 'search'], clients: ['claude-code/2.1', 'cursor/1'],
    });
  });

  it('sorts newest first by default and by any column on request, with paging', () => {
    const log = new RequestLog();
    log.record(call({ at: 1, durationMs: 30, tool: 'b' }));
    log.record(call({ at: 2, durationMs: 10, tool: 'c' }));
    log.record(call({ at: 3, durationMs: 20, tool: 'a', ok: false }));

    expect(log.query().items.map(e => e.at)).toEqual([3, 2, 1]);
    expect(log.query({ sort: 'durationMs', order: 'desc' }).items.map(e => e.durationMs)).toEqual([30, 20, 10]);
    expect(log.query({ sort: 'tool' }).items.map(e => e.tool)).toEqual(['a', 'b', 'c']);
    expect(log.query({ sort: 'status' }).items[0]!.ok).toBe(false);
    expect(log.query({ sort: 'nonsense' as never }).items.map(e => e.at)).toEqual([3, 2, 1]);

    const page = log.query({ limit: 2, offset: 2 });
    expect(page).toMatchObject({ total: 3, offset: 2, limit: 2 });
    expect(page.items.map(e => e.at)).toEqual([1]);
  });

  it('hides projects the caller may not see, in the list, the facets and the statistics', () => {
    const log = new RequestLog({ now: () => 5000 });
    log.record(call({ at: 4000 }));
    log.record(call({ at: 4500, project: 'prj-b' }));
    const onlyA = (project: string): boolean => project === 'prj-a';

    expect(log.query({}, onlyA).total).toBe(1);
    expect(log.query({}, onlyA).facets.projects).toEqual(['prj-a']);
    expect(log.stats(10_000, onlyA).total).toBe(1);
  });

  it('summarises a window: totals, error rate, percentiles, groups and a timeline', () => {
    const log = new RequestLog({ now: () => 24_000 });
    for (let i = 0; i < 9; i += 1) log.record(call({ at: 1000 + i * 1000, durationMs: (i + 1) * 10 }));
    log.record(call({ at: 23_500, durationMs: 100, ok: false, error: 'boom', tool: 'impact', resultBytes: 50 }));
    log.record(call({ at: -5000 })); /* outside the window */

    const stats = log.stats(24_000);
    expect(stats.total).toBe(10);
    expect(stats.errors).toBe(1);
    expect(stats.errorRate).toBeCloseTo(0.1);
    expect(stats.p50Ms).toBe(50);
    expect(stats.p95Ms).toBe(100);
    expect(stats.avgMs).toBe(55);
    expect(stats.resultBytes).toBe(950);
    expect(stats.byTool).toEqual([
      { name: 'find_symbol', count: 9, errors: 0, avgMs: 50, p95Ms: 90 },
      { name: 'impact', count: 1, errors: 1, avgMs: 100, p95Ms: 100 },
    ]);
    expect(stats.timeline).toHaveLength(24);
    expect(stats.timeline.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(10);
    expect(stats.timeline[23]).toMatchObject({ count: 1, errors: 1 });
  });

  it('keeps only the newest entries in memory', () => {
    const log = new RequestLog({ capacity: 3 });
    for (let i = 1; i <= 5; i += 1) log.record(call({ at: i }));
    expect(log.size).toBe(3);
    expect(log.query().items.map(e => e.at)).toEqual([5, 4, 3]);
  });

  it('bounds the stored argument preview', () => {
    const preview = previewArgs({ text: 'x'.repeat(5000) });
    expect(preview.length).toBe(MAX_ARGS_CHARS + 1);
    expect(preview.endsWith('…')).toBe(true);
  });

  describe('on disk', () => {
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-reqlog-')); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it('survives a restart and skips a line cut short by a crash', async () => {
      const filePath = path.join(dir, 'gateway', 'requests.jsonl');
      const first = new RequestLog({ filePath });
      first.record(call({ at: 1 }));
      first.record(call({ at: 2, tool: 'search' }));
      await first.flush();
      fs.appendFileSync(filePath, '{"id":3,"at":3,"tool":"imp');

      const second = new RequestLog({ filePath });
      expect(second.query().items.map(e => e.tool)).toEqual(['search', 'find_symbol']);
      expect(second.record(call({ at: 4 })).id).toBe(3);
    });

    it('rotates the file once it passes the size limit and still restores across both files', async () => {
      const filePath = path.join(dir, 'requests.jsonl');
      const log = new RequestLog({ filePath, maxFileBytes: 400 });
      for (let i = 1; i <= 6; i += 1) log.record(call({ at: i }));
      await log.flush();

      expect(fs.existsSync(`${filePath}.1`)).toBe(true);
      expect(fs.statSync(filePath).size).toBeLessThanOrEqual(400);
      const restored = new RequestLog({ filePath });
      expect(restored.size).toBeGreaterThanOrEqual(3);
      expect(restored.query().items[0]!.at).toBe(6);
    });
  });
});
