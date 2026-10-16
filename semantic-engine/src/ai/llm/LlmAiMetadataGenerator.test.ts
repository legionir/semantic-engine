/**
 * تست LlmAiMetadataGenerator با mock LLM client.
 */

import { LlmAiMetadataGenerator } from './LlmAiMetadataGenerator';
import { ILlmClient, LlmCompletionResult } from './LlmClient';
import { FileEntry, SymbolEntry } from '../../core/types/project-index.types';
import { makeConfidence } from '../../core/types/common.types';

function createFile(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    id: 'f1',
    path: 'src/auth/login.ts',
    language: 'typescript',
    encoding: 'utf8',
    size: 100,
    lines: 20,
    hash: 'abc',
    modified: new Date().toISOString(),
    binary: false,
    testFile: false,
    generated: false,
    imports: [{ from: 'express', type: 'package' }],
    exports: [{ name: 'login', kind: 'named' }],
    symbolIds: [],
    outline: [],
    ...overrides,
  };
}

function createMockLlmClient(response: LlmCompletionResult): ILlmClient {
  return {
    config: {
      apiKey: 'test',
      model: 'test-model',
    },
    complete: jest.fn().mockResolvedValue(response),
    dispose: jest.fn().mockResolvedValue(undefined),
  };
}

describe('LlmAiMetadataGenerator', () => {
  it('should parse LLM JSON response into AiMetadata', async () => {
    const client = createMockLlmClient({
      content: JSON.stringify({
        summary: 'Handles user login',
        keywords: ['auth', 'login'],
        businessDomains: ['Authentication'],
        designPatterns: ['Controller'],
        frameworks: ['Express'],
      }),
      model: 'test-model',
    });

    const generator = new LlmAiMetadataGenerator({ llmClient: client });
    const file = createFile();
    const symbol: SymbolEntry = {
      id: 's1',
      fileId: 'f1',
      parentId: null,
      kind: 'function',
      name: 'login',
      line: 1,
      endLine: 5,
      source: 'lsp',
      confidence: makeConfidence(90),
    };

    const result = await generator.generate({
      workspaceRoot: '/project',
      files: [file],
      symbols: [symbol],
      dependencyGraph: [],
    });

    const metadata = result.get('f1')!;
    expect(metadata.summary).toBe('Handles user login');
    expect(metadata.keywords).toContain('auth');
    expect(metadata.businessDomains).toContain('Authentication');
    expect(metadata.designPatterns).toContain('Controller');
    expect(metadata.frameworks).toContain('Express');
    expect(metadata.aiScore).toBeDefined();
  });

  it('should redact secrets before sending to LLM', async () => {
    const client = createMockLlmClient({
      content: JSON.stringify({ summary: 'ok', keywords: [], businessDomains: [], designPatterns: [], frameworks: [] }),
      model: 'test-model',
    });

    const generator = new LlmAiMetadataGenerator({ llmClient: client });
    const file = createFile({
      path: 'src/config.ts',
      exports: [{ name: 'config', kind: 'named' }],
    });
    const symbol: SymbolEntry = {
      id: 's1',
      fileId: 'f1',
      parentId: null,
      kind: 'variable',
      name: 'config',
      line: 1,
      endLine: 3,
      signature: 'api_key=sk-1234567890abcdef',
      source: 'lsp',
      confidence: makeConfidence(90),
    };

    await generator.generate({
      workspaceRoot: '/project',
      files: [file],
      symbols: [symbol],
      dependencyGraph: [],
    });

    const completeCalls = (client.complete as jest.Mock).mock.calls;
    expect(completeCalls.length).toBeGreaterThan(0);
    const lastCallMessages = completeCalls[completeCalls.length - 1][0];
    const userMessage = lastCallMessages.find((m: any) => m.role === 'user');
    expect(userMessage.content).not.toContain('sk-1234567890abcdef');
    expect(userMessage.content).toContain('[REDACTED_API_KEY]');
  });

  it('should fall back on LLM failure', async () => {
    const client = createMockLlmClient({
      content: '',
      model: 'test-model',
    });
    (client.complete as jest.Mock).mockRejectedValue(new Error('Network error'));

    const generator = new LlmAiMetadataGenerator({ llmClient: client });
    const file = createFile();

    const result = await generator.generate({
      workspaceRoot: '/project',
      files: [file],
      symbols: [],
      dependencyGraph: [],
    });

    const metadata = result.get('f1')!;
    expect(metadata.summary).toBe('File src/auth/login.ts');
    expect((metadata.keywords ?? []).length).toBeGreaterThan(0);
  });
});
