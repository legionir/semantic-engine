import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ProjectIndexReader } from '../../ai/ProjectIndexReader';
import { FileEntry, SymbolEntry } from '../types/project-index.types';
import { compareCanonical, LineIndex, makeSymbolKey, sanitizeKeyPart } from '../contracts/codeintel';
import { Phase1IndexPlatform } from './Phase1Platform';

export type ResolutionConfidence = 'exact' | 'heuristic' | 'ambiguous' | 'unresolved';
export type ResolutionVia = 'lsp' | 'import-graph' | 'scope' | 'name-only';
export type ReferenceBindingKind = 'direct' | 'same-file' | 're-export-routed' | 'default-routed' | 'namespace-routed';
export type HardBindingKind = 'local-shadow' | 'unresolved-use';

/**
 * Occurrence classes (F7): every scanned word occurrence of a candidate name is
 * classified into exactly one class. `reference` and `hard-binding` carry
 * binding information; the rest are audit-only exclusions.
 */
export type OccurrenceClass =
  | 'reference' | 'hard-binding'
  | 'declaration' | 'import-declaration' | 'param-declarator'
  | 'comment' | 'string' | 'property-access' | 'property-key'
  | 'namespace-object-use' | 'unclassified';

export interface ResolutionCandidate { readonly symbolId: string; readonly symbolKey: string; readonly path: string; readonly name: string; readonly kind: string; }
export interface ResolutionProvenance { readonly confidence: ResolutionConfidence; readonly via: ResolutionVia; readonly candidates: readonly ResolutionCandidate[]; readonly reason?: string; }
export interface SymbolReference {
  readonly id: string;
  readonly targetSymbolId?: string;
  readonly targetSymbolKey: string;
  readonly sourceFileId: string;
  readonly sourcePath: string;
  readonly line: number;
  readonly column: number;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly provenance: ResolutionProvenance;
  /** How the target was bound (F5/F7). */
  readonly bindingKind?: ReferenceBindingKind;
  /** Innermost index symbol whose span contains the occurrence on the SOURCE side (F4). */
  readonly sourceEnclosingSymbolId?: string;
}
export interface UnresolvedReference {
  readonly id: string;
  readonly sourceFileId: string;
  readonly sourcePath: string;
  readonly name: string;
  readonly line: number;
  readonly column: number;
  readonly reason: string;
  readonly provenance: ResolutionProvenance;
}
/** An occurrence that exists in code but does not bind to an index symbol (F1/F7). */
export interface HardBinding {
  readonly id: string;
  readonly sourceFileId: string;
  readonly sourcePath: string;
  readonly name: string;
  readonly line: number;
  readonly column: number;
  readonly kind: HardBindingKind;
  readonly reason: string;
  readonly sourceEnclosingSymbolId?: string;
  readonly provenance: ResolutionProvenance;
}
export interface OccurrenceAuditRow {
  readonly fileId: string;
  readonly path: string;
  readonly total: number;
  readonly byClass: Readonly<Record<OccurrenceClass, number>>;
}
export interface SemanticGraph {
  readonly schemaVersion: '3-pilot';
  readonly language: 'typescript';
  readonly snapshotId: string;
  readonly references: readonly SymbolReference[];
  readonly unresolved: readonly UnresolvedReference[];
  readonly hardBindings: readonly HardBinding[];
  readonly occurrenceAudit: readonly OccurrenceAuditRow[];
  readonly fileDeps: readonly { readonly fromFileId: string; readonly toFileId?: string; readonly specifier: string; readonly resolved: boolean }[];
}

interface CandidateWithFile extends ResolutionCandidate { readonly fileId: string; }

/** A syntactic local binding (parameter or shadowing declarator) with an approximate scope (F1). */
interface LocalBinding {
  readonly name: string;
  readonly declarator: number;
  readonly scopeStart: number;
  readonly scopeEnd: number;
}

interface ImportSpecifierBinding { readonly imported: string; readonly local: string; }
interface ImportStatement {
  readonly kind: 'named' | 'default' | 'namespace' | 'side-effect';
  readonly specifiers: readonly ImportSpecifierBinding[];
  readonly defaultLocal?: string;
  readonly namespaceLocal?: string;
  readonly specifier: string;
  readonly start: number;
  readonly end: number;
}
interface ExportRoute {
  readonly kind: 'local' | 'reexport' | 'star-namespace' | 'default-local';
  readonly symbolIds?: readonly string[];
  readonly fromSpecifier?: string;
  readonly importName?: string;
}
interface FileExports { readonly explicit: ReadonlyMap<string, ExportRoute>; readonly stars: readonly string[] }

