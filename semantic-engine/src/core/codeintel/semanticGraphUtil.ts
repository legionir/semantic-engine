import * as crypto from 'crypto';
import { compareCanonical, LineIndex } from '../contracts/codeintel';
import { SymbolEntry } from '../types/project-index.types';
import { ImportStatement, Scan, matchBrace, matchParen } from './semanticGraphText';
import { LocalBinding, OccurrenceClass, SymbolReference } from './semanticGraphTypes';

/** Pure helpers of the Phase 3 semantic graph pilot (split from Phase3SemanticGraph.ts, unchanged). */

export function splitTopLevel(slice: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of slice) {
    if (ch === '(' || ch === '{' || ch === '[' || ch === '<') { depth++; current += ch; continue; }
    if (ch === ')' || ch === '}' || ch === ']' || ch === '>') { depth = Math.max(0, depth - 1); current += ch; continue; }
    if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  parts.push(current);
  return parts;
}
export function emptyAuditCounts(): Record<OccurrenceClass, number> {
  return { reference: 0, 'hard-binding': 0, declaration: 0, 'import-declaration': 0, 'param-declarator': 0, comment: 0, string: 0, 'property-access': 0, 'property-key': 0, 'namespace-object-use': 0, unclassified: 0 };
}
export function inSpans(offset: number, spans: readonly { start: number; end: number }[]): boolean {
  return spans.some(s => offset >= s.start && offset < s.end);
}
export function innermostLocal(bindings: readonly LocalBinding[], name: string, offset: number): LocalBinding | undefined {
  let best: LocalBinding | undefined;
  for (const b of bindings) {
    if (b.name !== name) continue;
    if (offset < b.scopeStart || offset >= b.scopeEnd) continue;
    if (offset === b.declarator) return b;
    if (!best || b.scopeEnd - b.scopeStart < best.scopeEnd - best.scopeStart) best = b;
  }
  return best;
}
export function innermostBrace(scan: Scan, offset: number): { open: number; close: number } | undefined {
  let best: { open: number; close: number } | undefined;
  for (const pair of scan.braces) {
    if (pair.open < offset && offset < pair.close) {
      if (!best || pair.close - pair.open < best.close - best.open) best = pair;
    }
  }
  return best;
}
export function prevNonWs(text: string, offset: number): number {
  for (let i = offset - 1; i >= 0; i--) if (!/\s/u.test(text[i])) return i;
  return -1;
}
export function nextNonWs(text: string, offset: number): number {
  for (let i = offset; i < text.length; i++) if (!/\s/u.test(text[i])) return i;
  return -1;
}
export function endOfStatement(text: string, from: number): number {
  const semi = text.indexOf(';', from);
  const nl = text.indexOf('\n', from);
  const candidates = [semi >= 0 ? semi + 1 : undefined, nl >= 0 ? nl + 1 : undefined, text.length].filter((v): v is number => v !== undefined);
  return Math.min(...candidates);
}
export function stableId(value: string): string { return crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16); }
export function referenceOrder(a: SymbolReference, b: SymbolReference): number { return compareCanonical(`${a.sourcePath}:${a.start}:${a.id}`, `${b.sourcePath}:${b.start}:${b.id}`); }

