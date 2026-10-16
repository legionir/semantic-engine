import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseArgs } from './args';
import { applyGlobalConfig } from './globalConfigDefaults';
import { globalConfigPath, saveGlobalConfig } from '../core/config/GlobalConfig';

describe('applyGlobalConfig — flag > env > config.json > default', () => {
  let dataRoot: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'se-cli-config-'));
    env = { SEMANTIC_ENGINE_DATA_DIR: dataRoot };
  });
  afterEach(() => fs.rmSync(dataRoot, { recursive: true, force: true }));

  it('start creates the file and turns the whole stack on by default', () => {
    const applied = applyGlobalConfig(parseArgs(['start']), env)!;

    expect(fs.existsSync(globalConfigPath(dataRoot))).toBe(true);
    expect(applied.args.options).toMatchObject({
      uiPort: '4000',
      mcpPort: '3000',
      watch: true,
      vectors: true,
      lspDiagnostics: true,
      embeddingProvider: 'local',
    });
    expect(env['SEMANTIC_ENGINE_MODELS_DIR']).toBe(path.join(dataRoot, 'models'));
  });

  it('values from config.json replace the defaults', () => {
    saveGlobalConfig(dataRoot, { server: { uiPort: 5100 }, scan: { lspDiagnostics: false } });
    const { args } = applyGlobalConfig(parseArgs(['start']), env)!;
    expect(args.options['uiPort']).toBe('5100');
    expect(args.options['lspDiagnostics']).toBe(false);
  });

  it('an explicit flag always wins over the file', () => {
    saveGlobalConfig(dataRoot, { server: { uiPort: 5100 } });
    const { args } = applyGlobalConfig(parseArgs(['start', '--ui-port', '4999', '--no-vectors']), env)!;
    expect(args.options['uiPort']).toBe('4999');
    expect(args.options['vectors']).toBe(false);
    expect(args.options['embeddingProvider']).toBeUndefined();
  });

  it('the shared --port is not shadowed by the configured uiPort on start', () => {
    saveGlobalConfig(dataRoot, { server: { uiPort: 5100 } });
    const { args } = applyGlobalConfig(parseArgs(['start', '--port', '5000']), env)!;
    expect(args.options['uiPort']).toBeUndefined();
    expect(args.options['port']).toBe('5000');
  });

  it('index does not start building vectors just because the file says so', () => {
    const { args } = applyGlobalConfig(parseArgs(['index']), env)!;
    expect(args.options['vectors']).toBeUndefined();
    expect(args.options['embeddingProvider']).toBeUndefined();
    expect(fs.existsSync(globalConfigPath(dataRoot))).toBe(false);
  });

  it('start falls back to hashing, with a notice, when the chosen model is not downloaded', () => {
    saveGlobalConfig(dataRoot, { embedding: { model: 'Xenova/bge-small-en-v1.5', useDefaultModel: false } });
    const { args, notices } = applyGlobalConfig(parseArgs(['start']), env)!;
    /* Spawned children re-read config.json, so the fallback must be an explicit flag. */
    expect(args.options['embeddingModel']).toBe('hashing-256');
    expect(args.options['embeddingProvider']).toBe('local');
    expect(args.options['vectors']).toBe(true);
    expect(notices.join(' ')).toMatch(/not downloaded/);
  });

  it('index --vectors keeps the chosen model, so a missing download is an explicit error', () => {
    saveGlobalConfig(dataRoot, { embedding: { model: 'Xenova/bge-small-en-v1.5', useDefaultModel: false } });
    const { args, notices } = applyGlobalConfig(parseArgs(['index', '--vectors']), env)!;
    expect(args.options['embeddingModel']).toBe('Xenova/bge-small-en-v1.5');
    expect(notices).toEqual([]);
  });

  it('the artifact location env var outranks the file', () => {
    saveGlobalConfig(dataRoot, { artifacts: { location: 'in-root' } });
    env['SEMANTIC_ENGINE_ARTIFACT_LOCATION'] = 'external';
    const { args } = applyGlobalConfig(parseArgs(['start']), env)!;
    expect(args.options['artifactLocation']).toBeUndefined();
  });
});