interface Scan {
  readonly mask: Uint8Array;          // 0 code, 1 line comment, 2 block comment, 3 string/template
  readonly valid: boolean;            // quotes/comments closed and braces balanced
  readonly braces: readonly { readonly open: number; readonly close: number }[];
  readonly lineIndex: LineIndex;
}

const MAX_REEXPORT_DEPTH = 6;

/**
 * Phase 3 semantic graph pilot.
 *
 * Dependency-free, deliberately additive over ProjectIndexReader. Implements the
 * Spike-S resolution fixes F1–F7 (docs/validation/spike-s/retrieval-design.md §5):
 * F1 occurrence classification + scope-aware binding, F2 multi-name imports,
 * F3 same-file references, F4 bidirectional reference graph (sourceEnclosingSymbolId),
 * F5 default/re-export/export-from routing, F6 collision-free symbol keys,
 * F7 binding-kind tagging with zero silent drops.
 *
 * Honesty rules: an `exact` claim requires a unique binding on a cleanly scanned
 * file; any approximation degrades to `heuristic`, never a wrong `exact`.
 */
export class Phase3SemanticGraphPilot {
  private readonly platform = new Phase1IndexPlatform();
  private readonly sourceCache = new Map<string, string>();
  private readonly scanCache = new Map<string, Scan>();
  private readonly exportCache = new Map<string, FileExports>();
  constructor(private readonly reader: ProjectIndexReader, private readonly workspaceRoot: string) {}

