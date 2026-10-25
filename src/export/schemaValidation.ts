/**
 * Schema validation and atomic JSON persistence shared by all exporters.
 *
 * The validator intentionally uses only repository-owned contract files.  In
 * particular, it does not invent a structural fallback for blueprint.json:
 * if contracts/blueprint.schema.json is absent, validation is explicitly
 * unavailable and the caller must report that verification blocker.
 */

import * as fs from 'fs';
import * as path from 'path';

export type SchemaName = 'project-index' | 'blueprint';

const SCHEMA_FILES: Readonly<Record<SchemaName, string>> = {
  'project-index': 'project-index.schema.json',
  blueprint: 'blueprint.schema.json',
};

type ValidateFunction = ((data: unknown) => boolean) & {
  errors?: readonly { instancePath?: string; message?: string; params?: unknown }[] | null;
};

const compiled = new Map<SchemaName, ValidateFunction>();

/**
 * `__dirname` is `dist/export` in a build and `src/export` in tests; both are
 * two levels below the package root.
 */
export function contractsDir(): string {
  return path.join(__dirname, '..', '..', 'contracts');
}

export function schemaPath(schema: SchemaName): string {
  return path.join(contractsDir(), SCHEMA_FILES[schema]);
}

export function hasSchema(schema: SchemaName): boolean {
  return fs.existsSync(schemaPath(schema));
}

export class SchemaUnavailableError extends Error {
  readonly schema: SchemaName;
  readonly filePath: string;

  constructor(schema: SchemaName, filePath = schemaPath(schema)) {
    super(`Schema '${schema}' is unavailable: expected contract at ${filePath}`);
    this.name = 'SchemaUnavailableError';
    this.schema = schema;
    this.filePath = filePath;
  }
}

function compile(schema: SchemaName): ValidateFunction {
  const cached = compiled.get(schema);
  if (cached) return cached;

  const file = schemaPath(schema);
  if (!fs.existsSync(file)) throw new SchemaUnavailableError(schema, file);

  // Lazy loading keeps ajv out of non-validation export paths.
  const Ajv = require('ajv/dist/2020');
  const addFormats = require('ajv-formats');
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validator = ajv.compile(JSON.parse(fs.readFileSync(file, 'utf8'))) as ValidateFunction;
  compiled.set(schema, validator);
  return validator;
}

/** Empty means valid; a missing contract throws SchemaUnavailableError. */
export function validateAgainstSchema(schema: SchemaName, data: unknown): string[] {
  const validator = compile(schema);
  if (validator(data)) return [];

  return (validator.errors ?? []).map(error => {
    const where = error.instancePath && error.instancePath.length > 0 ? error.instancePath : '/';
    const params = (error.params ?? {}) as Record<string, unknown>;
    const extra =
      typeof params['additionalProperty'] === 'string'
        ? ` ("${params['additionalProperty']}")`
        : typeof params['allowedValues'] !== 'undefined'
          ? ` (allowed: ${JSON.stringify(params['allowedValues'])})`
          : '';
    return `${where}: ${error.message ?? 'invalid'}${extra}`;
  });
}

export interface AtomicJsonWriteOptions {
  readonly outputPath: string;
  readonly value: unknown;
  readonly schema?: SchemaName;
  /** Defaults to true when a schema is supplied. */
  readonly validate?: boolean;
  readonly pretty?: boolean;
}

/**
 * Validate and serialize before creating a temp file, then replace atomically.
 * The temp file is in the destination directory, so rename is atomic on the
 * same filesystem and a failed write leaves the previous destination intact.
 */
export async function writeJsonAtomic(options: AtomicJsonWriteOptions): Promise<void> {
  if (options.schema && options.validate !== false) {
    const errors = validateAgainstSchema(options.schema, options.value);
    if (errors.length > 0) {
      throw new Error(
        `${options.schema} does not match its schema (${errors.length} violation(s)):\n  ` +
        errors.slice(0, 10).join('\n  ')
      );
    }
  }

  const json = JSON.stringify(options.value, null, options.pretty !== false ? 2 : undefined);
  const parent = path.dirname(options.outputPath);
  await fs.promises.mkdir(parent, { recursive: true });
  const temporary = path.join(
    parent,
    `.${path.basename(options.outputPath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );

  try {
    await fs.promises.writeFile(temporary, json, 'utf8');
    await fs.promises.rename(temporary, options.outputPath);
  } catch (error) {
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
