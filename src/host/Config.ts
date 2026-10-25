/**
 * پیکربندی میزبان — جایگزین `vscode.workspace.getConfiguration`.
 *
 * چهار منبع با این ترتیب ادغام می‌شوند:
 *
 *     flag  >  env  >  file  >  default
 *
 * نام‌کلیدها عمداً همان `semanticEngine.*` مانده‌اند که در
 * `package.json → contributes.configuration` هست، و
 * `contracts/config.schema.json` آینهٔ همان‌هاست
 * (`configSchemaSync.test.ts` این آینه بودن را نگه می‌دارد). یعنی یک
 * تنظیم، چه در VS Code و چه در CLI، یک معنی دارد.
 *
 * اعتبارسنجی با ajv انجام می‌شود — همان وابستگی‌ای که تا امروز اعلام شده
 * بود ولی در `src/` استفاده نمی‌شد (SE-BUILD-08).
 */

import * as fs from 'fs';
import * as path from 'path';
import { coerce, parseFlags, stripPrefix } from './configFlags';
import { describeAjvError, unknownFlagMessage, unknownKeyMessage } from './configMessages';
import Ajv, { ValidateFunction } from 'ajv/dist/2020';

export type ConfigSource = 'flag' | 'env' | 'file' | 'default';

export interface ConfigValueInfo {
  readonly value: unknown;
  readonly source: ConfigSource;
}

export interface ConfigLoadOptions {
  /** معمولاً `process.argv.slice(2)`. پیش‌فرض خالی است تا تست‌ها قطعی بمانند. */
  readonly argv?: readonly string[];
  /** معمولاً `process.env`. پیش‌فرض خالی، به همان دلیل. */
  readonly env?: Record<string, string | undefined>;
  /**
   * محتوای فایل پیکربندی. اگر داده شود، جست‌وجوی روی دیسک انجام نمی‌شود.
   * هم شکل تخت (`{"semanticEngine.llm.model": …}`) و هم تودرتو
   * (`{"semanticEngine":{"llm":{"model":…}}}`) پذیرفته است.
   */
  readonly file?: unknown;
  /** ریشهٔ جست‌وجوی فایل پیکربندی. بدون آن، جست‌وجویی انجام نمی‌شود. */
  readonly cwd?: string;
  /** پرچمِ ناشناختهٔ شبیه‌کلید خطا بدهد یا فقط ثبت شود. پیش‌فرض: خطا. */
  readonly strictFlags?: boolean;
}

/** نام فایلی که هنگام بالا رفتن از درخت پوشه‌ها دنبالش می‌گردیم. */
export const CONFIG_FILE_NAME = 'semantic-engine.config.json';

export { ConfigError, KEY_PREFIX } from './configCore';
export type { ConfigSchema, SchemaProperty } from './configCore';
import { ConfigError, ConfigSchema, KEY_PREFIX } from './configCore';

const SCHEMA_PATH = path.join(__dirname, '..', '..', 'contracts', 'config.schema.json');

let cachedSchema: ConfigSchema | undefined;
let cachedValidator: ValidateFunction | undefined;

function loadSchema(): ConfigSchema {
  if (!cachedSchema) {
    cachedSchema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8')) as ConfigSchema;
  }
  return cachedSchema;
}

function validator(): ValidateFunction {
  if (!cachedValidator) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    cachedValidator = ajv.compile(loadSchema());
  }
  return cachedValidator;
}

/**
 * نام متغیر محیطی متناظر یک کلید.
 *
 * `semanticEngine.treeSitter.grammarDir` → `SEMANTIC_ENGINE_TREE_SITTER_GRAMMAR_DIR`
 */
export function envVarNameFor(key: string): string {
  return key
    .replace(/\./g, '_')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase();
}

