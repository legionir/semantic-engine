import { RerankerService } from './RerankerService';

describe('RerankerService (V2 Hybrid Reranking)', () => {
  it('boosts candidates with exact lexical tokens and high vector similarity', () => {
    const reranker = new RerankerService();

    const candidates = [
      { id: '1', name: 'UserService', path: 'src/user.service.ts', content: 'handles user registration', vectorScore: 0.8 },
      { id: '2', name: 'AuthService', path: 'src/auth.service.ts', content: 'handles login authentication', vectorScore: 0.6 },
      { id: '3', name: 'PaymentService', path: 'src/payment.service.ts', content: 'processes payments', vectorScore: 0.3 },
    ];

    const results = reranker.rerank('login authentication', candidates);
    expect(results[0]?.id).toBe('2'); // AuthService matches query tokens
    expect(results[0]?.finalScore).toBeGreaterThan(results[1]?.finalScore || 0);
  });
});