  async build(): Promise<SemanticGraph> {
    const index = this.reader.projectIndex;
    const snapshotId = this.platform.snapshotId(index);
    const files = [...this.reader.getAllFiles()].filter(f => this.isTypeScript(f)).sort((a, b) => compareCanonical(a.path, b.path));

    const refs: SymbolReference[] = [];
    const unresolved: UnresolvedReference[] = [];
    const hardBindings: HardBinding[] = [];
    const deps: { fromFileId: string; toFileId?: string; specifier: string; resolved: boolean }[] = [];
    const audit: OccurrenceAuditRow[] = [];

    // Export tables for every file first: re-export routes cross files (F5).
    for (const file of files) await this.exportsOf(file);

    for (const file of files) {
      const text = await this.read(file);
      const scan = this.scanText(file, text);
      const symbols = [...this.reader.getSymbolsForFile(file.id)];
      const imports = this.parseImports(text);
      const importSpans = imports.map(i => ({ start: i.start, end: i.end }));
      const declaratorLines = new Map<string, Set<number>>();
      for (const s of symbols) {
        const lines = declaratorLines.get(s.name) ?? new Set<number>();
        lines.add(s.line);
        declaratorLines.set(s.name, lines);
      }
      const fileSymbolsByName = new Map<string, SymbolEntry[]>();
      for (const s of symbols) {
        const list = fileSymbolsByName.get(s.name) ?? [];
        list.push(s);
        fileSymbolsByName.set(s.name, list);
      }
      const localBindings = this.collectLocalBindings(text, scan, symbols, imports);

      // Import bindings + file deps + unresolved declarations (F2, F5).
      const importBindings = new Map<string, { candidates: readonly CandidateWithFile[]; route: ReferenceBindingKind } | { unresolvedReason: string }>();
      const namespaceImports = new Map<string, { module?: FileEntry }>();
      for (const stmt of imports) {
        const target = stmt.specifier.startsWith('.') ? this.resolveModule(file, stmt.specifier) : undefined;
        deps.push({ fromFileId: file.id, ...(target ? { toFileId: target.id } : {}), specifier: stmt.specifier, resolved: !!target });
        if (stmt.kind === 'side-effect') continue;
        if (stmt.kind === 'namespace') {
          const local = stmt.namespaceLocal ?? '';
          if (!local) continue;
          namespaceImports.set(local, { module: target });
          if (!target) unresolved.push(this.unresolvedAt(file, scan, local, stmt, `unresolved namespace import from '${stmt.specifier}'`));
          continue;
        }
        const specifiers: ImportSpecifierBinding[] = [
          ...(stmt.defaultLocal ? [{ imported: 'default', local: stmt.defaultLocal }] : []),
          ...stmt.specifiers,
        ];
        for (const spec of specifiers) {
          if (!spec.local) continue;
          if (target) {
            const resolved = this.resolveExport(target, spec.imported, new Set<string>(), 0);
            if (resolved.candidates.length) {
              importBindings.set(spec.local, { candidates: resolved.candidates, route: resolved.route });
              continue;
            }
          }
          const reason = spec.imported === 'default'
            ? (target ? `unresolved default import from '${stmt.specifier}' (no default export)` : `unresolved default import from '${stmt.specifier}' (module not found)`)
            : (target ? `unresolved import '${spec.imported}' from '${stmt.specifier}' (no matching export)` : `unresolved import '${spec.imported}' from '${stmt.specifier}' (module not found)`);
          importBindings.set(spec.local, { unresolvedReason: reason });
          unresolved.push(this.unresolvedAt(file, scan, spec.local, stmt, reason));
        }
      }

      // Export-from file deps (F5): re-export statements create real edges.
      for (const route of this.parseExportFroms(text)) {
        const target = route.specifier.startsWith('.') ? this.resolveModule(file, route.specifier) : undefined;
        deps.push({ fromFileId: file.id, ...(target ? { toFileId: target.id } : {}), specifier: route.specifier, resolved: !!target });
        if (!target) {
          for (const name of route.names) {
            if (name === '*') continue;
            unresolved.push(this.unresolvedAt(file, scan, name, route, `unresolved re-export '${name}' from '${route.specifier}' (module not found)`));
          }
        }
      }

      const auditCounts = emptyAuditCounts();
      const classifyCtx = {
        file, text, scan, importSpans, declaratorLines, localBindings, importBindings, fileSymbolsByName, refs, hardBindings,
      };

      // Candidate names: import locals + same-file index symbol names. Namespace
      // locals are handled exclusively by the namespace scan below.
      const candidateNames = [...new Set<string>([...importBindings.keys(), ...fileSymbolsByName.keys()])].sort(compareCanonical);
      for (const name of candidateNames) {
        for (const occurrence of this.occurrences(text, name)) {
          auditCounts[this.classify(classifyCtx, name, occurrence).class]++;
        }
      }

      // Namespace member uses: `M.prop` (F5 namespace routing, F7 unresolved-use).
      for (const [local, ns] of [...namespaceImports.entries()].sort((a, b) => compareCanonical(a[0], b[0]))) {
        for (const occurrence of this.occurrences(text, local)) {
          const at = this.withPosition(scan, occurrence);
          const region = scan.mask[at.start];
          if (region === 1 || region === 2) { auditCounts.comment++; continue; }
          if (region === 3) { auditCounts.string++; continue; }
          if (inSpans(at.start, importSpans)) { auditCounts['import-declaration']++; continue; }
          const member = this.memberAfter(text, at.end);
          if (member === undefined) { auditCounts['namespace-object-use']++; continue; }
          const enclosing = this.enclosingSymbolId(file, at.line);
          if (!ns.module) {
            hardBindings.push(this.hardBinding(file, `${local}.${member}`, at, 'unresolved-use', `use of unresolved namespace '${local}'`, enclosing));
            auditCounts['hard-binding']++;
            continue;
          }
          const resolved = this.resolveExport(ns.module, member, new Set<string>(), 0);
          if (!resolved.candidates.length) {
            hardBindings.push(this.hardBinding(file, `${local}.${member}`, at, 'unresolved-use', `namespace '${local}' has no export '${member}'`, enclosing));
            auditCounts['hard-binding']++;
            continue;
          }
          this.pushReference(file, `${local}.${member}`, at, resolved.candidates, 'namespace-routed', enclosing, refs, scan.valid && resolved.candidates.length === 1);
          auditCounts.reference++;
        }
      }

      audit.push({ fileId: file.id, path: file.path, total: Object.values(auditCounts).reduce((a, b) => a + b, 0), byClass: { ...auditCounts } });
    }

    refs.sort(referenceOrder);
    unresolved.sort((a, b) => compareCanonical(a.id, b.id));
    hardBindings.sort((a, b) => compareCanonical(a.id, b.id));
    deps.sort((a, b) => compareCanonical(`${a.fromFileId}:${a.specifier}`, `${b.fromFileId}:${b.specifier}`));
    return { schemaVersion: '3-pilot', language: 'typescript', snapshotId, references: refs, unresolved, hardBindings, occurrenceAudit: audit, fileDeps: deps };
  }

