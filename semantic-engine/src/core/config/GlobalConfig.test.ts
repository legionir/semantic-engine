import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  defaultGlobalConfig,
  ensureGlobalConfig,
  globalConfigPath,
  loadGlobalConfig,
  modelsDirFor,
  saveGlobalConfig,
} from './GlobalConfig';

describe('GlobalConfig (<dataRoot>/config.json)', () => {
  let dataRoot: string;

  beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'se-global-config-'));
  });
  afterEach(() => fs.rmSync(dataRoot, { recursive: true, force: true }));

  it('uses the defaults and writes nothing when the file is missing', () => {
    const loaded = loadGlobalConfig(dataRoot);
    expect(loaded.exists).toBe(false);
    expect(loaded.config).toEqual(defaultGlobalConfig());
    expect(fs.existsSync(globalConfigPath(dataRoot))).toBe(false);
  });

  it('ensure writes every default so the user has something to edit', () => {
    const loaded = ensureGlobalConfig(dataRoot);
    expect(loaded.exists).toBe(true);
    expect(JSON.parse(fs.readFileSync(globalConfigPath(dataRoot), 'utf8'))).toEqual(defaultGlobalConfig());
  });

  it('applies valid values, ignores wrong types and unknown keys with warnings', () => {
    fs.writeFileSync(
      globalConfigPath(dataRoot),
      JSON.stringify({
        server: { uiPort: 5000, mcpPort: 'nope', bogus: 1 },
        embedding: { provider: 'ollama', model: ' nomic-embed-text ' },
        scan: { maxDepth: -3 },
      })
    );
    const { config, warnings } = loadGlobalConfig(dataRoot);

    expect(config.server.uiPort).toBe(5000);
    expect(config.server.mcpPort).toBe(3000);
    expect(config.embedding.provider).toBe('ollama');
    expect(config.embedding.model).toBe('nomic-embed-text');
    expect(config.scan.maxDepth).toBe(0);
    expect(warnings.join('\n')).toMatch(/server\.mcpPort/);
    expect(warnings.join('\n')).toMatch(/server\.bogus/);
    expect(warnings.join('\n')).toMatch(/scan\.maxDepth/);
  });

  it('a broken file never stops the engine: defaults plus a warning', () => {
    fs.writeFileSync(globalConfigPath(dataRoot), '{ not json');
    const loaded = loadGlobalConfig(dataRoot);
    expect(loaded.config).toEqual(defaultGlobalConfig());
    expect(loaded.warnings[0]).toMatch(/not valid JSON/);
  });

  it('save merges a patch into the stored file', () => {
    saveGlobalConfig(dataRoot, { chat: { model: 'qwen2.5-coder' } });
    const { config } = saveGlobalConfig(dataRoot, { server: { uiPort: 4100 } });

    expect(config.chat.model).toBe('qwen2.5-coder');
    expect(config.server.uiPort).toBe(4100);
    expect(loadGlobalConfig(dataRoot).config.chat.model).toBe('qwen2.5-coder');
  });

  it('models live under the data root unless models.dir says otherwise', () => {
    expect(modelsDirFor(dataRoot)).toBe(path.join(dataRoot, 'models'));
    const { config } = saveGlobalConfig(dataRoot, { models: { dir: 'elsewhere' } });
    expect(modelsDirFor(dataRoot, config)).toBe(path.join(dataRoot, 'elsewhere'));
  });
});