export function collectLocalBindings(text: string, scan: Scan, symbols: readonly SymbolEntry[], imports: readonly ImportStatement[]): LocalBinding[] {
  const out: LocalBinding[] = [];
  const importSpans = imports.map(i => ({ start: i.start, end: i.end }));
  const declaratorLines = new Map<string, Set<number>>();
  for (const s of symbols) {
    const lines = declaratorLines.get(s.name) ?? new Set<number>();
    lines.add(s.line);
    declaratorLines.set(s.name, lines);
  }
  const fileEnd = text.length;
  const addParams = (paramsOpen: number, paramsClose: number, scopeStart: number, scopeEnd: number): void => {
    const slice = text.slice(paramsOpen + 1, paramsClose);
    const parts = splitTopLevel(slice);
    let offset = paramsOpen + 1;
    for (const part of parts) {
      const nameMatch = /^\s*(?:(?:public|private|protected|readonly)\s+)*([A-Za-z_$][\w$]*)/u.exec(part);
      if (nameMatch && !/^\s*\.\.\./u.test(part)) {
        const within = nameMatch[0].indexOf(nameMatch[1]);
        out.push({ name: nameMatch[1], declarator: offset + within, scopeStart, scopeEnd });
      }
      offset += part.length + 1;
    }
  };
  const arrowScope = (arrowEnd: number): number => {
    const after = nextNonWs(text, arrowEnd);
    if (after >= 0 && text[after] === '{') {
      const close = matchBrace(scan, after);
      if (close !== undefined) return close + 1;
    }
    return endOfStatement(text, arrowEnd);
  };
  // 1. Indexed function-like symbols: parameters scope over the whole symbol span.
  for (const symbol of symbols) {
    if (symbol.kind !== 'function' && symbol.kind !== 'method') continue;
    const declLineStart = scan.lineIndex.lineStart(symbol.line - 1);
    const nameAt = text.indexOf(symbol.name, declLineStart);
    if (nameAt < 0 || scan.lineIndex.positionAt(nameAt).line + 1 !== symbol.line) continue;
    const open = text.indexOf('(', nameAt + symbol.name.length);
    if (open < 0) continue;
    const close = matchParen(text, open);
    if (close === undefined) continue;
    addParams(open, close, scan.lineIndex.lineStart(symbol.line - 1), Math.min(fileEnd, scan.lineIndex.contentEnd(symbol.endLine - 1) + 1));
  }
  // 2. Nested function declarations (indexed or not): params scope over the body braces.
  const fnRe = /\bfunction\b\s*[A-Za-z_$][\w$]*\s*\(/gu;
  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(text))) {
    if (scan.mask[m.index] !== 0 || inSpans(m.index, importSpans)) continue;
    const open = m.index + m[0].length - 1;
    const close = matchParen(text, open);
    if (close === undefined) continue;
    const after = nextNonWs(text, close + 1);
    const scopeEnd = after >= 0 && text[after] === '{' && matchBrace(scan, after) !== undefined ? (matchBrace(scan, after) as number) + 1 : endOfStatement(text, close + 1);
    addParams(open, close, open, scopeEnd);
  }
  // 3. Arrow functions: parenthesized param lists and single-identifier params.
  const arrowParenRe = /\(([^(){}]*)\)\s*=>/gu;
  while ((m = arrowParenRe.exec(text))) {
    if (scan.mask[m.index] !== 0 || inSpans(m.index, importSpans)) continue;
    const open = m.index;
    const close = m.index + m[0].indexOf(')');
    addParams(open, close, open, arrowScope(m.index + m[0].length));
  }
  const arrowSingleRe = /\b([A-Za-z_$][\w$]*)\s*=>/gu;
  while ((m = arrowSingleRe.exec(text))) {
    if (scan.mask[m.index] !== 0 || inSpans(m.index, importSpans)) continue;
    const declarator = m.index + m[0].indexOf(m[1]);
    out.push({ name: m[1], declarator, scopeStart: m.index, scopeEnd: arrowScope(m.index + m[0].length) });
  }
  // 4. const/let/var shadowing declarators: scope approximated by the innermost enclosing block.
  const declRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gu;
  while ((m = declRe.exec(text))) {
    if (scan.mask[m.index] !== 0 || inSpans(m.index, importSpans)) continue;
    const name = m[1];
    const line = scan.lineIndex.positionAt(m.index).line + 1;
    if (declaratorLines.get(name)?.has(line)) continue; // module declarator of an indexed symbol
    const pair = innermostBrace(scan, m.index);
    const declarator = m.index + m[0].indexOf(name);
    out.push({ name, declarator, scopeStart: m.index, scopeEnd: pair ? pair.close + 1 : endOfStatement(text, m.index) });
  }
  return out;
}

export function scanText(text: string): Scan {
  const lineIndex = new LineIndex(text);
  const mask = new Uint8Array(text.length);
  const braces: { open: number; close: number }[] = [];
  const stack: number[] = [];
  let valid = true;
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;
  let comment: 1 | 2 | null = null;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (comment === 1) { if (char === '\n') { comment = null; } else { mask[i] = 1; } continue; }
    if (comment === 2) {
      mask[i] = 2;
      if (char === '*' && text[i + 1] === '/') { mask[i + 1] = 2; i++; comment = null; }
      continue;
    }
    if (quote) {
      mask[i] = 3;
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && text[i + 1] === '/') { comment = 1; mask[i] = 1; continue; }
    if (char === '/' && text[i + 1] === '*') { comment = 2; mask[i] = 2; continue; }
    if (char === '"' || char === "'" || char === '`') { quote = char; mask[i] = 3; continue; }
    if (char === '{') { stack.push(i); continue; }
    if (char === '}') { const open = stack.pop(); if (open === undefined) { valid = false; } else { braces.push({ open, close: i }); } continue; }
  }
  if (quote || comment === 2 || stack.length) valid = false;
  const scan: Scan = { mask, valid, braces: braces.sort((a, b) => a.open - b.open), lineIndex };
  return scan;
}