  /**
   * Conservative incremental contract for the pilot. The current adapter rebuilds
   * the bounded graph to preserve semantic equality until the producer exposes
   * per-file parse caches; callers still get an explicit changed-path boundary.
   * It never returns a stale partial graph.
   */
  async buildIncremental(previous: SemanticGraph, changedPaths: readonly string[]): Promise<SemanticGraph> {
    if (previous.schemaVersion !== '3-pilot') throw new Error('INVALID_ARGUMENT: unsupported semantic graph schema');
    if (changedPaths.some(p => !p || path.posix.isAbsolute(p) || p.includes('..'))) throw new Error('DENIED: invalid changed path');
    return this.build();
  }

  async referencesFor(target: SymbolEntry | string): Promise<{ graph: SemanticGraph; references: readonly SymbolReference[] }> {
    const graph = await this.build();
    const symbol = typeof target === 'string' ? this.findSymbol(target) : target;
    if (!symbol) return { graph, references: [] };
    const key = this.symbolKey(symbol);
    return {
      graph,
      references: graph.references.filter(r =>
        r.targetSymbolId === symbol.id ||
        r.targetSymbolKey === key ||
        r.provenance.candidates.some(c => c.symbolId === symbol.id)),
    };
  }

  /** References of `symbol` within an arbitrary (built or persisted) graph (F4). */
  referencesWithin(graph: SemanticGraph, symbol: SymbolEntry): readonly SymbolReference[] {
    const key = this.symbolKey(symbol);
    return graph.references.filter(r =>
      r.targetSymbolId === symbol.id ||
      r.targetSymbolKey === key ||
      r.provenance.candidates.some(c => c.symbolId === symbol.id));
  }

  /** Outgoing references of a symbol (F4): references whose source-side enclosing symbol is the seed. */
  async outgoingFor(target: SymbolEntry | string): Promise<{ graph: SemanticGraph; references: readonly SymbolReference[] }> {
    const graph = await this.build();
    const symbol = typeof target === 'string' ? this.findSymbol(target) : target;
    if (!symbol) return { graph, references: [] };
    return { graph, references: graph.references.filter(r => r.sourceEnclosingSymbolId === symbol.id) };
  }

  /** Collision-free pilot symbol key (F6): same name+kind in one file gets a source-order ordinal. */
  symbolKey(symbol: SymbolEntry): string { return symbolKeyFor(this.reader, symbol); }

  findSymbol(value: string): SymbolEntry | undefined {
    return this.reader.getSymbolById(value) ?? [...this.reader.getAllSymbols()].find(s => this.symbolKey(s) === value || s.name === value);
  }
  private isTypeScript(file: FileEntry): boolean { return file.language === 'typescript' || file.language === 'javascript' || file.language === 'tsx' || /\.(tsx?|jsx?|mts|cts)$/u.test(file.path); }
  private async read(file: FileEntry): Promise<string> { const cached = this.sourceCache.get(file.id); if (cached !== undefined) return cached; const value = (await fs.readFile(path.resolve(this.workspaceRoot, file.path), 'utf8')).replace(/^\uFEFF/u, ''); this.sourceCache.set(file.id, value); return value; }

  // ── Scanning (F1) ───────────────────────────────────────────────────────────

  private scanText(file: FileEntry, text: string): Scan {
    const cached = this.scanCache.get(file.id);
    if (cached) return cached;
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
    this.scanCache.set(file.id, scan);
    return scan;
  }

