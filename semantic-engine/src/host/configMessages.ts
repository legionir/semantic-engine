/**
 * Error-message helpers of the host config (split from Config.ts, behavior unchanged).
 */

import type { ErrorObject } from 'ajv/dist/2020';
import type { ConfigSchema } from './configCore';
import { normalizeFlagKey, stripPrefix } from './configFlags';

// ── پیام‌های خطا ──────────────────────────────────────────────────────────

export function describeAjvError(
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

export function decodePointer(pointer: string): string {
  return pointer.replace(/^\//, '').replace(/~1/g, '/').replace(/~0/g, '~');
}

export function unknownKeyMessage(key: string, known: readonly string[]): string {
  const suggestion = closestKey(key, known);
  const hint = suggestion ? ` Did you mean ${suggestion}?` : '';
  return `Unknown configuration key: ${key}.${hint}`;
}

export function unknownFlagMessage(flag: string, known: readonly string[]): string {
  const body = flag.replace(/^--(no-)?/, '').split('=')[0];
  const suggestion = closestKey(normalizeFlagKey(body), known);
  const hint = suggestion ? ` Did you mean --${stripPrefix(suggestion)}?  (${suggestion})` : '';
  return `Unknown configuration flag: ${flag}.${hint}`;
}

export function closestKey(key: string, known: readonly string[]): string | null {
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

export function editDistance(a: string, b: string): number {
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
