import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { searchAstGrep } from './Phase2AstGrep';

export type StructuralLanguage = 'typescript' | 'javascript' | 'tsx' | 'python' | 'php' | 'unknown';
export type RuleSeverity = 'info' | 'warning' | 'error';
/**
 * Search engine selector (D-0016 / G-2.1). `ast-grep` is the default and only
 * accepted engine; `legacy-seam` is an explicitly experimental fallback that
 * must not be described as ast-grep-compatible (line patterns, no parser).
 */
export type SearchEngine = 'ast-grep' | 'legacy-seam';

export interface StructuralMatch {
  readonly id: string;
  readonly path: string;
  readonly language: StructuralLanguage;
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
  readonly text: string;
  readonly captures: Readonly<Record<string, string>>;
  readonly ruleId?: string;
}

export interface StructuralSearchRequest {
  readonly pattern: string;
  readonly language: StructuralLanguage;
  readonly paths: readonly string[];
  readonly maxResults?: number;
  readonly ruleId?: string;
  /** Defaults to `ast-grep`. `legacy-seam` is explicitly experimental. */
  readonly engine?: SearchEngine;
}

export interface StructuralRule {
  readonly id: string;
  readonly language: StructuralLanguage;
  readonly pattern: string;
  readonly message: string;
  readonly severity: RuleSeverity;
}

export interface RulePack {
  readonly version: 1;
  readonly rules: readonly StructuralRule[];
}

export interface StructuralSearchResult {
  readonly matches: readonly StructuralMatch[];
  readonly truncated: boolean;
}

const EXTENSIONS: Record<string, StructuralLanguage> = {
  '.ts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.jsx': 'javascript',
  '.mjs': 'javascript', '.cjs': 'javascript', '.py': 'python', '.php': 'php',
};

export function languageForPath(filePath: string): StructuralLanguage {
  return EXTENSIONS[path.extname(filePath).toLowerCase()] ?? 'unknown';
}

/**
 * Structural search entry point. Defaults to the real ast-grep engine
 * (`Phase2AstGrep`); pass `engine: 'legacy-seam'` only for the explicitly
 * experimental dependency-free fallback. Tools and MCP never select the
 * fallback: it is a library-level opt-in, not a silent degradation.
 */
export function searchTextStructurally(text: string, request: Omit<StructuralSearchRequest, 'paths'> & { path: string }): StructuralSearchResult {
  if ((request.engine ?? 'ast-grep') === 'legacy-seam') return searchLegacySeam(text, request);
  return searchAstGrep(text, request);
}

/**
 * EXPERIMENTAL fallback: deterministic, dependency-free line-pattern matcher.
 * It accepts line-oriented patterns and named metavariables ($NAME/$$$ARGS)
 * WITHOUT a parser: no nested syntax, no multiline, no AST fidelity. It must
 * not be described as ast-grep-compatible (D-0016). Kept only so hosts that
 * explicitly opt in keep a working seam where ast-grep has no parser.
 */
export function searchLegacySeam(text: string, request: Omit<StructuralSearchRequest, 'paths'> & { path: string }): StructuralSearchResult {
  const maxResults = request.maxResults ?? 1000;
  if (!Number.isInteger(maxResults) || maxResults <= 0) throw new Error('maxResults must be a positive integer');
  const pattern = request.pattern.trim();
  if (!pattern) throw new Error('pattern is required');
  const lines = text.split(/\r\n|\r|\n/u);
  const matches: StructuralMatch[] = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const candidate = line.trim();
    const matched = matchLine(candidate, pattern);
    if (matched && matches.length < maxResults) {
      const candidateOffset = Math.max(0, line.indexOf(candidate));
      const start = offset + candidateOffset + matched.start;
      const end = start + matched.length;
      const span = candidate.slice(matched.start, matched.start + matched.length);
      const id = crypto.createHash('sha256').update(`${request.path}:${start}:${end}:${span}`).digest('hex').slice(0, 16);
      matches.push({ id, path: request.path, language: request.language, start, end, line: i + 1, column: candidateOffset + matched.start, text: span, captures: matched.captures, ...(request.ruleId ? { ruleId: request.ruleId } : {}) });
    }
    offset += line.length + (text.slice(offset + line.length, offset + line.length + 2) === '\r\n' ? 2 : text[offset + line.length] ? 1 : 0);
  }
  return { matches, truncated: matches.length >= maxResults && lines.some((line, i) => i >= matches.length && matchLine(line.trim(), pattern) !== null) };
}

