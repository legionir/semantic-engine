/**
 * `--embedding-*` — فاز ۵.
 *
 * Provider selection must not touch the network, a missing API key must fail
 * loudly, and a secret must never reach the CLI output.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseArgs } from './args';
import {
  createEmbeddingGeneratorFromArgs,
  embeddingFromArgs,
  embeddingRequested,
  resolveVectorPlan,
} from './embeddingFromArgs';
import { HashingEmbeddingGenerator } from '../vector/HashingEmbeddingGenerator';
import { RemoteEmbeddingGenerator } from '../vector/RemoteEmbeddingGenerator';
import { createLoggerFromEnv } from '../host/Logger';
import { runIndex } from './commands/index-command';

const SECRET = 'sk-secret-do-not-leak-123';

describe('--embedding-* flags', () => {
  it('stays disabled until a provider is asked for', () => {
    expect(embeddingRequested(parseArgs(['index', '--vectors']))).toBe(false);
    expect(embeddingFromArgs(parseArgs(['index', '--vectors']))).toEqual({
      enabled: false,
      provider: 'local',
      normalize: true,
    });
    expect(embeddingRequested(parseArgs(['index', '--embedding-provider', 'ollama']))).toBe(true);
  });

  it('rejects an unknown provider with a readable message', () => {
    expect(() => embeddingFromArgs(parseArgs(['index', '--embedding-provider', 'cohere']))).toThrow(
      /--embedding-provider must be one of: local, ollama, openai-compatible/
    );
  });

  it('builds the deterministic local generator without any network', () => {
    const generator = createEmbeddingGeneratorFromArgs(
      parseArgs(['index', '--vectors', '--embedding-provider', 'local']),
      {}
    );

    expect(generator).toBeInstanceOf(HashingEmbeddingGenerator);
  });

  it('builds a remote generator and passes normalize through', () => {
    const normalized = createEmbeddingGeneratorFromArgs(
      parseArgs([
        'index',
        '--vectors',
        '--embedding-provider',
        'openai-compatible',
        '--embedding-base-url',
        'http://127.0.0.1:11434',
        '--embedding-model',
        'text-embedding-3-small',
      ]),
      {}
    ) as RemoteEmbeddingGenerator;

    expect(normalized).toBeInstanceOf(RemoteEmbeddingGenerator);
    expect((normalized as unknown as { options: { normalize?: boolean } }).options.normalize).toBe(true);

    const raw = createEmbeddingGeneratorFromArgs(
      parseArgs([
        'index',
        '--vectors',
        '--embedding-provider',
        'ollama',
        '--embedding-base-url',
        'http://127.0.0.1:11434',
        '--embedding-model',
        'nomic-embed-text',
        '--no-embedding-normalize',
      ]),
      {}
    ) as RemoteEmbeddingGenerator;

    expect((raw as unknown as { options: { normalize?: boolean; provider: string } }).options.normalize).toBe(false);
    expect((raw as unknown as { options: { provider: string } }).options.provider).toBe('ollama');
  });

  it('fails loudly when the named API key variable is empty', () => {
    expect(() =>
      createEmbeddingGeneratorFromArgs(
        parseArgs([
          'index',
          '--vectors',
          '--embedding-provider',
          'openai-compatible',
          '--embedding-base-url',
          'http://127.0.0.1:11434',
          '--embedding-model',
          'm',
          '--embedding-api-key-env',
          'OPENAI_API_KEY',
        ]),
        { OPENAI_API_KEY: '   ' }
      )
    ).toThrow(/OPENAI_API_KEY was given but the environment variable is empty or unset/);
  });

  it('reads the key from the environment, not from the command line', () => {
    const generator = createEmbeddingGeneratorFromArgs(
      parseArgs([
        'index',
        '--vectors',
        '--embedding-provider',
        'openai-compatible',
        '--embedding-base-url',
        'http://127.0.0.1:11434',
        '--embedding-model',
        'm',
        '--embedding-api-key-env',
        'OPENAI_API_KEY',
      ]),
      { OPENAI_API_KEY: SECRET }
    ) as RemoteEmbeddingGenerator;

    expect(generator).toBeInstanceOf(RemoteEmbeddingGenerator);
    expect((generator as unknown as { options: { apiKey?: string } }).options.apiKey).toBe(SECRET);
  });

  it('requires a base URL for a remote provider', () => {
    expect(() =>
      createEmbeddingGeneratorFromArgs(
        parseArgs(['index', '--vectors', '--embedding-provider', 'ollama']),
        {}
      )
    ).toThrow(/needs a baseUrl/);
  });

  it('never leaks the key through the CLI output', async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-embed-')));
    const root = path.join(base, 'app');
    const dataDir = path.join(base, 'data');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');

    const saved = process.env['EMBED_TEST_KEY'];
    process.env['EMBED_TEST_KEY'] = SECRET;

    try {
      /*
      | Port 9 refuses immediately: this test is about what the failure
      | *says*, and it also proves the CLI really reached the remote provider
      | (a `HashingEmbeddingGenerator` would never fail here). `runIndex`
      | propagates pipeline errors to `main`, which turns them into a message,
      | so both paths are captured.
      */
      let everything = '';
      try {
        const result = await runIndex(
          parseArgs([
            'index',
            '--root',
            root,
            '--no-git',
            '--data-dir',
            dataDir,
            '--vectors',
            '--embedding-provider',
            'openai-compatible',
            '--embedding-base-url',
            'http://127.0.0.1:9',
            '--embedding-model',
            'm',
            '--embedding-api-key-env',
            'EMBED_TEST_KEY',
          ]),
          {
            cwd: base,
            logger: createLoggerFromEnv({ SEMANTIC_ENGINE_LOG_LEVEL: 'error' }, { stdio: true }),
          }
        );
        everything = `${JSON.stringify(result.json ?? null)}\n${result.text ?? ''}\n${result.error ?? ''}`;
      } catch (error) {
        everything = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
      }

      expect(everything).not.toContain(SECRET);
    } finally {
      if (saved === undefined) delete process.env['EMBED_TEST_KEY'];
      else process.env['EMBED_TEST_KEY'] = saved;
      fs.rmSync(base, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("index and watch share one vectors/provider rule (resolveVectorPlan)", () => {
  const plan = (argv: string[], hadVectors = false) => resolveVectorPlan(parseArgs(argv), hadVectors, {});

  it("wants no vectors and no generator by default", () => {
    expect(plan(["watch"])).toEqual({ wantsVectors: false, embeddingGenerator: undefined });
  });

  it("keeps vectors when the previous index had them, with the local generator", () => {
    const result = plan(["watch"], true);
    expect(result.wantsVectors).toBe(true);
    expect(result.embeddingGenerator).toBeInstanceOf(HashingEmbeddingGenerator);
  });

  it("an explicit provider turns vectors on and builds THAT provider, not the hashing fallback", () => {
    const result = plan([
      "watch",
      "--embedding-provider", "openai-compatible",
      "--embedding-base-url", "http://127.0.0.1:11434",
      "--embedding-model", "text-embedding-3-small",
    ]);
    expect(result.wantsVectors).toBe(true);
    expect(result.embeddingGenerator).toBeInstanceOf(RemoteEmbeddingGenerator);
  });

  it("--vectors=false wins even when a provider is named", () => {
    expect(plan(["watch", "--embedding-provider", "local", "--no-vectors"]).wantsVectors).toBe(false);
  });

  it("an unknown provider fails immediately", () => {
    expect(() => plan(["watch", "--embedding-provider", "cohere"])).toThrow(/--embedding-provider must be one of/);
  });
});
