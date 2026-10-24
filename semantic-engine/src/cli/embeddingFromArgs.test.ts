import { parseArgs } from './args';
import { embeddingFromArgs } from './embeddingFromArgs';

const parse = (...argv: string[]) => embeddingFromArgs(parseArgs(['index', ...argv]));

describe('--embedding-api-key-env', () => {
  it('accepts provider-style variable names', () => {
    expect(parse('--embedding-provider', 'openai-compatible', '--embedding-api-key-env', 'OPENAI_API_KEY').apiKeyEnvVar)
      .toBe('OPENAI_API_KEY');
    expect(parse('--embedding-provider', 'ollama', '--embedding-api-key-env', 'SEMANTIC_ENGINE_EMBED_KEY').apiKeyEnvVar)
      .toBe('SEMANTIC_ENGINE_EMBED_KEY');
  });

  it('rejects names outside the allowlist, so a flag cannot exfiltrate an arbitrary variable', () => {
    expect(() => parse('--embedding-provider', 'openai-compatible', '--embedding-api-key-env', 'AWS_SECRET_ACCESS_KEY'))
      .toThrow(/not an allowed API-key variable/);
    expect(() => parse('--embedding-provider', 'openai-compatible', '--embedding-api-key-env', 'not a name'))
      .toThrow(/environment variable name/);
  });

  it('operators can extend the allowlist', () => {
    const previous = process.env['SEMANTIC_ENGINE_API_KEY_ENV_PREFIXES'];
    process.env['SEMANTIC_ENGINE_API_KEY_ENV_PREFIXES'] = 'ACME_';
    try {
      expect(parse('--embedding-provider', 'openai-compatible', '--embedding-api-key-env', 'ACME_KEY').apiKeyEnvVar)
        .toBe('ACME_KEY');
    } finally {
      if (previous === undefined) delete process.env['SEMANTIC_ENGINE_API_KEY_ENV_PREFIXES'];
      else process.env['SEMANTIC_ENGINE_API_KEY_ENV_PREFIXES'] = previous;
    }
  });
});
