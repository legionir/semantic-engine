import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import { AiTool, AiToolInput, AiToolOutput } from './types';
import { ProjectIndexReader } from '../ProjectIndexReader';
import { FileEntry, SymbolEntry } from '../../core/types/project-index.types';
import { makeHandle, parseHandle, sanitizeKeyPart } from '../../core/contracts/codeintel';
import { isDeniedPath } from '../../core/contracts/fileProvider';
import { SourceSecurityGuard } from '../../services/source/SourceSecurityGuard';
import { Phase1IndexPlatform } from '../../core/codeintel/Phase1Platform';

const DEFAULT_MAX_RESULT_BYTES = 256_000;
const DEFAULT_MAX_TOKENS = 4_000;

function tokens(text: string): number { return Math.ceil(text.length / 4); }
function hash8(text: string): string { return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8); }
function fail(error: string): AiToolOutput { return { success: false, error, items: [] }; }
function fileOf(reader: ProjectIndexReader, input: Record<string, unknown>): FileEntry | undefined {
  if (typeof input.fileId === 'string') return reader.getFileById(input.fileId);
  if (typeof input.path === 'string') return reader.getFileByPath(input.path);
  return undefined;
}

abstract class SourceTool {
  protected readonly guard = new SourceSecurityGuard({ maxFileSizeBytes: 10 * 1024 * 1024 });
  constructor(protected readonly reader: ProjectIndexReader, protected readonly workspaceRoot?: string) {}
  protected resolve(file: FileEntry): { path: string } | { error: string } {
    if (!this.workspaceRoot) return { error: 'Source reading is disabled: workspaceRoot is not configured' };
    if (isDeniedPath(file.path)) return { error: `DENIED: ${file.path} is on the secret/.git denylist` };
    const checked = this.guard.validateRelativePath(this.workspaceRoot, file.path);
    if (!checked.ok || !checked.resolvedPath) return { error: checked.reason ?? 'Source path denied' };
    return { path: checked.resolvedPath };
  }
  protected async read(file: FileEntry): Promise<{ text: string; bytes: number; hash: string } | { error: string }> {
    const resolved = this.resolve(file);
    if ('error' in resolved) return resolved;
    try {
      const stat = await fs.stat(resolved.path);
      const sizeCheck = this.guard.validateFileSize(stat.size);
      if (!sizeCheck.ok) return { error: sizeCheck.reason ?? 'File too large' };
      const raw = await fs.readFile(resolved.path);
      if (raw.includes(0)) return { error: 'Binary source is not readable' };
      const text = raw.toString('utf8').replace(/^\uFEFF/u, '');
      return { text, bytes: raw.byteLength, hash: crypto.createHash('sha256').update(text, 'utf8').digest('hex') };
    } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  }
  protected item(file: FileEntry, excerpt: string, metadata: Record<string, unknown> = {}) {
    return { id: file.id, name: file.path, kind: 'source', path: file.path, line: 1, source: 'phase1-read', excerpt, metadata };
  }
}

export interface CodeReadInput extends AiToolInput { readonly path?: string; readonly fileId?: string; readonly handle?: string; readonly start?: number; readonly end?: number; readonly maxResultBytes?: number; }
export class CodeReadTool extends SourceTool implements AiTool<CodeReadInput> {
  readonly name = 'code_read';
  readonly description = 'Read bounded source content by file, UTF-16 range, or freshness-bound handle.';
  readonly inputSchema = { type: 'object', properties: { path: { type: 'string' }, fileId: { type: 'string' }, handle: { type: 'string' }, start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 0 }, maxResultBytes: { type: 'integer', minimum: 1, maximum: 1000000 } }, anyOf: [{ required: ['path'] }, { required: ['fileId'] }, { required: ['handle'] }] };
  async execute(input: CodeReadInput): Promise<AiToolOutput> {
    const parsed = input.handle ? (() => { try { return parseHandle(input.handle); } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; } })() : undefined;
    if (parsed && 'error' in parsed) return fail(`INVALID_ARGUMENT: ${parsed.error}`);
    const file = parsed ? this.reader.getFileByPath(parsed.relativePath) : fileOf(this.reader, input);
    if (!file) return fail('NOT_FOUND: source file');
    const source = await this.read(file);
    if ('error' in source) return fail(`IO_ERROR: ${source.error}`);
    const range = parsed ? { start: parsed.start, end: parsed.end } : { start: input.start ?? 0, end: input.end ?? source.text.length };
    if (parsed && !source.hash.startsWith(parsed.hash8)) return fail('STALE_HANDLE: source content changed');
    if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end < range.start || range.end > source.text.length) return fail('OUT_OF_RANGE: requested UTF-16 range');
    const text = source.text.slice(range.start, range.end);
    const maxBytes = input.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
    const out = Buffer.byteLength(text, 'utf8') > maxBytes ? text.slice(0, Math.max(0, Math.floor(maxBytes / 2))) : text;
    const truncated = out.length !== text.length;
    const handle = makeHandle(file.path, range.start, range.end, source.hash.slice(0, 8));
    return { success: true, items: [this.item(file, out, { handle, start: range.start, end: range.end, truncated, returnedTokens: tokens(out), avoidedTokensEstimate: Math.max(0, tokens(source.text) - tokens(out)), trust: 'untrusted-source-content' })], metadata: { snapshotId: `${file.path}:${file.hash}`, returnedTokens: tokens(out), truncated } };
  }
}

