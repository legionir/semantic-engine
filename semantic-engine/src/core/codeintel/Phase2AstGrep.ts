/**
 * Phase 2 ast-grep engine (D-0016 / G-2.1).
 *
 * Real structural search over `@ast-grep/napi` behind the same
 * request/result contract as the legacy seam. Range semantics (verified
 * empirically against the pinned version, plan step 2.3):
 *
 * - `node.range().{start,end}.index` is a UTF-16 code-unit offset on
 *   `@ast-grep/napi@0.45.3`, despite the `.d.ts` comment claiming bytes.
 *   Verified with Persian/emoji (multi-byte, surrogate pairs) and CRLF:
 *   `text.slice(start.index, end.index) === node.text()`.
 * - `line`/`column` are NEVER trusted: line/column are derived from our own
 *   `LineIndex` (single Range authority), because ast-grep does not treat a
 *   lone `\r` as a line break while our contract does.
 * - Every emitted range is bounds-checked; a violation throws
 *   `AST_GREP_RANGE_ERROR` instead of emitting a corrupt offset.
 *
 * Capture semantics:
 *
 * - `$NAME` binds exactly one node: `getMatch(name)?.text() ?? ''`.
 * - `$$$NAME` binds a node list that may include anonymous nodes (commas,
 *   operators): the capture value is the source SPAN from the first node's
 *   start to the last node's end, or `''` when the list is empty.
 * - A repeated `$NAME` must match identical text (enforced natively).
 *
 * Honest failures (never silent): unsupported language, empty pattern,
 * invalid matcher (`INVALID_PATTERN`), unparseable patterns match nothing
 * (upstream napi behavior, covered by test), native binding unloadable
 * (`AST_GREP_UNAVAILABLE` via lazy load so other engines keep working).
 */

import * as crypto from 'crypto';
import type { SgNode } from '@ast-grep/napi';
import { LineIndex } from '../contracts/codeintel';
import type {
  StructuralLanguage,
  StructuralMatch,
  StructuralSearchResult,
} from './Phase2Structural';

/** Pinned engine version; `Phase2AstGrep.test.ts` fails on any drift. */
export const AST_GREP_VERSION = '0.45.3';

/** Languages with a bundled napi parser. Everything else fails closed. */
const LANGUAGE_MAP: Readonly<Record<string, string>> = {
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  tsx: 'Tsx',
  // Dynamic parser (optional package `@ast-grep/lang-python`, prebuilt binaries for linux/macOS/windows).
  python: 'python',
};

/** Languages that need `registerDynamicLanguage` before use, and the package that provides them. */
const DYNAMIC_LANGUAGE_PACKAGES: Readonly<Record<string, string>> = { python: '@ast-grep/lang-python' };
const registeredDynamic = new Set<string>();

