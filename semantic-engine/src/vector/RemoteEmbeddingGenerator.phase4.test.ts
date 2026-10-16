import { RemoteEmbeddingGenerator } from './RemoteEmbeddingGenerator';

describe('RemoteEmbeddingGenerator — fail-fast vector contracts', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('does not hide an Ollama batch cardinality error behind legacy fallback', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [[1, 2]] }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const generator = new RemoteEmbeddingGenerator({
      provider: 'ollama',
      baseUrl: 'http://ollama.test',
      model: 'test-model',
    });

    await expect(generator.generateBatch(['one', 'two'])).rejects.toThrow(/cardinality mismatch/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects non-finite or inconsistent remote vectors', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [1, 2] }, { embedding: [1, Number.NaN] }] }),
    }) as unknown as typeof fetch;

    const generator = new RemoteEmbeddingGenerator({
      provider: 'openai-compatible',
      baseUrl: 'http://embeddings.test',
      model: 'test-model',
    });

    await expect(generator.generateBatch(['one', 'two'])).rejects.toThrow(/empty, non-finite, or inconsistent/);
  });
});
