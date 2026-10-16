import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DEBOUNCE_MS_MAX,
  DEBOUNCE_MS_MIN,
  WORKER_CONFIG_JSON_SCHEMA,
  createWorkerConfig,
  redactWorkerConfig,
  validateWorkerConfig,
} from './WorkerConfigSchema';
import { ProjectWorkerConfig } from './types';

function tmpWorkspace(): string {
  const root = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-wcfg-'))), 'app');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  return root;
}

/** پچ آزاد؛ بخش‌های تودرتو ناقص داده می‌شوند و schema پیش‌فرض‌ها را پر می‌کند. */
type Patch = Record<string, unknown>;

function valid(patch: Patch = {}) {
  const result = validateWorkerConfig({
    projectId: 'prj-app-12345678',
    name: 'App',
    rootPath: tmpWorkspace(),
    ...patch,
  } as never);
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.config;
}

describe('WorkerConfigSchema — every rule has a test', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = tmpWorkspace();
  });

  afterEach(() => {
    fs.rmSync(path.dirname(workspace), { recursive: true, force: true });
  });

  const base = () => ({ projectId: 'prj-app-12345678', name: 'App', rootPath: workspace });

  it('fills defaults and keeps the documented ones', () => {
    const config = createWorkerConfig(base());

    expect(config.indexing.blueprint).toBe(true);
    expect(config.indexing.vectors).toBe(false);
    expect(config.watchOptions.debounceMs).toBe(500);
    expect(config.watchOptions.blueprintMode).toBe('always');
    expect(config.service.transport).toBe('loopback');
    expect(config.service.host).toBe('127.0.0.1');
    expect(config.security.gatewayManaged).toBe(false);
    expect(config.embedding.provider).toBe('local');
  });

  it('accepts a valid config and canonicalizes the root', () => {
    const result = validateWorkerConfig(base());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.rootPath).toBe(workspace);
  });

  it('rejects a project id that cannot be a directory name', () => {
    const result = validateWorkerConfig({ ...base(), projectId: '../evil' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toMatch(/directory name/);
  });

  it('rejects an empty name and an empty root', () => {
    const result = validateWorkerConfig({ ...base(), name: '  ', rootPath: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join()).toMatch(/name must not be empty/);
      expect(result.errors.join()).toMatch(/rootPath must not be empty/);
    }
  });

  it('reports a root that does not exist or is not a directory', () => {
    const missing = validateWorkerConfig({ ...base(), rootPath: path.join(workspace, 'nope') });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors.join()).toMatch(/does not exist/);

    const file = path.join(workspace, 'a-file');
    fs.writeFileSync(file, 'x');
    const notDir = validateWorkerConfig({ ...base(), rootPath: file });
    expect(notDir.ok).toBe(false);
    if (!notDir.ok) expect(notDir.errors.join()).toMatch(/not a directory/);
  });

  it('skips filesystem checks when asked to', () => {
    const result = validateWorkerConfig(
      { ...base(), rootPath: path.join(workspace, 'created-later') },
      { checkFileSystem: false }
    );
    expect(result.ok).toBe(true);
  });

  it('detects a duplicate root', () => {
    const result = validateWorkerConfig(base(), { isRootRegistered: () => true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toMatch(/already registered/);
  });

  it('refuses a data directory inside the checkout unless it is explicit', () => {
    const inside = validateWorkerConfig({
      ...base(),
      dataDir: path.join(workspace, '.data'),
    });
    expect(inside.ok).toBe(false);
    if (!inside.ok) expect(inside.errors.join()).toMatch(/inside the workspace root/);

    const allowed = validateWorkerConfig(
      { ...base(), dataDir: path.join(workspace, '.data') },
      { allowDataDirInsideRoot: true }
    );
    expect(allowed.ok).toBe(true);

    const outside = validateWorkerConfig({
      ...base(),
      dataDir: path.join(path.dirname(workspace), 'data'),
    });
    expect(outside.ok).toBe(true);
  });

  it('keeps debounce inside the safe range', () => {
    for (const debounceMs of [DEBOUNCE_MS_MIN - 1, DEBOUNCE_MS_MAX + 1, 12.5, NaN]) {
      const result = validateWorkerConfig({
        ...base(),
        watchOptions: { debounceMs } as never,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join()).toMatch(/debounceMs/);
    }

    const ok = validateWorkerConfig({
      ...base(),
      watchOptions: { debounceMs: DEBOUNCE_MS_MIN } as never,
    });
    expect(ok.ok).toBe(true);
  });

  it('validates blueprint mode, transport and ports', () => {
    expect(validateWorkerConfig({ ...base(), watchOptions: { blueprintMode: 'sometimes' } as never }).ok).toBe(false);
    expect(validateWorkerConfig({ ...base(), service: { transport: 'carrier-pigeon' } as never }).ok).toBe(false);
    expect(validateWorkerConfig({ ...base(), service: { port: 70000 } as never }).ok).toBe(false);
    expect(validateWorkerConfig({ ...base(), service: { uiPort: -1 } as never }).ok).toBe(false);
  });

  it('requires an absolute socket path outside the checkout', () => {
    const missing = validateWorkerConfig({ ...base(), service: { transport: 'socket' } as never });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors.join()).toMatch(/socketPath is required/);

    const relative = validateWorkerConfig({
      ...base(),
      service: { transport: 'socket', socketPath: 'run/app.sock' },
    } as never);
    expect(relative.ok).toBe(false);
    if (!relative.ok) expect(relative.errors.join()).toMatch(/must be absolute/);

    const inside = validateWorkerConfig({
      ...base(),
      service: { transport: 'socket', socketPath: path.join(workspace, 'app.sock') },
    } as never);
    expect(inside.ok).toBe(false);
    if (!inside.ok) expect(inside.errors.join()).toMatch(/inside the workspace root/);

    const fine = validateWorkerConfig({
      ...base(),
      service: { transport: 'socket', socketPath: '/run/semantic-engine/app.sock' },
    } as never);
    expect(fine.ok).toBe(true);
  });

  it('enforces the security rules for a managed worker', () => {
    const remote = validateWorkerConfig({
      ...base(),
      security: { gatewayManaged: true, allowRemote: true },
    } as never);
    expect(remote.ok).toBe(false);
    if (!remote.ok) expect(remote.errors.join()).toMatch(/must not allow remote/);

    const noToken = validateWorkerConfig({
      ...base(),
      security: { gatewayManaged: true },
    } as never);
    expect(noToken.ok).toBe(false);
    if (!noToken.ok) expect(noToken.errors.join()).toMatch(/tokenEnvVar/);

    const fine = validateWorkerConfig({
      ...base(),
      security: { gatewayManaged: true, tokenEnvVar: 'SE_WORKER_TOKEN' },
    } as never);
    expect(fine.ok).toBe(true);

    const badName = validateWorkerConfig({
      ...base(),
      security: { tokenEnvVar: 'not a var' },
    } as never);
    expect(badName.ok).toBe(false);
  });

  it('refuses a secret in the config itself', () => {
    const result = validateWorkerConfig({ ...base(), token: 'hunter2' } as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toMatch(/must not be part of the worker config/);

    const apiKey = validateWorkerConfig({ ...base(), apiKey: 'sk-1' } as never);
    expect(apiKey.ok).toBe(false);
  });

  it('validates embedding provider requirements', () => {
    const unknown = validateWorkerConfig({
      ...base(),
      embedding: { enabled: true, provider: 'cohere' },
    } as never);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.errors.join()).toMatch(/embedding.provider/);

    const noUrl = validateWorkerConfig({
      ...base(),
      embedding: { enabled: true, provider: 'ollama' },
    } as never);
    expect(noUrl.ok).toBe(false);
    if (!noUrl.ok) expect(noUrl.errors.join()).toMatch(/needs embedding.baseUrl/);

    const noModel = validateWorkerConfig({
      ...base(),
      embedding: { enabled: true, provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434' },
    } as never);
    expect(noModel.ok).toBe(false);
    if (!noModel.ok) expect(noModel.errors.join()).toMatch(/needs embedding.model/);

    const defaultModel = validateWorkerConfig({
      ...base(),
      embedding: {
        enabled: true,
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:11434',
        useDefaultModel: true,
        apiKeyEnvVar: 'OPENAI_API_KEY',
      },
    } as never);
    expect(defaultModel.ok).toBe(true);

    const badEnvName = validateWorkerConfig({
      ...base(),
      embedding: { apiKeyEnvVar: 'sk-live-123' },
    } as never);
    expect(badEnvName.ok).toBe(false);
  });

  it('reports every problem at once', () => {
    const result = validateWorkerConfig({
      projectId: 'nope',
      name: '',
      rootPath: '',
      watchOptions: { debounceMs: 1 },
      security: { gatewayManaged: true },
    } as never);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThanOrEqual(4);
  });

  it('redacts to the known fields only', () => {
    const config = valid({ security: { gatewayManaged: true, tokenEnvVar: 'SE_TOKEN' } });
    const redacted = redactWorkerConfig({ ...config, leaked: 'x' } as never) as unknown as Record<
      string,
      unknown
    >;

    expect(redacted['leaked']).toBeUndefined();
    expect(redacted['security']).toEqual({ gatewayManaged: true, allowRemote: false, tokenEnvVar: 'SE_TOKEN' });
    expect(JSON.stringify(redacted)).not.toMatch(/hunter2|sk-/);
  });

  it('keeps the JSON schema in step with the defaults', () => {
    const properties = WORKER_CONFIG_JSON_SCHEMA.properties;
    expect(properties.autoStart.default).toBe(false);
    expect(properties.watchOptions.properties.debounceMs.minimum).toBe(DEBOUNCE_MS_MIN);
    expect(properties.watchOptions.properties.debounceMs.maximum).toBe(DEBOUNCE_MS_MAX);
    expect(properties.embedding.properties.provider.enum).toEqual([
      'local',
      'ollama',
      'openai-compatible',
    ]);
    expect(WORKER_CONFIG_JSON_SCHEMA.additionalProperties).toBe(false);
    /* A secret is not a field, so it must not be describable either. */
    expect(Object.keys(properties.security.properties)).toEqual([
      'gatewayManaged',
      'allowRemote',
      'tokenEnvVar',
    ]);
  });
});
