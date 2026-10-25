/**
 * پیکربندی میزبان — MIG-11.
 *
 * امروز پیکربندی فقط از `vscode.workspace.getConfiguration` می‌آید. برای
 * اجرای مستقل باید چهار منبع با ترتیب مشخص ادغام شوند:
 *
 *     flag  >  env  >  file  >  default
 *
 * و مقدار نامعتبر باید *پیش از* شروع ایندکس، با پیامی که می‌گوید مقصر
 * کدام منبع است، رد شود — نه اینکه نیمهٔ راه به یک TypeError تبدیل شود.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Config, ConfigError, envVarNameFor, findConfigFile } from './Config';

const KEY = 'semanticEngine.llm.model';

describe('Config', () => {

  describe('precedence: flag > env > file > default', () => {

    /*
    | چهار منبع، یک کلید، چهار مقدار متفاوت. با کنار رفتن هر لایه، لایهٔ
    | بعدی باید دیده شود. این دقیقاً معیار پذیرش فاز ۰۷ است.
    */

    const fromFile = { 'semanticEngine.llm.model': 'from-file' };
    const fromEnv = { SEMANTIC_ENGINE_LLM_MODEL: 'from-env' };
    const fromFlag = ['--llm.model=from-flag'];

    it('takes the flag when all four are present', () => {
      const config = Config.load({ argv: fromFlag, env: fromEnv, file: fromFile });

      expect(config.get(KEY)).toBe('from-flag');
      expect(config.originOf(KEY)).toBe('flag');
    });

    it('falls back to the environment when there is no flag', () => {
      const config = Config.load({ argv: [], env: fromEnv, file: fromFile });

      expect(config.get(KEY)).toBe('from-env');
      expect(config.originOf(KEY)).toBe('env');
    });

    it('falls back to the file when there is no flag and no env', () => {
      const config = Config.load({ argv: [], env: {}, file: fromFile });

      expect(config.get(KEY)).toBe('from-file');
      expect(config.originOf(KEY)).toBe('file');
    });

    it('falls back to the schema default when nothing is set', () => {
      const config = Config.load({ argv: [], env: {}, file: {} });

      expect(config.get(KEY)).toBe('gpt-4o-mini');
      expect(config.originOf(KEY)).toBe('default');
    });

    it('resolves each key independently, not the whole file at once', () => {
      const config = Config.load({
        argv: ['--llm.model=flagged'],
        env: { SEMANTIC_ENGINE_LLM_MAX_TOKENS: '2048' },
        file: { 'semanticEngine.llm.temperature': 0.7 },
      });

      expect(config.get('semanticEngine.llm.model')).toBe('flagged');
      expect(config.get('semanticEngine.llm.maxTokens')).toBe(2048);
      expect(config.get('semanticEngine.llm.temperature')).toBe(0.7);
      expect(config.get('semanticEngine.llm.provider')).toBe('openai');
    });
  });

  describe('key shapes', () => {

    it('accepts a key with or without the semanticEngine prefix', () => {
      const config = Config.load({ file: { 'semanticEngine.llm.model': 'x' } });

      expect(config.get('llm.model')).toBe('x');
      expect(config.get('semanticEngine.llm.model')).toBe('x');
    });

    it('reads a nested config file, the way a hand-written JSON file looks', () => {
      const config = Config.load({
        file: { semanticEngine: { llm: { model: 'nested' }, embedding: { enabled: false } } },
      });

      expect(config.get('llm.model')).toBe('nested');
      expect(config.get('embedding.enabled')).toBe(false);
    });

    it('reads a file that omits the semanticEngine prefix entirely', () => {
      const config = Config.load({ file: { llm: { model: 'bare' } } });

      expect(config.get('llm.model')).toBe('bare');
    });

    it('lets an explicit fallback win over a missing value but not over a real one', () => {
      const config = Config.load({ file: { 'semanticEngine.llm.baseUrl': 'http://x' } });

      expect(config.get('llm.baseUrl', 'unused')).toBe('http://x');
      expect(config.get('treeSitter.grammarDir', '/fallback')).toBe('/fallback');
    });

    it('rejects reading a key that the schema does not define', () => {
      const config = Config.load({});

      expect(() => config.get('llm.nonsense')).toThrow(/unknown configuration key/i);
    });
  });

  describe('environment variable naming', () => {

    it('maps dotted camelCase keys to SCREAMING_SNAKE_CASE', () => {
      expect(envVarNameFor('semanticEngine.llm.model')).toBe('SEMANTIC_ENGINE_LLM_MODEL');
      expect(envVarNameFor('semanticEngine.treeSitter.grammarDir'))
        .toBe('SEMANTIC_ENGINE_TREE_SITTER_GRAMMAR_DIR');
      expect(envVarNameFor('semanticEngine.vectorSearch.usearchThreshold'))
        .toBe('SEMANTIC_ENGINE_VECTOR_SEARCH_USEARCH_THRESHOLD');
    });

    it('gives every schema key a distinct environment variable', () => {
      const names = Config.keys().map(envVarNameFor);

      expect(new Set(names).size).toBe(names.length);
    });

    it('ignores an environment variable that is set to an empty string', () => {
      const config = Config.load({ env: { SEMANTIC_ENGINE_LLM_MODEL: '' } });

      expect(config.get(KEY)).toBe('gpt-4o-mini');
      expect(config.originOf(KEY)).toBe('default');
    });
  });

  describe('flag shapes', () => {

    it('accepts --key=value and --key value', () => {
      expect(Config.load({ argv: ['--llm.model=a'] }).get(KEY)).toBe('a');
      expect(Config.load({ argv: ['--llm.model', 'b'] }).get(KEY)).toBe('b');
    });

    it('accepts kebab-case flags for camelCase keys', () => {
      const config = Config.load({ argv: ['--tree-sitter.grammar-dir=/g'] });

      expect(config.get('treeSitter.grammarDir')).toBe('/g');
    });

    it('treats a bare boolean flag as true and --no- as false', () => {
      expect(Config.load({ argv: ['--llm.enabled'] }).get('llm.enabled')).toBe(true);
      expect(Config.load({ argv: ['--no-embedding.enabled'] }).get('embedding.enabled')).toBe(false);
    });

    it('does not swallow the next flag as the value of a boolean flag', () => {
      const config = Config.load({ argv: ['--llm.enabled', '--llm.model=kept'] });

      expect(config.get('llm.enabled')).toBe(true);
      expect(config.get('llm.model')).toBe('kept');
    });

    it('leaves flags that are not configuration keys alone', () => {
      const config = Config.load({ argv: ['--out', 'dist', 'index', '--llm.model=x'] });

      expect(config.get(KEY)).toBe('x');
      expect(config.unknownFlags).toEqual([]);
    });

    /*
    | یک تایپو در نام کلید بدترین حالت است: خاموش نادیده گرفته می‌شود و
    | کاربر ساعت‌ها فکر می‌کند تنظیمش اثر نکرده. پرچمی که *شبیه* کلید
    | پیکربندی است ولی نیست، باید خطا بدهد.
    */
    it('reports a mistyped configuration flag instead of ignoring it', () => {
      expect(() => Config.load({ argv: ['--llm.modle=x'] }))
        .toThrow(/unknown configuration flag.*--llm\.modle/is);
    });

    it('suggests the closest key for a mistyped flag', () => {
      try {
        Config.load({ argv: ['--llm.modle=x'] });
        throw new Error('should have thrown');
      } catch (error) {
        expect((error as Error).message).toContain('semanticEngine.llm.model');
      }
    });
  });

  describe('type coercion from strings', () => {

    it('coerces numbers coming from env and flags', () => {
      expect(Config.load({ env: { SEMANTIC_ENGINE_LLM_MAX_TOKENS: '512' } }).get('llm.maxTokens'))
        .toBe(512);
      expect(Config.load({ argv: ['--llm.temperature=0.5'] }).get('llm.temperature')).toBe(0.5);
    });

    it('coerces booleans from the usual spellings', () => {
      for (const truthy of ['true', '1', 'yes', 'on', 'TRUE']) {
        expect(Config.load({ env: { SEMANTIC_ENGINE_LLM_ENABLED: truthy } }).get('llm.enabled'))
          .toBe(true);
      }
      for (const falsy of ['false', '0', 'no', 'off', 'FALSE']) {
        expect(Config.load({ env: { SEMANTIC_ENGINE_EMBEDDING_ENABLED: falsy } })
          .get('embedding.enabled')).toBe(false);
      }
    });

    it('reads a nullable string key as null when set to the word null', () => {
      const config = Config.load({ env: { SEMANTIC_ENGINE_LLM_BASE_URL: 'null' } });

      expect(config.get('llm.baseUrl')).toBeNull();
    });

    it('does not coerce a value that already has the right type in the file', () => {
      const config = Config.load({ file: { 'semanticEngine.llm.maxTokens': 300 } });

      expect(config.get('llm.maxTokens')).toBe(300);
    });
  });

  describe('validation', () => {

    it('rejects a number outside the schema range', () => {
      expect(() => Config.load({ file: { 'semanticEngine.llm.temperature': 5 } }))
        .toThrow(ConfigError);
    });

    it('names the key, the offending value and the source in the message', () => {
      try {
        Config.load({ env: { SEMANTIC_ENGINE_LLM_TEMPERATURE: '5' } });
        throw new Error('should have thrown');
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain('semanticEngine.llm.temperature');
        expect(message).toContain('5');
        expect(message).toContain('SEMANTIC_ENGINE_LLM_TEMPERATURE');
        expect(message).toMatch(/<= ?2|maximum/i);
      }
    });

    it('rejects a value outside an enum and lists the allowed values', () => {
      try {
        Config.load({ file: { 'semanticEngine.vectorSearch.backend': 'faiss' } });
        throw new Error('should have thrown');
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain('vectorSearch.backend');
        expect(message).toContain('usearch');
        expect(message).toContain('brute-force');
      }
    });

    it('rejects a string where a number belongs', () => {
      expect(() => Config.load({ env: { SEMANTIC_ENGINE_LLM_MAX_TOKENS: 'many' } }))
        .toThrow(/maxTokens/);
    });

    it('collects every problem instead of stopping at the first', () => {
      try {
        Config.load({
          file: {
            'semanticEngine.llm.temperature': 9,
            'semanticEngine.vectorSearch.backend': 'faiss',
          },
        });
        throw new Error('should have thrown');
      } catch (error) {
        expect((error as ConfigError).issues).toHaveLength(2);
      }
    });

    it('rejects an unknown key found in the config file', () => {
      expect(() => Config.load({ file: { 'semanticEngine.llm.modle': 'x' } }))
        .toThrow(/unknown configuration key/i);
    });
  });

  describe('reading from disk', () => {

    let dir: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-config-'));
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('loads semantic-engine.config.json from the working directory', () => {
      fs.writeFileSync(
        path.join(dir, 'semantic-engine.config.json'),
        JSON.stringify({ semanticEngine: { llm: { model: 'on-disk' } } })
      );

      const config = Config.load({ cwd: dir, env: {}, argv: [] });

      expect(config.get(KEY)).toBe('on-disk');
      expect(config.configFilePath).toBe(path.join(dir, 'semantic-engine.config.json'));
    });

    it('walks up to find the config file of an enclosing project', () => {
      const nested = path.join(dir, 'packages', 'app');
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'semantic-engine.config.json'),
        JSON.stringify({ 'semanticEngine.llm.model': 'root-level' })
      );

      expect(findConfigFile(nested)).toBe(path.join(dir, 'semantic-engine.config.json'));
      expect(Config.load({ cwd: nested, env: {}, argv: [] }).get(KEY)).toBe('root-level');
    });

    it('works with no config file at all', () => {
      const config = Config.load({ cwd: dir, env: {}, argv: [] });

      expect(config.get(KEY)).toBe('gpt-4o-mini');
      expect(config.configFilePath).toBeNull();
    });

    it('reports a malformed config file by path instead of throwing a bare SyntaxError', () => {
      const file = path.join(dir, 'semantic-engine.config.json');
      fs.writeFileSync(file, '{ "semanticEngine": ');

      try {
        Config.load({ cwd: dir, env: {}, argv: [] });
        throw new Error('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as Error).message).toContain(file);
      }
    });

    it('respects an explicit --config path over discovery', () => {
      const explicit = path.join(dir, 'other.json');
      fs.writeFileSync(explicit, JSON.stringify({ 'semanticEngine.llm.model': 'explicit' }));
      fs.writeFileSync(
        path.join(dir, 'semantic-engine.config.json'),
        JSON.stringify({ 'semanticEngine.llm.model': 'discovered' })
      );

      const config = Config.load({ cwd: dir, argv: ['--config', explicit], env: {} });

      expect(config.get(KEY)).toBe('explicit');
    });

    it('fails loudly when an explicitly named config file is missing', () => {
      expect(() => Config.load({ cwd: dir, argv: ['--config=/nope/absent.json'], env: {} }))
        .toThrow(/absent\.json/);
    });
  });

  describe('introspection', () => {

    it('exposes the resolved values with their sources', () => {
      const config = Config.load({
        argv: ['--llm.model=m'],
        env: { SEMANTIC_ENGINE_LLM_ENABLED: 'true' },
        file: {},
      });
      const described = config.describe();

      expect(described['semanticEngine.llm.model']).toEqual({ value: 'm', source: 'flag' });
      expect(described['semanticEngine.llm.enabled']).toEqual({ value: true, source: 'env' });
      expect(described['semanticEngine.llm.provider'].source).toBe('default');
    });

    /*
    | describe() برای گزارش خطا و لاگ استفاده می‌شود. اگر روزی کلیدی
    | حاوی راز اضافه شود، این تست یادآوری می‌کند که آنجا باید پوشانده
    | شود. امروز تنها کلید مرتبط، *نام* متغیر محیطی است، نه خود کلید.
    */
    it('holds no secret material, only the name of the env var that does', () => {
      const config = Config.load({});

      expect(config.get('llm.apiKeyEnvVar')).toBe('SEMANTIC_ENGINE_LLM_API_KEY');
      expect(Config.keys().some(key => /(apiKey|token|secret|password)$/i.test(key))).toBe(false);
    });

    it('returns a plain object of every key for serialisation', () => {
      const snapshot = Config.load({}).toJSON();

      expect(Object.keys(snapshot).sort()).toEqual(Config.keys().slice().sort());
    });
  });
});