/** بالا رفتن از درخت پوشه‌ها تا یافتن فایل پیکربندی. */
export function findConfigFile(startDir: string): string | null {
  let current = path.resolve(startDir);

  for (;;) {
    const candidate = path.join(current, CONFIG_FILE_NAME);
    if (fs.existsSync(candidate)) return candidate;

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export class Config {
  private readonly values: Map<string, ConfigValueInfo>;
  readonly configFilePath: string | null;
  readonly unknownFlags: readonly string[];

  private constructor(
    values: Map<string, ConfigValueInfo>,
    configFilePath: string | null,
    unknownFlags: readonly string[]
  ) {
    this.values = values;
    this.configFilePath = configFilePath;
    this.unknownFlags = unknownFlags;
  }

  /** همهٔ کلیدهای شناخته‌شده، با پیشوند کامل. */
  static keys(): string[] {
    return Object.keys(loadSchema().properties);
  }

  /** ادغام چهار لایه. در صورت مشکل، `ConfigError` پرتاب می‌شود. */
  static load(options: ConfigLoadOptions = {}): Config {
    const schema = loadSchema();
    const keys = Object.keys(schema.properties);
    const strictFlags = options.strictFlags ?? true;

    const parsedFlags = parseFlags(options.argv ?? [], schema);
    const issues: string[] = [];

    if (parsedFlags.unknown.length > 0 && strictFlags) {
      for (const flag of parsedFlags.unknown) {
        issues.push(unknownFlagMessage(flag, keys));
      }
      throw new ConfigError(issues);
    }

    const fileLayer = readFileLayer(options, parsedFlags.configPath, schema);

    const values = new Map<string, ConfigValueInfo>();
    const merged: Record<string, unknown> = {};
    const originOfKey = new Map<string, string>();

    for (const key of keys) {
      const property = schema.properties[key];
      let info: ConfigValueInfo;
      let origin = '';

      const flagValue = parsedFlags.values.get(key);
      const envName = envVarNameFor(key);
      const envValue = (options.env ?? {})[envName];
      const hasFile = Object.prototype.hasOwnProperty.call(fileLayer.values, key);

      if (flagValue !== undefined) {
        info = { value: coerce(flagValue, property), source: 'flag' };
        origin = `flag --${stripPrefix(key)}`;
      } else if (envValue !== undefined && envValue !== '') {
        info = { value: coerce(envValue, property), source: 'env' };
        origin = `env ${envName}`;
      } else if (hasFile) {
        info = { value: fileLayer.values[key], source: 'file' };
        origin = fileLayer.path ? `file ${fileLayer.path}` : 'config file';
      } else {
        info = { value: property.default, source: 'default' };
        origin = 'default';
      }

      values.set(key, info);
      merged[key] = info.value;
      originOfKey.set(key, origin);
    }

    const validate = validator();
    if (!validate(merged)) {
      for (const error of validate.errors ?? []) {
        issues.push(describeAjvError(error, merged, originOfKey, schema));
      }
      throw new ConfigError(issues);
    }

    return new Config(values, fileLayer.path, parsedFlags.unknown);
  }

  /** همان ترکیب معمول: argv و env و cwd از خود پروسه. */
  static fromProcess(overrides: ConfigLoadOptions = {}): Config {
    return Config.load({
      argv: process.argv.slice(2),
      env: process.env,
      cwd: process.cwd(),
      ...overrides,
    });
  }

  /**
   * خواندن یک کلید. کلید را با یا بدون پیشوند `semanticEngine.` می‌پذیرد.
   *
   * `fallback` فقط وقتی به کار می‌آید که مقدار مؤثر `null`/`undefined`
   * باشد — یعنی جای پیش‌فرضِ «کلید هست ولی خالی است»، نه جایگزین مقدار.
   */
  get<T>(key: string, fallback?: T): T {
    const full = this.resolveKey(key);
    const info = this.values.get(full);

    if (!info) {
      throw new ConfigError([unknownKeyMessage(full, Config.keys())]);
    }
    if ((info.value === null || info.value === undefined) && fallback !== undefined) {
      return fallback;
    }
    return info.value as T;
  }

  originOf(key: string): ConfigSource {
    const full = this.resolveKey(key);
    const info = this.values.get(full);
    if (!info) {
      throw new ConfigError([unknownKeyMessage(full, Config.keys())]);
    }
    return info.source;
  }

  has(key: string): boolean {
    return this.values.has(this.resolveKey(key));
  }

  /** نمای کامل «مقدار + منبع» برای گزارش و اشکال‌زدایی. */
  describe(): Record<string, ConfigValueInfo> {
    const out: Record<string, ConfigValueInfo> = {};
    for (const [key, info] of this.values) {
      out[key] = info;
    }
    return out;
  }

  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, info] of this.values) {
      out[key] = info.value;
    }
    return out;
  }

  private resolveKey(key: string): string {
    return key.startsWith(KEY_PREFIX) ? key : KEY_PREFIX + key;
  }
}

// ── لایهٔ فایل ────────────────────────────────────────────────────────────

interface FileLayer {
  readonly values: Record<string, unknown>;
  readonly path: string | null;
}

function readFileLayer(
  options: ConfigLoadOptions,
  explicitPath: string | null,
  schema: ConfigSchema
): FileLayer {
  if (options.file !== undefined) {
    return { values: flattenFileObject(options.file, schema, '(inline)'), path: null };
  }

  let filePath = explicitPath;
  if (filePath) {
    const resolved = options.cwd ? path.resolve(options.cwd, filePath) : path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      throw new ConfigError([`Configuration file not found: ${resolved}`]);
    }
    filePath = resolved;
  } else if (options.cwd) {
    filePath = findConfigFile(options.cwd);
  }

  if (!filePath) return { values: {}, path: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    /*
    | یک SyntaxError خالی («Unexpected end of JSON input») نمی‌گوید کدام
    | فایل. مسیر باید در پیام باشد.
    */
    throw new ConfigError([
      `Configuration file ${filePath} is not valid JSON: ${(error as Error).message}`,
    ]);
  }

  return { values: flattenFileObject(parsed, schema, filePath), path: filePath };
}

/**
 * تخت کردن فایل پیکربندی به کلیدهای کامل.
 *
 * سه شکل پذیرفته است چون هر سه در عمل نوشته می‌شوند:
 *   {"semanticEngine.llm.model": "x"}          ← شکل settings.json
 *   {"semanticEngine": {"llm": {"model": …}}}  ← شکل دستی تودرتو
 *   {"llm": {"model": …}}                      ← بدون پیشوند
 */
function flattenFileObject(
  raw: unknown,
  schema: ConfigSchema,
  origin: string
): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError([`Configuration in ${origin} must be a JSON object`]);
  }

  const known = new Set(Object.keys(schema.properties));
  const out: Record<string, unknown> = {};
  const unknown: string[] = [];

  const visit = (node: Record<string, unknown>, prefix: string): void => {
    for (const [rawKey, value] of Object.entries(node)) {
      const key = prefix ? `${prefix}.${rawKey}` : rawKey;
      const full = key.startsWith(KEY_PREFIX) ? key : KEY_PREFIX + key;

      if (known.has(full)) {
        out[full] = value;
        continue;
      }

      const isPlainObject =
        value !== null && typeof value === 'object' && !Array.isArray(value);
      if (isPlainObject) {
        visit(value as Record<string, unknown>, key);
        continue;
      }

      unknown.push(full);
    }
  };

  visit(raw as Record<string, unknown>, '');

  if (unknown.length > 0) {
    throw new ConfigError(
      unknown.map(key => `${unknownKeyMessage(key, [...known])} (in ${origin})`)
    );
  }

  return out;
}