export interface CodeFoldInput extends AiToolInput { readonly path?: string; readonly fileId?: string; readonly level?: number; readonly maxTokens?: number; readonly comments?: 'strip' | 'doc-only' | 'keep'; }
export class CodeFoldTool extends SourceTool implements AiTool<CodeFoldInput> {
  readonly name = 'code_fold';
  readonly description = 'Return a deterministic structural fold of one source file with bounded tokens.';
  readonly inputSchema = { type: 'object', properties: { path: { type: 'string' }, fileId: { type: 'string' }, level: { type: 'integer', minimum: 0, maximum: 4 }, maxTokens: { type: 'integer', minimum: 1, maximum: 100000 }, comments: { enum: ['strip', 'doc-only', 'keep'] } }, anyOf: [{ required: ['path'] }, { required: ['fileId'] }] };
  async execute(input: CodeFoldInput): Promise<AiToolOutput> {
    const file = fileOf(this.reader, input); if (!file) return fail('NOT_FOUND: source file');
    const source = await this.read(file); if ('error' in source) return fail(`IO_ERROR: ${source.error}`);
    const level = input.level ?? 2; const budget = input.maxTokens ?? DEFAULT_MAX_TOKENS;
    const lines = source.text.split(/\r\n|\r|\n/u);
    const symbols = [...this.reader.getSymbolsForFile(file.id)].sort((a, b) => a.line - b.line || a.endLine - b.endLine || a.name.localeCompare(b.name));
    const keep = new Set<number>();
    const add = (line: number) => { if (line >= 1 && line <= lines.length) keep.add(line - 1); };
    if (level === 0) lines.forEach((_, i) => add(i + 1));
    else {
      lines.forEach((line, i) => { if (/^\s*(import|export|from|const|let|var|type|interface|class|function|def|namespace)\b/u.test(line)) add(i + 1); });
      for (const symbol of symbols) { add(symbol.line); if (level >= 1) add(symbol.endLine); if (level >= 3) for (let l = symbol.line; l <= Math.min(symbol.endLine, symbol.line + 4); l++) add(l); }
    }
    let folded = lines.map((line, i) => keep.has(i) ? line : `… ${i + 1}` ).join('\n');
    if (input.comments === 'strip') folded = folded.split('\n').filter(line => !/^\s*(\/\/|#|\/\*|\*)/u.test(line)).join('\n');
    if (input.comments === 'doc-only') folded = folded.split('\n').filter(line => !/^\s*\/\/(?!\/)|^\s*#(?!\s*\[)/u.test(line)).join('\n');
    let truncated = false;
    if (tokens(folded) > budget) { folded = folded.slice(0, budget * 4); truncated = true; }
    return { success: true, items: [this.item(file, folded, { level, truncated, returnedTokens: tokens(folded), avoidedTokensEstimate: Math.max(0, tokens(source.text) - tokens(folded)), unfoldable: true, elisionMarker: '… line' })], metadata: { level, truncated, returnedTokens: tokens(folded), snapshotId: `${file.path}:${file.hash}` } };
  }
}

export class ProjectInfoTool implements AiTool {
  readonly name = 'project_info'; readonly description = 'Return project identity, generation, languages and adapter status.';
  readonly inputSchema = { type: 'object', properties: {} };
  constructor(private readonly reader: ProjectIndexReader) {}
  async execute(_input?: AiToolInput): Promise<AiToolOutput> { const p = this.reader.projectIndex; const platform = new Phase1IndexPlatform(); return { success: true, items: [{ id: p.root, name: p.root, kind: 'project', source: 'project-index', metadata: { root: p.root, rootPath: p.rootPath, schemaVersion: p.schemaVersion, generatedAt: p.generatedAt, snapshotId: platform.snapshotId(p), languages: [...p.languages].sort(), languageSupport: platform.adapters(p), generation: p.incremental?.mode ?? 'full', trust: 'untrusted-source-content' } }] }; }
}

export class ProjectListFilesTool implements AiTool {
  readonly name = 'project_list_files'; readonly description = 'List indexed files in deterministic path order.';
  readonly inputSchema = { type: 'object', properties: { language: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 10000 } } };
  constructor(private readonly reader: ProjectIndexReader) {}
  async execute(input: AiToolInput): Promise<AiToolOutput> { const language = typeof input.language === 'string' ? input.language : undefined; const limit = typeof input.limit === 'number' ? input.limit : 1000; const all = [...this.reader.getAllFiles()].filter(f => !language || f.language === language).sort((a, b) => a.path.localeCompare(b.path)); const files = all.slice(0, limit); /* SE-AI-HONESTY (P-06) — truncated + honest totals: an AI deciding "raise the limit or narrow the query" needs the real count, not just the flag. */ return { success: true, items: files.map(f => ({ id: f.id, name: f.path, kind: 'file', path: f.path, line: 1, source: 'project-index', metadata: { language: f.language, size: f.size, lines: f.lines, hash: f.hash, generated: f.generated, binary: f.binary } })), metadata: { returnedTokens: files.reduce((n, f) => n + tokens(f.path), 0), truncated: all.length > files.length, matchCount: all.length, limit } }; }
}

export class SearchTextTool extends SourceTool implements AiTool {
  readonly name = 'search_text';
  readonly description = 'Search indexed source text with deterministic matches and enclosing symbol metadata.';
  readonly inputSchema = { type: 'object', properties: { query: { type: 'string', minLength: 1 }, path: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 1000 } }, required: ['query'] };
  async execute(input: AiToolInput): Promise<AiToolOutput> {
    const query = typeof input.query === 'string' ? input.query : '';
    if (!query) return fail('INVALID_ARGUMENT: query is required');
    const files = typeof input.path === 'string' ? [this.reader.getFileByPath(input.path)].filter((f): f is FileEntry => !!f) : [...this.reader.getAllFiles()].sort((a, b) => a.path.localeCompare(b.path));
    const limit = typeof input.limit === 'number' ? input.limit : 100;
    const items: AiToolOutput['items'][number][] = [];
    for (const file of files) {
      if (items.length >= limit) break;
      const source = await this.read(file); if ('error' in source) continue;
      const lines = source.text.split(/\r\n|\r|\n/u);
      lines.forEach((line, i) => { if (items.length < limit && line.toLowerCase().includes(query.toLowerCase())) { const owner = this.reader.getSymbolsForFile(file.id).find(s => s.line <= i + 1 && s.endLine >= i + 1); items.push(this.item(file, line.trim(), { line: i + 1, column: Math.max(0, line.toLowerCase().indexOf(query.toLowerCase())), enclosingSymbol: owner?.id, returnedTokens: tokens(line) })); } });
    }
    /*
    | SE-AI-HONESTY (P-06) — وقتی صفحه پر شد از اسکنِ بقیه فایل‌ها
    | می‌بینیم (تعهدِ عملکردی)، پس شمارشِ کل موجود نیست؛ اما AI باید
    | بداند «حداقل limit تطبیق وجود دارد»، نه فقط اینکه برش خورده.
    */
    const capped = items.length >= limit;
    return { success: true, items, metadata: { returnedTokens: items.reduce((n, i) => n + tokens(i.excerpt ?? ''), 0), truncated: capped, limit, ...(capped ? { matchCountAtLeast: items.length, countNote: 'scan stopped at limit; more matches may exist in unscanned files' } : { matchCount: items.length }) } };
  }
}

export class SymbolInspectTool implements AiTool {
  readonly name = 'symbol_inspect';
  readonly description = 'Inspect a symbol identity, range, signature and provenance from the index.';
  readonly inputSchema = { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, path: { type: 'string' } }, anyOf: [{ required: ['id'] }, { required: ['name'] }] };
  constructor(private readonly reader: ProjectIndexReader) {}
  async execute(input: AiToolInput): Promise<AiToolOutput> { let symbols: readonly SymbolEntry[] = []; if (typeof input.id === 'string') { const one = this.reader.getSymbolById(input.id); symbols = one ? [one] : []; } else if (typeof input.name === 'string') symbols = this.reader.getSymbolsByName(input.name); if (typeof input.path === 'string') { const file = this.reader.getFileByPath(input.path); symbols = symbols.filter(s => s.fileId === file?.id); } if (symbols.length === 0) return fail('NOT_FOUND: symbol'); const items = [...symbols].sort((a, b) => a.fileId.localeCompare(b.fileId) || a.line - b.line).map(s => { const file = this.reader.getFileById(s.fileId); return { id: s.id, name: s.name, kind: s.kind, path: file?.path, line: s.line, source: s.source, excerpt: s.signature ?? s.name, metadata: { symbolKey: `${file?.path ?? s.fileId}::${sanitizeKeyPart(s.fullyQualifiedName ?? s.name)}::${sanitizeKeyPart(s.kind)}`, signatureHash: s.signature ? hash8(s.signature) : undefined, endLine: s.endLine, confidence: s.confidence, exported: s.exported ?? false } }; }); return { success: true, items }; }
}

