import { ContextCompressor } from './ContextCompressor';

describe('ContextCompressor (V2 Token Budget Optimizer)', () => {
  it('compresses function implementation bodies when signatures only requested', () => {
    const compressor = new ContextCompressor();
    const sourceCode = `
export class PaymentService {
  async processPayment(amount: number) {
    const valid = validate(amount);
    const res = await callGateway(amount);
    return res;
  }
}
`;

    const { compressed, savedRatio } = compressor.compressSnippet(sourceCode, {
      keepSignaturesOnly: true,
    });

    expect(compressed).toContain('export class PaymentService');
    expect(compressed).toContain('/* ... implementation compressed ... */');
    expect(savedRatio).toBeGreaterThan(0);
  });
});
