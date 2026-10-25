import * as crypto from 'crypto';
import { FileEntry, ProjectIndex, SymbolEntry, Diagnostic, LanguageSupportEntry } from '../types/project-index.types';
import { compareCanonical, LineIndex, makeSymbolKey, sanitizeKeyPart } from '../contracts/codeintel';
import { LanguageRegistry } from '../../language/LanguageRegistry';

export type AdapterStatus = 'ok' | 'degraded' | 'unavailable';

export interface AdapterState extends LanguageSupportEntry {
  readonly status: AdapterStatus;
  readonly grammarVersion?: string;
}

export interface ParseDiagnostics {
  readonly diagnostics: readonly Diagnostic[];
  readonly partial: boolean;
}

export interface OutlineNode {
  readonly key: string;
  readonly name: string;
  readonly kind: SymbolEntry['kind'];
  readonly fileId: string;
  readonly range: { readonly start: number; readonly end: number };
  readonly signatureHash?: string;
  readonly partial?: boolean;
}

/** Deterministic, additive v1 view over the existing ProjectIndex. */
export class Phase1IndexPlatform {
  private readonly languageRegistry = new LanguageRegistry();

  adapters(index: ProjectIndex): Readonly<Record<string, AdapterState>> {
    const languages = [...new Set(index.languages)].sort(compareCanonical);
    return Object.fromEntries(languages.map(language => {
      const entry = index.languageSupport?.[language];
      const deep = this.languageRegistry.isDeepAnalysisSupported(language);
      const state: AdapterState = {
        symbols: entry?.symbols ?? (deep ? 'full' : 'heuristic'),
        callGraph: entry?.callGraph ?? false,
        status: entry ? 'ok' : deep ? 'degraded' : 'unavailable',
      };
      return [language, state];
    }));
  }

  /** Conservative syntax check; it never claims valid when ERROR/MISSING exists. */
  parseDiagnostics(text: string, file: FileEntry): ParseDiagnostics {
    const index = new LineIndex(text);
    const diagnostics: Diagnostic[] = [];
    const stack: Array<{ char: string; offset: number }> = [];
    const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
    let quote: '"' | "'" | '`' | null = null;
    let escaped = false;
    for (let offset = 0; offset < index.text.length; offset++) {
      const char = index.text[offset];
      if (quote) {
        if (escaped) { escaped = false; continue; }
        if (char === '\\') { escaped = true; continue; }
        if (char === quote) quote = null;
        continue;
      }
      if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
      if (char === '(' || char === '[' || char === '{') stack.push({ char, offset });
      else if (char === ')' || char === ']' || char === '}') {
        const expected = pairs[char];
        const top = stack.pop();
        if (!top || top.char !== expected) {
          const position = index.positionAt(offset);
          diagnostics.push({ severity: 'error', code: 'MISSING', line: position.line + 1, column: position.character + 1, message: `Unexpected '${char}'`, source: 'phase1-parser', fileId: file.id });
        }
      }
    }
    if (quote || stack.length) {
      const offset = quote ? Math.max(0, index.text.length - 1) : stack[stack.length - 1]!.offset;
      const position = index.positionAt(offset);
      diagnostics.push({ severity: 'error', code: 'MISSING', line: position.line + 1, column: position.character + 1, message: quote ? 'Unterminated string' : 'Unclosed delimiter', source: 'phase1-parser', fileId: file.id });
    }
    return { diagnostics: diagnostics.sort((a, b) => a.line - b.line || (a.column ?? 0) - (b.column ?? 0)), partial: diagnostics.some(d => d.severity === 'error') };
  }

  outline(index: ProjectIndex, fileId: string, text: string): readonly OutlineNode[] {
    const file = index.files.find(f => f.id === fileId);
    if (!file) return [];
    const lineIndex = new LineIndex(text);
    return index.symbols.filter(s => s.fileId === fileId)
      .sort((a, b) => a.line - b.line || a.endLine - b.endLine || compareCanonical(a.name, b.name))
      .map((symbol, ordinal, all) => {
        const same = all.filter(s => s.name === symbol.name && s.kind === symbol.kind);
        const duplicateOrdinal = same.length > 1 ? same.indexOf(symbol) : undefined;
        const key = makeSymbolKey(file.path, sanitizeKeyPart(symbol.fullyQualifiedName ?? symbol.name), sanitizeKeyPart(symbol.kind), duplicateOrdinal);
        const startLine = Math.max(0, symbol.line - 1);
        const endLine = Math.max(startLine, Math.min(lineIndex.lineCount - 1, symbol.endLine - 1));
        return { key, name: symbol.name, kind: symbol.kind, fileId, range: { start: lineIndex.lineStart(startLine), end: lineIndex.contentEnd(endLine) }, ...(symbol.signature ? { signatureHash: sha8(symbol.signature) } : {}) };
      });
  }

  /** Canonical ordering for semantic output; timestamps are deliberately excluded. */
  canonicalize(index: ProjectIndex): ProjectIndex {
    return {
      ...index,
      languages: [...index.languages].sort(compareCanonical),
      files: [...index.files].sort((a, b) => compareCanonical(a.path, b.path)),
      symbols: [...index.symbols].sort((a, b) => a.fileId.localeCompare(b.fileId) || a.line - b.line || compareCanonical(a.name, b.name)),
      diagnostics: [...index.diagnostics].sort((a, b) => (a.fileId ?? '').localeCompare(b.fileId ?? '') || a.line - b.line || compareCanonical(a.message, b.message)),
    };
  }

  snapshotId(index: ProjectIndex): string {
    const material = this.canonicalize(index).files.map(file => `${file.path}\0${file.hash}`).join('\n');
    return crypto.createHash('sha256').update(material, 'utf8').digest('hex');
  }
}

function sha8(value: string): string { return crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8); }

export interface GenerationOwner {
  readonly generation: number;
  readonly owner: string;
}

/** In-process CAS guard used by producer/worker adapters before publication. */
export class GenerationOwnership {
  private current: GenerationOwner;
  constructor(initial: GenerationOwner = { generation: 0, owner: '' }) { this.current = initial; }
  read(): GenerationOwner { return this.current; }
  claim(expectedGeneration: number, owner: string): GenerationOwner {
    if (!owner) throw new Error('owner is required');
    if (this.current.generation !== expectedGeneration) throw new Error(`GENERATION_CONFLICT: expected ${expectedGeneration}, current ${this.current.generation}`);
    this.current = { generation: expectedGeneration + 1, owner };
    return this.current;
  }
}
