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
import Ajv, { ErrorObject, ValidateFunction } from 'ajv/dist/2020';

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

const KEY_PREFIX = 'semanticEngine.';

interface SchemaProperty {
  type?: string | string[];
  default?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  description?: string;
}

interface ConfigSchema {
  properties: Record<string, SchemaProperty>;
}

/**
 * خطای پیکربندی با فهرست کامل مشکلات.
 *
 * چند مشکل هم‌زمان جمع می‌شوند: کسی که سه مقدار را اشتباه گذاشته نباید
 * سه بار اجرا کند تا سه پیام ببیند.
 */
export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(issues.length === 1 ? issues[0] : `Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

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

// ── لایهٔ پرچم ────────────────────────────────────────────────────────────

interface ParsedFlags {
  readonly values: Map<string, string>;
  readonly unknown: string[];
  readonly configPath: string | null;
}

function parseFlags(argv: readonly string[], schema: ConfigSchema): ParsedFlags {
  const known = new Set(Object.keys(schema.properties));
  const values = new Map<string, string>();
  const unknown: string[] = [];
  let configPath: string | null = null;

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;

    let body = token.slice(2);
    let inlineValue: string | undefined;

    const equals = body.indexOf('=');
    if (equals !== -1) {
      inlineValue = body.slice(equals + 1);
      body = body.slice(0, equals);
    }

    if (body === 'config') {
      configPath = inlineValue ?? argv[++index] ?? null;
      continue;
    }

    let negated = false;
    if (body.startsWith('no-')) {
      negated = true;
      body = body.slice(3);
    }

    /*
    | فقط پرچم‌هایی که *شبیه* کلید پیکربندی‌اند (نقطه دارند) بررسی
    | می‌شوند. `--out dist` مال CLI است و به ما ربطی ندارد.
    */
    if (!body.includes('.')) continue;

    const key = normalizeFlagKey(body);
    if (!known.has(key)) {
      unknown.push(token);
      continue;
    }

    const property = schema.properties[key];
    if (negated) {
      values.set(key, 'false');
      continue;
    }

    if (inlineValue !== undefined) {
      values.set(key, inlineValue);
      continue;
    }

    const next = argv[index + 1];
    if (isBooleanKey(property)) {
      /*
      | یک کلید بولی بدون مقدار یعنی true. توکن بعدی فقط وقتی مصرف
      | می‌شود که خودش یک کلمهٔ بولی باشد، وگرنه `--llm.enabled index`
      | آرگومان دستور را می‌بلعد.
      */
      if (next !== undefined && isBooleanWord(next)) {
        values.set(key, next);
        index++;
      } else {
        values.set(key, 'true');
      }
      continue;
    }

    if (next === undefined || next.startsWith('--')) {
      throw new ConfigError([`Flag ${token} needs a value`]);
    }
    values.set(key, next);
    index++;
  }

  return { values, unknown, configPath };
}

/** `tree-sitter.grammar-dir` → `semanticEngine.treeSitter.grammarDir` */
function normalizeFlagKey(body: string): string {
  const camel = body
    .split('.')
    .map(segment => segment.replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase()))
    .join('.');
  return camel.startsWith(KEY_PREFIX) ? camel : KEY_PREFIX + camel;
}

function stripPrefix(key: string): string {
  return key.startsWith(KEY_PREFIX) ? key.slice(KEY_PREFIX.length) : key;
}

// ── تبدیل نوع ─────────────────────────────────────────────────────────────

const TRUE_WORDS = ['true', '1', 'yes', 'on'];
const FALSE_WORDS = ['false', '0', 'no', 'off'];

function isBooleanWord(value: string): boolean {
  const lower = value.toLowerCase();
  return TRUE_WORDS.includes(lower) || FALSE_WORDS.includes(lower);
}

function typesOf(property: SchemaProperty): string[] {
  if (property.type === undefined) return [];
  return Array.isArray(property.type) ? property.type : [property.type];
}

function isBooleanKey(property: SchemaProperty): boolean {
  return typesOf(property).includes('boolean');
}

/**
 * env و پرچم همیشه رشته‌اند. تبدیل باید *محافظه‌کار* باشد: اگر رشته به
 * نوع مورد انتظار نمی‌خورد، همان رشته می‌ماند تا ajv خطای خوانا بدهد.
 * تبدیل زورکی، یک اشتباه تایپی را به یک مقدار بی‌معنی تبدیل می‌کند
 * (`Number('many')` → NaN که در JSON به null می‌افتد).
 */
function coerce(raw: string, property: SchemaProperty): unknown {
  const types = typesOf(property);

  if (types.includes('null') && raw.toLowerCase() === 'null') return null;

  if (types.includes('boolean')) {
    const lower = raw.toLowerCase();
    if (TRUE_WORDS.includes(lower)) return true;
    if (FALSE_WORDS.includes(lower)) return false;
    return raw;
  }

  if (types.includes('number') || types.includes('integer')) {
    if (raw.trim() === '') return raw;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : raw;
  }

  return raw;
}

// ── پیام‌های خطا ──────────────────────────────────────────────────────────

function describeAjvError(
  error: ErrorObject,
  merged: Record<string, unknown>,
  origins: Map<string, string>,
  schema: ConfigSchema
): string {
  if (error.keyword === 'additionalProperties') {
    const key = String((error.params as { additionalProperty: string }).additionalProperty);
    return unknownKeyMessage(key, Object.keys(schema.properties));
  }

  const key = decodePointer(error.instancePath);
  const value = merged[key];
  const origin = origins.get(key) ?? 'unknown source';

  let message = error.message ?? 'is invalid';
  if (error.keyword === 'enum') {
    const allowed = (error.params as { allowedValues?: unknown[] }).allowedValues ?? [];
    message = `must be one of: ${allowed.join(', ')}`;
  }

  return `${key}: ${message} (got ${JSON.stringify(value)}, from ${origin})`;
}

function decodePointer(pointer: string): string {
  return pointer.replace(/^\//, '').replace(/~1/g, '/').replace(/~0/g, '~');
}

function unknownKeyMessage(key: string, known: readonly string[]): string {
  const suggestion = closestKey(key, known);
  const hint = suggestion ? ` Did you mean ${suggestion}?` : '';
  return `Unknown configuration key: ${key}.${hint}`;
}

function unknownFlagMessage(flag: string, known: readonly string[]): string {
  const body = flag.replace(/^--(no-)?/, '').split('=')[0];
  const suggestion = closestKey(normalizeFlagKey(body), known);
  const hint = suggestion ? ` Did you mean --${stripPrefix(suggestion)}?  (${suggestion})` : '';
  return `Unknown configuration flag: ${flag}.${hint}`;
}

function closestKey(key: string, known: readonly string[]): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;

  for (const candidate of known) {
    const distance = editDistance(key.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }

  /*
  | آستانه لازم است وگرنه برای هر رشتهٔ بی‌ربطی یک «شاید منظورت … بود»
  | چاپ می‌شود که فقط گمراه‌کننده است.
  */
  return bestDistance <= Math.max(3, Math.floor(key.length / 4)) ? best : null;
}

function editDistance(a: string, b: string): number {
  const previous: number[] = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current: number[] = new Array(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, substitution);
    }
    for (let j = 0; j <= b.length; j++) previous[j] = current[j];
  }

  return previous[b.length];
}
