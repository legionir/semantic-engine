import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createSettingsRoutes } from './settingsRoutes';
import { loadGlobalConfig } from '../../core/config/GlobalConfig';

describe('PUT /api/v1/settings validation', () => {
  let dataRoot: string;
  beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'se-settings-'));
  });
  afterEach(() => fs.rmSync(dataRoot, { recursive: true, force: true }));

  const put = (body: unknown) => {
    const route = createSettingsRoutes({ dataRoot } as never).find(r => r.method === 'PUT')!;
    return route.handler({ body } as never) as Promise<{ status: number; json: Record<string, unknown> }>;
  };

  it('rejects a metadata-service URL and does not persist it', async () => {
    const res = await put({ chat: { baseUrl: 'http://169.254.169.254/latest' } });
    expect(res.status).toBe(400);
    expect(loadGlobalConfig(dataRoot).config.chat.baseUrl).toBe('');
  });

  it('rejects a model hub URL that points at a private address', async () => {
    const res = await put({ models: { hubUrl: 'http://10.0.0.5/hub' } });
    expect(res.status).toBe(400);
  });

  it('rejects an api-key variable that is not a plain env var name', async () => {
    const res = await put({ embedding: { apiKeyEnvVar: 'A B;rm' } });
    expect(res.status).toBe(400);
  });

  it('rejects an api-key variable outside the provider allowlist (secret exfiltration)', async () => {
    const res = await put({
      chat: { baseUrl: 'https://example.com/v1', apiKeyEnvVar: 'AWS_SECRET_ACCESS_KEY' },
    });
    expect(res.status).toBe(400);
    expect(loadGlobalConfig(dataRoot).config.chat.apiKeyEnvVar).not.toBe('AWS_SECRET_ACCESS_KEY');
  });

  it('accepts a loopback endpoint (local Ollama) and a valid variable name', async () => {
    const res = await put({
      embedding: { baseUrl: 'http://127.0.0.1:11434', apiKeyEnvVar: 'OPENAI_API_KEY' },
    });
    expect(res.status).toBe(200);
    expect(loadGlobalConfig(dataRoot).config.embedding.baseUrl).toBe('http://127.0.0.1:11434');
  });
});
