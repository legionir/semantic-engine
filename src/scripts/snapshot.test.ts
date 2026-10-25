/**
 * Plan phase 3 / step 4: the golden-snapshot normaliser must keep stable
 * identifiers (file / symbol / module / graph ids) and must therefore notice
 * when an identity changes.
 */

const { normalise, diff } = require('../../scripts/snapshot.js') as {
  normalise: (value: unknown) => any;
  diff: (expected: unknown, actual: unknown) => string[];
};

describe('snapshot normaliser keeps stable ids', () => {
  it('keeps ids in arrays and in name-keyed objects under a stable container', () => {
    const out = normalise({
      files: [{ id: 'file-1', path: 'a.ts' }],
      symbolIndex: { alpha: { id: 'sym-1' }, beta: { nested: { id: 'sym-2' } } },
      moduleMap: [{ id: 'mod-1', children: [{ id: 'mod-1-a' }] }],
    });
    expect(out.files[0].id).toBe('file-1');
    expect(out.symbolIndex.alpha.id).toBe('sym-1');
    expect(out.symbolIndex.beta.nested.id).toBe('sym-2');
    expect(out.moduleMap[0].children[0].id).toBe('mod-1-a');
  });

  it('still hides ids that are really volatile (outside stable containers)', () => {
    const out = normalise({ meta: { id: 'folds-in-generatedAt' }, generatedAt: 'now', rootPath: '/abs' });
    expect(out.meta.id).toBe('<volatile>');
    expect(out.generatedAt).toBe('<volatile>');
    expect(out.rootPath).toBe('<volatile>');
  });

  it('an identity change is reported by the diff', () => {
    const before = normalise({ symbolIndex: { alpha: { id: 'sym-1' } }, files: [{ id: 'f1' }] });
    const after = normalise({ symbolIndex: { alpha: { id: 'sym-CHANGED' } }, files: [{ id: 'f1' }] });
    const problems = diff(before, after);
    expect(problems.join('\n')).toMatch(/symbolIndex\.alpha\.id/);
    expect(diff(before, before)).toEqual([]);
  });
});