function ensureLanguage(napi: NapiModule, napiLang: string, language: string): void {
  const packageName = DYNAMIC_LANGUAGE_PACKAGES[language];
  if (!packageName || registeredDynamic.has(language)) return;
  try {
    napi.registerDynamicLanguage({ [napiLang]: require(packageName) });
  } catch (error) {
    throw new Error(`AST_GREP_UNAVAILABLE: ${language} parser (${packageName}) could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
  }
  registeredDynamic.add(language);
}

type NapiModule = typeof import('@ast-grep/napi');

let cachedNapi: NapiModule | undefined;
let napiLoadFailure: string | undefined;

function loadNapi(): NapiModule {
  if (cachedNapi) return cachedNapi;
  if (napiLoadFailure) throw new Error(`AST_GREP_UNAVAILABLE: ${napiLoadFailure}`);
  try {
    // Lazy on purpose: a platform without prebuilt bindings must break only
    // the ast-grep engine, never the importing module graph.
    cachedNapi = require('@ast-grep/napi') as NapiModule;
    return cachedNapi;
  } catch (error) {
    napiLoadFailure = error instanceof Error ? error.message : String(error);
    throw new Error(`AST_GREP_UNAVAILABLE: ${napiLoadFailure}`);
  }
}

export interface AstGrepSearchRequest {
  readonly pattern: string;
  readonly language: StructuralLanguage;
  readonly path: string;
  readonly maxResults?: number;
  readonly ruleId?: string;
}

export function searchAstGrep(
  text: string,
  request: AstGrepSearchRequest,
): StructuralSearchResult {
  const maxResults = request.maxResults ?? 1000;
  if (!Number.isInteger(maxResults) || maxResults <= 0) {
    throw new Error('maxResults must be a positive integer');
  }
  const pattern = request.pattern.trim();
  if (!pattern) throw new Error('pattern is required');
  const napiLang = LANGUAGE_MAP[request.language];
  if (!napiLang) {
    throw new Error(
      `UNSUPPORTED_LANGUAGE: ${request.language} (ast-grep engine ${AST_GREP_VERSION} supports: typescript, javascript, tsx, python)`,
    );
  }
  const napi = loadNapi();
  ensureLanguage(napi, napiLang, request.language);
  let root;
  try {
    root = napi.parse(napiLang, text);
  } catch (error) {
    throw new Error(`AST_GREP_ERROR: ${error instanceof Error ? error.message : String(error)}`);
  }
  let nodes;
  try {
    nodes = root.root().findAll(pattern);
  } catch (error) {
    throw new Error(`INVALID_PATTERN: ${error instanceof Error ? error.message : String(error)}`);
  }
  const lineIndex = new LineIndex(text);
  const { single, multi } = parsePatternMetavariables(pattern);
  const matches: StructuralMatch[] = nodes.map(node => {
    const range = node.range();
    const start = range.start.index;
    const end = range.end.index;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > text.length) {
      throw new Error(`AST_GREP_RANGE_ERROR: engine returned offsets outside the source (${start}, ${end})`);
    }
    const span = text.slice(start, end);
    const position = lineIndex.positionAt(start);
    const captures: Record<string, string> = {};
    for (const name of single) captures[name] = singleCapture(node, name);
    for (const name of multi) captures[name] = multiCapture(node, name, text);
    const id = crypto
      .createHash('sha256')
      .update(`${request.path}:${start}:${end}:${span}`)
      .digest('hex')
      .slice(0, 16);
    return {
      id,
      path: request.path,
      language: request.language,
      start,
      end,
      line: position.line + 1,
      column: position.character,
      text: span,
      captures,
      ...(request.ruleId ? { ruleId: request.ruleId } : {}),
    };
  });
  matches.sort((a, b) => a.start - b.start || a.end - b.end || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { matches: matches.slice(0, maxResults), truncated: matches.length > maxResults };
}

function singleCapture(node: SgNode, name: string): string {
  try {
    return node.getMatch(name)?.text() ?? '';
  } catch (error) {
    throw new Error(`AST_GREP_ERROR: capture ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function multiCapture(node: SgNode, name: string, text: string): string {
  let parts: SgNode[];
  try {
    parts = node.getMultipleMatches(name);
  } catch (error) {
    throw new Error(`AST_GREP_ERROR: capture ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parts.length === 0) return '';
  const first = parts[0].range().start.index;
  const last = parts[parts.length - 1].range().end.index;
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || last < first || last > text.length) {
    throw new Error(`AST_GREP_RANGE_ERROR: capture ${name} has offsets outside the source`);
  }
  return text.slice(first, last);
}

/**
 * Metavariables in order of appearance, deduplicated. `$NAME` binds one node,
 * `$$$NAME` binds a node list. Shared contract detail: both engines agree on
 * which names a pattern declares.
 */
export function parsePatternMetavariables(pattern: string): { single: string[]; multi: string[] } {
  const single: string[] = [];
  const multi: string[] = [];
  const token = /\$\$\$[A-Za-z_][A-Za-z0-9_]*|\$[A-Za-z_][A-Za-z0-9_]*/gu;
  let match: RegExpExecArray | null;
  while ((match = token.exec(pattern))) {
    const raw = match[0];
    if (raw.startsWith('$$$')) {
      const name = raw.slice(3);
      if (!multi.includes(name)) multi.push(name);
    } else {
      const name = raw.slice(1);
      if (!single.includes(name)) single.push(name);
    }
  }
  return { single, multi };
}
