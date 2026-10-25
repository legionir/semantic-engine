import { ContextRanker, RankCandidate } from './ContextRanker';

/*
| Regression for the hybrid-fusion fix: when embeddings are present, a
| single shallow keyword-name match must not tie/beat a semantic (vector)
| match, and a candidate confirmed by BOTH must rank highest. Without the
| fixed-denominator core-relevance, keyword-only won (the reported bug).
*/

const candidates: RankCandidate[] = [
  { id: 'kw-only', signals: { keyword: 3 } },        // e.g. `constant functions` on "function"
  { id: 'vec-only', signals: { vector: 0.9 } },      // e.g. `MutationSimulator` for "blast radius"
  { id: 'both', signals: { keyword: 3, vector: 0.9 } },
];

const byId = (ranked: { id: string; score: number }[]) =>
  Object.fromEntries(ranked.map(r => [r.id, r.score]));

describe('ContextRanker hybrid core-relevance fusion', () => {
  const ranker = new ContextRanker();

  it('default path: keyword-only outranks vector-only (the behavior we are fixing)', () => {
    const scores = byId(ranker.rank(candidates));
    expect(scores['kw-only']).toBeGreaterThan(scores['vec-only']);
  });

  it('with coreRelevanceSignals + vector weight, semantic beats shallow keyword and both is best', () => {
    const ranked = ranker.rank(candidates, {
      coreRelevanceSignals: ['keyword', 'vector'],
      weights: { keyword: 1, vector: 2 },
    });
    const scores = byId(ranked);
    const order = ranked.map(r => r.id);

    // both > vector-only > keyword-only
    expect(order).toEqual(['both', 'vec-only', 'kw-only']);
    expect(scores['vec-only']).toBeGreaterThan(scores['kw-only']);

    // single-signal candidates are capped by the fixed denominator (1+2=3)
    expect(scores['kw-only']).toBeCloseTo(1 / 3, 3);
    expect(scores['vec-only']).toBeCloseTo(0.9 * 2 / 3, 3);
  });

  it('a keyword-only cohort is unaffected (no vector present → no penalty)', () => {
    const keywordOnly: RankCandidate[] = [
      { id: 'a', signals: { keyword: 3 } },
      { id: 'b', signals: { keyword: 1 } },
    ];
    const ranked = ranker.rank(keywordOnly, {
      coreRelevanceSignals: ['keyword', 'vector'],
      weights: { keyword: 1, vector: 2 },
    });
    expect(ranked.map(r => r.id)).toEqual(['a', 'b']);
    expect(ranked[0]!.score).toBeCloseTo(1, 3);
  });
});