function matchLine(candidate: string, pattern: string): { readonly captures: Readonly<Record<string, string>>; readonly start: number; readonly length: number } | null {
  const captures: Record<string, string> = {};
  const captureNames: string[] = [];
  let regex = '';
  let cursor = 0;
  const token = /\$\$\$[A-Za-z_][A-Za-z0-9_]*|\$[A-Za-z_][A-Za-z0-9_]*/gu;
  let match: RegExpExecArray | null;
  while ((match = token.exec(pattern))) {
    regex += escapeRegex(pattern.slice(cursor, match.index));
    const name = match[0].slice(match[0].startsWith('$$$') ? 3 : 1);
    captureNames.push(name);
    // Numbered groups avoid duplicate named-group syntax when a metavariable
    // appears more than once in a pattern. Repeated names are checked below.
    regex += match[0].startsWith('$$$') ? '(.*?)' : '([^,(){};]+?)';
    cursor = match.index + match[0].length;
  }
  regex += escapeRegex(pattern.slice(cursor));
  const found = new RegExp(regex, 'u').exec(candidate);
  if (!found || found[0].length === 0) return null;
  captureNames.forEach((name, index) => {
    const value = (found[index + 1] ?? '').trim();
    if (captures[name] !== undefined && captures[name] !== value) throw new Error(`metavariable ${name} matched inconsistent values`);
    captures[name] = value;
  });
  return { captures, start: found.index, length: found[0].length };
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'); }

export function parseRulePack(input: string): RulePack {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('rule pack is empty');
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { parsed = parseMinimalYaml(trimmed); }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { rules?: unknown }).rules)) throw new Error('rule pack must contain rules[]');
  const rules = (parsed as { rules: unknown[] }).rules.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new Error(`rule ${index} must be an object`);
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.pattern !== 'string' || typeof r.language !== 'string' || typeof r.message !== 'string') throw new Error(`rule ${index} requires id, language, pattern, message`);
    const severity = r.severity === undefined ? 'warning' : r.severity;
    if (!['info', 'warning', 'error'].includes(String(severity))) throw new Error(`rule ${index} has invalid severity`);
    return { id: r.id, language: r.language as StructuralLanguage, pattern: r.pattern, message: r.message, severity: severity as RuleSeverity };
  });
  const ids = new Set<string>(); for (const rule of rules) { if (ids.has(rule.id)) throw new Error(`duplicate rule id: ${rule.id}`); ids.add(rule.id); }
  return { version: 1, rules };
}

function parseMinimalYaml(text: string): unknown {
  const rules: Record<string, string>[] = [];
  let current: Record<string, string> | undefined;
  for (const raw of text.split(/\r\n|\r|\n/u)) {
    const line = raw.trim(); if (!line || line.startsWith('#') || line === 'rules:') continue;
    if (line.startsWith('- ')) { current = {}; rules.push(current); parseYamlPair(line.slice(2), current); }
    else if (current) parseYamlPair(line, current);
    else throw new Error('unsupported rule pack YAML');
  }
  return { rules };
}
function parseYamlPair(line: string, target: Record<string, string>): void {
  const colon = line.indexOf(':'); if (colon <= 0) throw new Error(`invalid YAML rule field: ${line}`);
  let value = line.slice(colon + 1).trim(); if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  target[line.slice(0, colon).trim()] = value;
}

export async function dumpSyntaxTree(text: string, language: StructuralLanguage): Promise<Record<string, unknown>> {
  return { type: 'document', language, children: text.split(/\r\n|\r|\n/u).map((value, index) => ({ type: 'line', index, text: value })) };
}

export async function readRulePack(filePath: string): Promise<RulePack> { return parseRulePack(await fs.readFile(filePath, 'utf8')); }
