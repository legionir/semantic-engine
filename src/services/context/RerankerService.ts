/**
 * RerankerService — Cross-scores lexical BM25/keyword matches with semantic embeddings.
 */

export interface CandidateItem {
  readonly id: string;
  readonly name: string;
  readonly content: string;
  readonly path: string;
  readonly vectorScore?: number;
  readonly lexicalScore?: number;
}

export interface RerankedItem extends CandidateItem {
  readonly finalScore: number;
  readonly matchExplanation: string;
}

export class RerankerService {
  rerank(query: string, candidates: readonly CandidateItem[], limit: number = 20): RerankedItem[] {
    const queryTokens = query.toLowerCase().split(/\s+/).filter(Boolean);

    const scored: RerankedItem[] = candidates.map(c => {
      const text = `${c.name} ${c.path} ${c.content}`.toLowerCase();

      // Compute lexical overlap score
      let lexicalMatchCount = 0;
      for (const token of queryTokens) {
        if (text.includes(token)) lexicalMatchCount++;
      }
      const lexicalScore = queryTokens.length > 0
        ? (lexicalMatchCount / queryTokens.length) * 100
        : 0;

      const vectorScore = c.vectorScore !== undefined ? c.vectorScore * 100 : 50;

      // Exact name match boost
      const exactNameBoost = c.name.toLowerCase() === query.toLowerCase() ? 30 : 0;

      // Weighted hybrid formula: 50% vector + 35% lexical + 15% name boost
      const finalScore = Math.min(100, Math.round(vectorScore * 0.5 + lexicalScore * 0.35 + exactNameBoost));

      return {
        ...c,
        finalScore,
        matchExplanation: `Vector: ${Math.round(vectorScore)}%, Lexical: ${Math.round(lexicalScore)}%, ExactBoost: ${exactNameBoost}`,
      };
    });

    scored.sort((a, b) => b.finalScore - a.finalScore);
    return scored.slice(0, limit);
  }
}