export class GainsReportTool implements AiTool {
  readonly name = 'gains_report';
  readonly description = 'Report deterministic fold/read token savings against full indexed source estimates.';
  readonly inputSchema = { type: 'object', properties: { path: { type: 'string' }, maxTokens: { type: 'integer', minimum: 1 } } };
  constructor(private readonly reader: ProjectIndexReader, private readonly workspaceRoot?: string) {}
  async execute(input: AiToolInput): Promise<AiToolOutput> { const files = typeof input.path === 'string' ? [this.reader.getFileByPath(input.path)].filter((f): f is FileEntry => !!f) : [...this.reader.getAllFiles()].sort((a, b) => a.path.localeCompare(b.path)); const rows = files.map(f => { const full = Math.max(1, Math.ceil((f.lines * 40) / 4)); const budget = typeof input.maxTokens === 'number' ? input.maxTokens : Math.max(1, Math.ceil(full * 0.35)); return { id: f.id, name: f.path, kind: 'gain', path: f.path, line: 1, source: 'index-estimate', metadata: { fullTokensEstimate: full, foldedTokensBudget: budget, avoidedTokensEstimate: Math.max(0, full - budget), compressionRatio: Math.max(0, 1 - budget / full), workspaceRootConfigured: !!this.workspaceRoot } }; }); return { success: true, items: rows, metadata: { fileCount: rows.length, returnedTokens: rows.length * 10 } }; }
}

