/**
 * Text-level helpers of the Phase 3 semantic graph: import/export statement
 * parsing, bracket matching and identifier occurrence search. All pure; the
 * pilot only supplies the file text and its lexical `Scan`.
 */

import { LineIndex } from '../contracts/codeintel';

export interface ImportSpecifierBinding { readonly imported: string; readonly local: string; }
export interface ImportStatement {
  readonly kind: 'named' | 'default' | 'namespace' | 'side-effect';
  readonly specifiers: readonly ImportSpecifierBinding[];
  readonly defaultLocal?: string;
  readonly namespaceLocal?: string;
  readonly specifier: string;
  readonly start: number;
  readonly end: number;
}
export interface Scan {
  readonly mask: Uint8Array;          // 0 code, 1 line comment, 2 block comment, 3 string/template
  readonly valid: boolean;            // quotes/comments closed and braces balanced
  readonly braces: readonly { readonly open: number; readonly close: number }[];
  readonly lineIndex: LineIndex;
}

function escape(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'); }

export function parseNamedList(raw: string): ImportSpecifierBinding[] {
  return raw.split(',')
    .map(part => part.trim())
    .filter(part => part.length > 0)
    .map(part => {
      const pieces = part.split(/\s+as\s+/u);
      const imported = pieces[0].replace(/^type\s+/u, '').trim();
      return { imported, local: pieces[1]?.trim() ?? imported };
    })
    .filter(spec => /^[A-Za-z_$][\w$]*$/u.test(spec.imported) && /^[A-Za-z_$][\w$]*$/u.test(spec.local));
}

export function occurrences(text: string, name: string): { start: number; end: number }[] {
  if (!name) return [];
  const re = new RegExp(`\\b${escape(name)}\\b`, 'gu');
  const out: { start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ start: m.index, end: m.index + name.length });
  return out;
}
export function withPosition(scan: Scan, occurrence: { start: number; end: number }): { start: number; end: number; line: number; column: number } {
  const p = scan.lineIndex.positionAt(occurrence.start);
  return { ...occurrence, line: p.line + 1, column: p.character };
}
/** The identifier immediately after `offset.` (namespace member), if any. */
export function memberAfter(text: string, offset: number): string | undefined {
  let i = offset;
  while (i < text.length && /\s/u.test(text[i])) i++;
  if (text[i] !== '.') return undefined;
  i++;
  while (i < text.length && /\s/u.test(text[i])) i++;
  const m = /^[A-Za-z_$][\w$]*/u.exec(text.slice(i));
  return m ? m[0] : undefined;
}
export function matchParen(text: string, open: number): number | undefined {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const char = text[i];
    if (char === '(') depth++;
    else if (char === ')') { depth--; if (depth === 0) return i; }
  }
  return undefined;
}
export function matchBrace(scan: Scan, open: number): number | undefined {
  const pair = scan.braces.find(b => b.open === open);
  return pair ? pair.close : undefined;
}
export function parseImports(text: string): ImportStatement[] {
  const out: ImportStatement[] = [];
  let m: RegExpExecArray | null;
  const sideEffectRe = /\bimport\s*['"]([^'"]+)['"]/gu;
  while ((m = sideEffectRe.exec(text))) {
    const head = text.slice(m.index, m.index + m[0].length);
    if (!/\bfrom\b/.test(head)) out.push({ kind: 'side-effect', specifiers: [], specifier: m[1], start: m.index, end: m.index + m[0].length });
  }
  const namedRe = /\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gu;
  while ((m = namedRe.exec(text))) {
    const named = m[1];
    const specifier = m[2];
    out.push({ kind: 'named', specifiers: parseNamedList(named), specifier, start: m.index, end: m.index + m[0].length });
  }
  const defaultRe = /\bimport\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s*(?:,\s*\{([^}]*)\})?\s*from\s*['"]([^'"]+)['"]/gu;
  while ((m = defaultRe.exec(text))) {
    const defaultLocal = m[1];
    const named = m[2] ? parseNamedList(m[2]) : [];
    const specifier = m[3];
    out.push({ kind: 'default', specifiers: named, defaultLocal, specifier, start: m.index, end: m.index + m[0].length });
  }
  const namespaceRe = /\bimport\s+(?:type\s+)?\*\s+as\s+([A-Za-z_$][\w$]*)\s*from\s*['"]([^'"]+)['"]/gu;
  while ((m = namespaceRe.exec(text))) {
    const namespaceLocal = m[1];
    const specifier = m[2];
    out.push({ kind: 'namespace', specifiers: [], namespaceLocal, specifier, start: m.index, end: m.index + m[0].length });
  }
  return out;
}
export function parseExportFroms(text: string): { names: string[]; specifier: string; start: number; end: number }[] {
  const out: { names: string[]; specifier: string; start: number; end: number }[] = [];
  const re = /\bexport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ names: parseNamedList(m[1]).map(s => s.local), specifier: m[2], start: m.index, end: m.index + m[0].length });
  const starRe = /\bexport\s+\*(?:\s+as\s+[A-Za-z_$][\w$]*)?\s*from\s*['"]([^'"]+)['"]/gu;
  while ((m = starRe.exec(text))) out.push({ names: ['*'], specifier: m[1], start: m.index, end: m.index + m[0].length });
  return out;
}
