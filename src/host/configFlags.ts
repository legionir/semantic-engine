/**
 * Flag layer and value coercion of the host config (split from Config.ts, behavior unchanged).
 */

import { ConfigError, KEY_PREFIX } from './configCore';
import type { ConfigSchema, SchemaProperty } from './configCore';

// ── لایهٔ پرچم ────────────────────────────────────────────────────────────

export interface ParsedFlags {
  readonly values: Map<string, string>;
  readonly unknown: string[];
  readonly configPath: string | null;
}

export function parseFlags(argv: readonly string[], schema: ConfigSchema): ParsedFlags {
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
export function normalizeFlagKey(body: string): string {
  const camel = body
    .split('.')
    .map(segment => segment.replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase()))
    .join('.');
  return camel.startsWith(KEY_PREFIX) ? camel : KEY_PREFIX + camel;
}

export function stripPrefix(key: string): string {
  return key.startsWith(KEY_PREFIX) ? key.slice(KEY_PREFIX.length) : key;
}

// ── تبدیل نوع ─────────────────────────────────────────────────────────────

const TRUE_WORDS = ['true', '1', 'yes', 'on'];
const FALSE_WORDS = ['false', '0', 'no', 'off'];

export function isBooleanWord(value: string): boolean {
  const lower = value.toLowerCase();
  return TRUE_WORDS.includes(lower) || FALSE_WORDS.includes(lower);
}

export function typesOf(property: SchemaProperty): string[] {
  if (property.type === undefined) return [];
  return Array.isArray(property.type) ? property.type : [property.type];
}

export function isBooleanKey(property: SchemaProperty): boolean {
  return typesOf(property).includes('boolean');
}

/**
 * env و پرچم همیشه رشته‌اند. تبدیل باید *محافظه‌کار* باشد: اگر رشته به
 * نوع مورد انتظار نمی‌خورد، همان رشته می‌ماند تا ajv خطای خوانا بدهد.
 * تبدیل زورکی، یک اشتباه تایپی را به یک مقدار بی‌معنی تبدیل می‌کند
 * (`Number('many')` → NaN که در JSON به null می‌افتد).
 */
export function coerce(raw: string, property: SchemaProperty): unknown {
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