  private occurrences(text: string, name: string): { start: number; end: number }[] {
    if (!name) return [];
    const re = new RegExp(`\\b${escape(name)}\\b`, 'gu');
    const out: { start: number; end: number }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) out.push({ start: m.index, end: m.index + name.length });
    return out;
  }

  private withPosition(scan: Scan, occurrence: { start: number; end: number }): { start: number; end: number; line: number; column: number } {
    const p = scan.lineIndex.positionAt(occurrence.start);
    return { ...occurrence, line: p.line + 1, column: p.character };
  }

  /** The identifier immediately after `offset.` (namespace member), if any. */
  private memberAfter(text: string, offset: number): string | undefined {
    let i = offset;
    while (i < text.length && /\s/u.test(text[i])) i++;
    if (text[i] !== '.') return undefined;
    i++;
    while (i < text.length && /\s/u.test(text[i])) i++;
    const m = /^[A-Za-z_$][\w$]*/u.exec(text.slice(i));
    return m ? m[0] : undefined;
  }

  // ── Local bindings (F1): parameters and shadowing declarators ───────────────

  private collectLocalBindings(text: string, scan: Scan, symbols: readonly SymbolEntry[], imports: readonly ImportStatement[]): LocalBinding[] {
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
        const close = this.matchBrace(scan, after);
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
      const close = this.matchParen(text, open);
      if (close === undefined) continue;
      addParams(open, close, scan.lineIndex.lineStart(symbol.line - 1), Math.min(fileEnd, scan.lineIndex.contentEnd(symbol.endLine - 1) + 1));
    }
    // 2. Nested function declarations (indexed or not): params scope over the body braces.
    const fnRe = /\bfunction\b\s*[A-Za-z_$][\w$]*\s*\(/gu;
    let m: RegExpExecArray | null;
    while ((m = fnRe.exec(text))) {
      if (scan.mask[m.index] !== 0 || inSpans(m.index, importSpans)) continue;
      const open = m.index + m[0].length - 1;
      const close = this.matchParen(text, open);
      if (close === undefined) continue;
      const after = nextNonWs(text, close + 1);
      const scopeEnd = after >= 0 && text[after] === '{' && this.matchBrace(scan, after) !== undefined ? (this.matchBrace(scan, after) as number) + 1 : endOfStatement(text, close + 1);
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

  private matchParen(text: string, open: number): number | undefined {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      const char = text[i];
      if (char === '(') depth++;
      else if (char === ')') { depth--; if (depth === 0) return i; }
    }
    return undefined;
  }
  private matchBrace(scan: Scan, open: number): number | undefined {
    const pair = scan.braces.find(b => b.open === open);
    return pair ? pair.close : undefined;
  }

  // ── Imports / exports (F2, F5) ──────────────────────────────────────────────

  private parseImports(text: string): ImportStatement[] {
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

  private parseExportFroms(text: string): { names: string[]; specifier: string; start: number; end: number }[] {
    const out: { names: string[]; specifier: string; start: number; end: number }[] = [];
    const re = /\bexport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gu;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) out.push({ names: parseNamedList(m[1]).map(s => s.local), specifier: m[2], start: m.index, end: m.index + m[0].length });
    const starRe = /\bexport\s+\*(?:\s+as\s+[A-Za-z_$][\w$]*)?\s*from\s*['"]([^'"]+)['"]/gu;
    while ((m = starRe.exec(text))) out.push({ names: ['*'], specifier: m[1], start: m.index, end: m.index + m[0].length });
    return out;
  }

  private async exportsOf(file: FileEntry): Promise<FileExports> {
    const cached = this.exportCache.get(file.id);
    if (cached) return cached;
    const text = await this.read(file);
    const scan = this.scanText(file, text);
    const explicit = new Map<string, ExportRoute>();
    let m: RegExpExecArray | null;
    // Local named exports from the index.
    for (const symbol of this.reader.getSymbolsForFile(file.id)) {
      if (!symbol.exported) continue;
      const route = explicit.get(symbol.name);
      const ids = [...(route?.symbolIds ?? []), symbol.id];
      explicit.set(symbol.name, { kind: 'local', symbolIds: ids });
    }
    // `export { x as y }` (no from): local alias.
    const localNamedRe = /\bexport\s+(?:type\s+)?\{([^}]*)\}(?!\s*from)/gu;
    while ((m = localNamedRe.exec(text))) {
      if (scan.mask[m.index] !== 0) continue;
      for (const spec of parseNamedList(m[1])) {
        const symbols = this.reader.getSymbolsForFile(file.id).filter(s => s.name === spec.imported && s.exported);
        if (symbols.length) explicit.set(spec.local, { kind: 'local', symbolIds: symbols.map(s => s.id) });
      }
    }
    // `export default <named declaration>` binds the default name to that local symbol.
    const defaultRe = /\bexport\s+default\s+(?:async\s+)?(?:class|function|const|let|var)\s+([A-Za-z_$][\w$]*)/gu;
    while ((m = defaultRe.exec(text))) {
      if (scan.mask[m.index] !== 0) continue;
      const defaultName = m[1];
      const symbols = this.reader.getSymbolsForFile(file.id).filter(s => s.name === defaultName);
      if (symbols.length) explicit.set('default', { kind: 'default-local', symbolIds: symbols.map(s => s.id) });
    }
    // `export { a as b } from './m'`, `export * as ns from './m'`, `export * from './m'`.
    const reexportRe = /\bexport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gu;
    const stars: string[] = [];
    while ((m = reexportRe.exec(text))) {
      if (scan.mask[m.index] !== 0) continue;
      const fromSpecifier = m[2];
      for (const spec of parseNamedList(m[1])) explicit.set(spec.local, { kind: 'reexport', fromSpecifier, importName: spec.imported });
    }
    const starNsRe = /\bexport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s*from\s*['"]([^'"]+)['"]/gu;
    while ((m = starNsRe.exec(text))) {
      if (scan.mask[m.index] !== 0) continue;
      explicit.set(m[1], { kind: 'star-namespace', fromSpecifier: m[2] });
    }
    const starRe = /\bexport\s+\*\s+from\s*['"]([^'"]+)['"]/gu;
    while ((m = starRe.exec(text))) {
      if (scan.mask[m.index] !== 0) continue;
      stars.push(m[1]);
    }
    const exports: FileExports = { explicit, stars };
    this.exportCache.set(file.id, exports);
    return exports;
  }

  private resolveModule(from: FileEntry, specifier: string): FileEntry | undefined {
    if (!specifier.startsWith('.')) return undefined;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(from.path), specifier));
    const probes = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}/index.ts`, `${base}/index.tsx`];
    return [...this.reader.getAllFiles()].find(f => probes.includes(f.path));
  }

  private resolveExport(from: FileEntry, name: string, visited: Set<string>, depth: number): { candidates: readonly CandidateWithFile[]; route: "direct" | "re-export-routed" | "default-routed" } {
    if (depth > MAX_REEXPORT_DEPTH) return { candidates: [], route: 'direct' };
    const key = `${from.id}:${name}`;
    if (visited.has(key)) return { candidates: [], route: 'direct' };
    visited.add(key);
    const exports = this.exportCache.get(from.id);
    if (!exports) return { candidates: [], route: 'direct' };
    const route = exports.explicit.get(name);
    if (route) {
      if (route.kind === 'local') {
        return { candidates: this.candidatesFor(from, route.symbolIds ?? []), route: 'direct' };
      }
      if (route.kind === 'default-local') {
        return { candidates: this.candidatesFor(from, route.symbolIds ?? []), route: 'default-routed' };
      }
      if (route.kind === 'reexport' && route.fromSpecifier !== undefined && route.importName !== undefined) {
        const target = this.resolveModule(from, route.fromSpecifier);
        if (!target) return { candidates: [], route: 're-export-routed' };
        const inner = this.resolveExport(target, route.importName, visited, depth + 1);
        if (!inner.candidates.length) return inner;
        return { candidates: inner.candidates, route: inner.route === 'default-routed' ? 'default-routed' : 're-export-routed' };
      }
      return { candidates: [], route: 'direct' }; // star-namespace: a namespace object, no named symbol
    }
    const starCandidates: CandidateWithFile[] = [];
    for (const star of exports.stars) {
      const target = this.resolveModule(from, star);
      if (!target) continue;
      const inner = this.resolveExport(target, name, visited, depth + 1);
      for (const candidate of inner.candidates) {
        if (!starCandidates.some(c => c.symbolId === candidate.symbolId)) starCandidates.push(candidate);
      }
    }
    if (starCandidates.length) return { candidates: starCandidates.sort((a, b) => compareCanonical(a.symbolKey, b.symbolKey)), route: 're-export-routed' };
    return { candidates: [], route: 'direct' };
  }

  private candidatesFor(file: FileEntry, symbolIds: readonly string[]): CandidateWithFile[] {
    const out: CandidateWithFile[] = [];
    for (const id of symbolIds) {
      const symbol = this.reader.getSymbolById(id);
      if (!symbol) continue;
      out.push({ symbolId: symbol.id, symbolKey: this.symbolKey(symbol), path: file.path, name: symbol.name, kind: symbol.kind, fileId: file.id });
    }
    return out.sort((a, b) => compareCanonical(a.symbolKey, b.symbolKey));
  }

  // ── Occurrence classification (F1/F7) ───────────────────────────────────────

  private classify(ctx: {
    file: FileEntry; text: string; scan: Scan;
    importSpans: { start: number; end: number }[];
    declaratorLines: Map<string, Set<number>>;
    localBindings: readonly LocalBinding[];
    importBindings: Map<string, { candidates: readonly CandidateWithFile[]; route: ReferenceBindingKind } | { unresolvedReason: string }>;
    fileSymbolsByName: Map<string, SymbolEntry[]>;
    refs: SymbolReference[];
    hardBindings: HardBinding[];
  }, name: string, occurrence: { start: number; end: number }): { class: OccurrenceClass } {
    const { file, text, scan, importSpans, declaratorLines, localBindings, importBindings, fileSymbolsByName, refs, hardBindings } = ctx;
    const at = this.withPosition(scan, occurrence);
    const region = scan.mask[at.start];
    if (region === 1 || region === 2) return { class: 'comment' };
    if (region === 3) return { class: 'string' };
    if (inSpans(at.start, importSpans)) return { class: 'import-declaration' };
    const prev = prevNonWs(text, at.start);
    if (prev >= 0 && text[prev] === '.') return { class: 'property-access' };
    const next = nextNonWs(text, at.end);
    if (prev >= 0 && (text[prev] === '{' || text[prev] === ',') && next >= 0 && text[next] === ':') return { class: 'property-key' };
    if (declaratorLines.get(name)?.has(at.line)) return { class: 'declaration' };
    if (localBindings.some(b => b.name === name && b.declarator === at.start)) return { class: 'param-declarator' };
    const shadow = innermostLocal(localBindings, name, at.start);
    if (shadow && at.start !== shadow.declarator) {
      const enclosing = this.enclosingSymbolId(file, at.line);
      hardBindings.push(this.hardBinding(file, name, at, 'local-shadow', `bound to local '${name}' (param or shadowing declarator)`, enclosing));
      return { class: 'hard-binding' };
    }
    if (shadow && at.start === shadow.declarator) return { class: 'param-declarator' };
    const importBinding = importBindings.get(name);
    if (importBinding) {
      const enclosing = this.enclosingSymbolId(file, at.line);
      if ('unresolvedReason' in importBinding) {
        hardBindings.push(this.hardBinding(file, name, at, 'unresolved-use', importBinding.unresolvedReason, enclosing));
        return { class: 'hard-binding' };
      }
      this.pushReference(file, name, at, importBinding.candidates, importBinding.route, enclosing, refs, scan.valid && importBinding.candidates.length === 1);
      return { class: 'reference' };
    }
    const sameFile = fileSymbolsByName.get(name);
    if (sameFile && sameFile.length) {
      const enclosing = this.enclosingSymbolId(file, at.line);
      const candidates = this.candidatesFor(file, sameFile.map(s => s.id));
      this.pushReference(file, name, at, candidates, 'same-file', enclosing, refs, scan.valid);
      return { class: 'reference' };
    }
    return { class: 'unclassified' };
  }

  private pushReference(file: FileEntry, name: string, at: { line: number; column: number; start: number; end: number }, candidates: readonly CandidateWithFile[], route: ReferenceBindingKind, enclosing: string | undefined, refs: SymbolReference[], certain: boolean): void {
    const provenance: ResolutionProvenance = candidates.length === 1
      ? { confidence: certain ? 'exact' : 'heuristic', via: route === 'same-file' ? 'scope' : 'import-graph', candidates }
      : { confidence: 'ambiguous', via: route === 'same-file' ? 'scope' : 'import-graph', candidates, reason: 'multiple matching exports' };
    refs.push({
      id: stableId(`${file.path}:${at.start}:${candidates.map(c => c.symbolId).join(',')}`),
      ...(candidates.length === 1 ? { targetSymbolId: candidates[0].symbolId } : {}),
      targetSymbolKey: candidates[0]?.symbolKey ?? '',
      sourceFileId: file.id,
      sourcePath: file.path,
      line: at.line, column: at.column, start: at.start, end: at.end,
      text: name,
      provenance,
      bindingKind: route,
      ...(enclosing ? { sourceEnclosingSymbolId: enclosing } : {}),
    });
  }

  private hardBinding(file: FileEntry, name: string, at: { line: number; column: number; start: number; end: number }, kind: HardBindingKind, reason: string, enclosing: string | undefined): HardBinding {
    return {
      id: stableId(`${file.path}:${at.start}:${kind}:${name}`),
      sourceFileId: file.id, sourcePath: file.path, name,
      line: at.line, column: at.column, kind, reason,
      ...(enclosing ? { sourceEnclosingSymbolId: enclosing } : {}),
      provenance: { confidence: 'unresolved', via: 'scope', candidates: [], reason },
    };
  }

  private unresolvedAt(file: FileEntry, scan: Scan, name: string, stmt: { start: number; end: number }, reason: string): UnresolvedReference {
    const p = scan.lineIndex.positionAt(stmt.start);
    return {
      id: stableId(`${file.path}:unresolved:${stmt.start}:${name}`),
      sourceFileId: file.id, sourcePath: file.path, name,
      line: p.line + 1, column: p.character, reason,
      provenance: { confidence: 'unresolved', via: 'import-graph', candidates: [], reason },
    };
  }

  private enclosingSymbolId(file: FileEntry, line: number): string | undefined {
    let best: { id: string; span: number } | undefined;
    for (const s of this.reader.getSymbolsForFile(file.id)) {
      if (line < s.line || line > s.endLine) continue;
      const span = s.endLine - s.line;
      if (!best || span < best.span) best = { id: s.id, span };
    }
    return best?.id;
  }
}

function parseNamedList(raw: string): ImportSpecifierBinding[] {
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

/** Collision-free pilot symbol key (F6): same name+kind in one file gets a source-order ordinal. */
export function symbolKeyFor(reader: ProjectIndexReader, symbol: SymbolEntry): string {
  const file = reader.getFileById(symbol.fileId);
  const siblings = reader.getSymbolsForFile(symbol.fileId).filter(s => s.name === symbol.name && s.kind === symbol.kind);
  const ordinal = siblings.length > 1 ? [...siblings].sort((a, b) => a.line - b.line || compareCanonical(a.id, b.id)).indexOf(symbol) : undefined;
  return String(makeSymbolKey(file?.path ?? symbol.fileId, sanitizeKeyPart(symbol.fullyQualifiedName ?? symbol.name), sanitizeKeyPart(symbol.kind), ordinal));
}
function splitTopLevel(slice: string): string[] {
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
function emptyAuditCounts(): Record<OccurrenceClass, number> {
  return { reference: 0, 'hard-binding': 0, declaration: 0, 'import-declaration': 0, 'param-declarator': 0, comment: 0, string: 0, 'property-access': 0, 'property-key': 0, 'namespace-object-use': 0, unclassified: 0 };
}
function inSpans(offset: number, spans: readonly { start: number; end: number }[]): boolean {
  return spans.some(s => offset >= s.start && offset < s.end);
}
function innermostLocal(bindings: readonly LocalBinding[], name: string, offset: number): LocalBinding | undefined {
  let best: LocalBinding | undefined;
  for (const b of bindings) {
    if (b.name !== name) continue;
    if (offset < b.scopeStart || offset >= b.scopeEnd) continue;
    if (offset === b.declarator) return b;
    if (!best || b.scopeEnd - b.scopeStart < best.scopeEnd - best.scopeStart) best = b;
  }
  return best;
}
function innermostBrace(scan: Scan, offset: number): { open: number; close: number } | undefined {
  let best: { open: number; close: number } | undefined;
  for (const pair of scan.braces) {
    if (pair.open < offset && offset < pair.close) {
      if (!best || pair.close - pair.open < best.close - best.open) best = pair;
    }
  }
  return best;
}
function prevNonWs(text: string, offset: number): number {
  for (let i = offset - 1; i >= 0; i--) if (!/\s/u.test(text[i])) return i;
  return -1;
}
function nextNonWs(text: string, offset: number): number {
  for (let i = offset; i < text.length; i++) if (!/\s/u.test(text[i])) return i;
  return -1;
}
function endOfStatement(text: string, from: number): number {
  const semi = text.indexOf(';', from);
  const nl = text.indexOf('\n', from);
  const candidates = [semi >= 0 ? semi + 1 : undefined, nl >= 0 ? nl + 1 : undefined, text.length].filter((v): v is number => v !== undefined);
  return Math.min(...candidates);
}
function escape(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'); }
function stableId(value: string): string { return crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16); }
function referenceOrder(a: SymbolReference, b: SymbolReference): number { return compareCanonical(`${a.sourcePath}:${a.start}:${a.id}`, `${b.sourcePath}:${b.start}:${b.id}`); }
