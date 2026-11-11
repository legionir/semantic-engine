/**
 * Text rendering of a tool result for a model.
 *
 * A model reads `content` as prose. Compact JSON makes it parse quoting and
 * nesting to find a path and a line number, so results are laid out one item
 * per line (`name [kind] path:line`), with the excerpt and the item's metadata
 * indented below, and the notes that change how the result must be read
 * (truncation, warnings, degraded search) stated in words.
 */

import { AiToolOutput, AiToolResultItem } from '../tools/types';

/** Longest metadata value printed in full; longer ones are cut and marked. */
const MAX_VALUE_CHARS = 1500;

/** Result-level metadata that is stated in words, so it is not repeated as a key. */
const SPOKEN_KEYS: ReadonlySet<string> = new Set([
  'truncated', 'matchCount', 'limit', 'note', 'warning', 'warnings', 'degradedReason', 'startLine', 'endLine',
]);

function clip(value: string): string {
  return value.length > MAX_VALUE_CHARS ? `${value.slice(0, MAX_VALUE_CHARS)}… (${value.length - MAX_VALUE_CHARS} more chars)` : value;
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return clip(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every(entry => typeof entry === 'string' || typeof entry === 'number')) {
    return clip(value.join(', '));
  }
  return clip(JSON.stringify(value));
}

function metadataLines(metadata: Record<string, unknown> | undefined, indent: string, skip?: ReadonlySet<string>): string[] {
  if (!metadata) return [];
  const lines: string[] = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (skip?.has(key) || value === undefined || value === null || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    lines.push(`${indent}${key}: ${formatValue(value)}`);
  }
  return lines;
}

function numbered(source: string, firstLine: number): string {
  const lines = source.endsWith('\n') ? source.slice(0, -1).split('\n') : source.split('\n');
  const width = String(firstLine + lines.length - 1).length;
  return lines.map((line, index) => `${String(firstLine + index).padStart(width)}  ${line}`).join('\n');
}

function itemLines(item: AiToolResultItem, index: number): string[] {
  const where = item.path ? ` ${item.path}${item.line !== undefined ? `:${item.line}` : ''}` : '';
  const score = item.relevanceScore !== undefined ? ` (score ${item.relevanceScore.toFixed(2)})` : '';
  const excerpt = item.excerpt ?? '';
  const inline = excerpt !== '' && !excerpt.includes('\n') && excerpt.length <= 160;
  const lines = [`${index + 1}. ${item.name} [${item.kind}]${where}${score}${inline ? ` — ${excerpt}` : ''}`];
  if (excerpt !== '' && !inline) lines.push(...excerpt.replace(/\n$/, '').split('\n').map(line => `   ${line}`));
  if (item.id && item.id !== item.name && item.id !== item.path) lines.push(`   id: ${item.id}`);
  lines.push(...metadataLines(item.metadata, '   '));
  return lines;
}

function countLine(result: AiToolOutput): string {
  const metadata = result.metadata ?? {};
  const shown = result.items.length;
  const total = typeof metadata['matchCount'] === 'number' ? metadata['matchCount'] : undefined;
  const of = total !== undefined && total > shown ? ` of ${total}` : '';
  const more = metadata['truncated'] === true ? ' — more exist: raise `limit` or narrow the query' : '';
  if (shown === 0) return 'No results in the index (this is not proof that nothing exists).';
  return `${shown}${of} result${shown === 1 ? '' : 's'}${more}`;
}

export function renderToolResult(result: AiToolOutput, ids: Record<string, unknown> = {}): string {
  const metadata = result.metadata ?? {};
  const out: string[] = [];

  if (!result.success) out.push(`ERROR: ${result.error ?? 'the tool failed'}`);
  if (result.context) out.push(result.context.trimEnd());

  const source = result.items.length === 1 ? result.items[0]! : undefined;
  if (source?.excerpt && typeof metadata['startLine'] === 'number') {
    /* a source read: the text itself is the answer, shown with real line numbers */
    out.push(`${source.path ?? source.name}`, numbered(source.excerpt, metadata['startLine']));
  } else if (result.success || result.items.length > 0) {
    if (!(result.context && result.items.length === 0)) out.push(countLine(result));
    result.items.forEach((item, index) => out.push(...itemLines(item, index)));
  }

  for (const key of ['note', 'warning', 'degradedReason'] as const) {
    if (typeof metadata[key] === 'string') out.push(`${key}: ${metadata[key]}`);
  }
  if (Array.isArray(metadata['warnings'])) {
    for (const warning of metadata['warnings']) out.push(`warning: ${String(warning)}`);
  }

  const rest = metadataLines(metadata, '  ', SPOKEN_KEYS);
  if (rest.length > 0) out.push('details:', ...rest);
  if (ids['indexGeneration'] !== undefined) out.push(`index generation: ${String(ids['indexGeneration'])}`);
  return out.join('\n');
}