export class CodeOutlineTool implements AiTool {
  readonly name = 'code_outline';
  readonly description = 'Return indexed symbols as a deterministic structural outline.';
  readonly inputSchema = { type: 'object', properties: { path: { type: 'string' }, fileId: { type: 'string' }, includeRanges: { type: 'boolean' }, compact: { type: 'boolean', description: 'Return only name, kind, lines and signature per symbol (about a third of the tokens).' } }, anyOf: [{ required: ['path'] }, { required: ['fileId'] }] };
  constructor(private readonly reader: ProjectIndexReader) {}
  async execute(input: AiToolInput): Promise<AiToolOutput> {
    const file = fileOf(this.reader, input); if (!file) return fail('NOT_FOUND: source file');
    const symbols = [...this.reader.getSymbolsForFile(file.id)].sort((a, b) => a.line - b.line || a.endLine - b.endLine || a.name.localeCompare(b.name));
    if (input.compact === true) {
      const items = symbols.map(s => ({ id: s.id, name: s.name, kind: s.kind, path: file.path, line: s.line, source: 'compact', excerpt: s.signature ?? s.name, metadata: { endLine: s.endLine } }));
      return { success: true, items, metadata: { returnedTokens: symbols.reduce((n, s) => n + tokens(s.signature ?? s.name), 0), truncated: false, compact: true } };
    }
    return { success: true, items: symbols.map((s, ordinal) => ({ id: s.id, name: s.name, kind: s.kind, path: file.path, line: s.line, source: s.source, excerpt: s.signature ?? s.name, metadata: { symbolKey: `${file.path}::${sanitizeKeyPart(s.fullyQualifiedName ?? s.name)}::${sanitizeKeyPart(s.kind)}${symbols.filter(x => x.name === s.name && x.kind === s.kind).length > 1 ? `#${ordinal}` : ''}`, endLine: s.endLine, ...(input.includeRanges === false ? {} : { range: { startLine: s.line, endLine: s.endLine } }), partial: false, confidence: s.confidence } })), metadata: { returnedTokens: symbols.reduce((n, s) => n + tokens(s.signature ?? s.name), 0), truncated: false } };
  }
}

export class SymbolFindTool implements AiTool {
  readonly name = 'symbol_find';
  readonly description = 'Find indexed symbols by exact or case-insensitive name, deterministically.';
  readonly inputSchema = { type: 'object', properties: { query: { type: 'string', minLength: 1 }, kind: { type: 'string' }, path: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 1000 } }, required: ['query'] };
  constructor(private readonly reader: ProjectIndexReader) {}
  async execute(input: AiToolInput): Promise<AiToolOutput> {
    const query = typeof input.query === 'string' ? input.query.trim().toLowerCase() : ''; if (!query) return fail('INVALID_ARGUMENT: query is required');
    const kind = typeof input.kind === 'string' ? input.kind : undefined; const pathFilter = typeof input.path === 'string' ? this.reader.getFileByPath(input.path)?.id : undefined;
    const limit = typeof input.limit === 'number' ? input.limit : 100;
    const symbols = [...this.reader.getAllSymbols()].filter(s => s.name.toLowerCase().includes(query) && (!kind || s.kind === kind) && (!pathFilter || s.fileId === pathFilter)).sort((a, b) => a.name.localeCompare(b.name) || a.fileId.localeCompare(b.fileId) || a.line - b.line); const limited = symbols.slice(0, limit);
    return { success: true, items: limited.map(s => { const f = this.reader.getFileById(s.fileId); return { id: s.id, name: s.name, kind: s.kind, path: f?.path, line: s.line, source: s.source, excerpt: s.signature ?? s.name, metadata: { endLine: s.endLine, confidence: s.confidence } }; }), metadata: { returnedTokens: limited.reduce((n, s) => n + tokens(s.name), 0), truncated: symbols.length > limit, matchCount: symbols.length, limit } };
  }
}

export class DiagnosticsGetTool implements AiTool {
  readonly name = 'diagnostics_get'; readonly description = 'Return indexed diagnostics without claiming an unrun pass is clean.';
  readonly inputSchema = { type: 'object', properties: { path: { type: 'string' }, severity: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 10000 } } };
  constructor(private readonly reader: ProjectIndexReader) {}
  async execute(input: AiToolInput): Promise<AiToolOutput> { const file = typeof input.path === 'string' ? this.reader.getFileByPath(input.path) : undefined; const rows = file ? (file.diagnostics ?? []) : this.reader.projectIndex.diagnostics; const severity = typeof input.severity === 'string' ? input.severity : undefined; const selected = rows.filter(d => !severity || d.severity === severity).slice(0, typeof input.limit === 'number' ? input.limit : 1000); const note = !this.reader.projectIndex.diagnosticsRun ? 'diagnostics pass was not recorded; empty does not mean clean' : undefined; return { success: true, items: selected.map((d, i) => ({ id: `${file?.id ?? 'project'}:${i}:${d.line}`, name: d.message, kind: 'diagnostic', path: file?.path, line: d.line, source: d.source, excerpt: d.message, metadata: { severity: d.severity, code: d.code, column: d.column } })), metadata: { ...(note ? { warning: note } : {}), diagnosticsRun: this.reader.projectIndex.diagnosticsRun } }; }
}
