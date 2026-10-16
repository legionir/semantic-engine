import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { isInside } from '../contracts/fileProvider';

export interface TextEdit { readonly path: string; readonly start: number; readonly end: number; readonly replacement: string; readonly expectedHash: string; }
export interface EditOperation extends TextEdit { readonly original: string; readonly updated: string; }
export interface EditPlan { readonly id: string; readonly createdAt: string; readonly workspaceRoot: string; readonly edits: readonly EditOperation[]; readonly diff: string; readonly source: 'structural-search' | 'client'; readonly approved: boolean; }
export interface TransactionRecord { readonly transactionId: string; readonly status: 'applied' | 'rolled_back'; readonly plan: EditPlan; readonly originals: readonly { path: string; content: string; hash: string }[]; readonly after: readonly { path: string; hash: string }[]; readonly updatedAt: string; }
export interface Validator { readonly id: string; readonly validate: (paths: readonly string[]) => Promise<{ ok: boolean; message?: string }>; }

/** Host-owned unsaved buffers. They are never persisted by this class. */
export class OverlayStore {
  private readonly buffers = new Map<string, string>();
  set(relativePath: string, content: string): void { this.buffers.set(relativePath, content); }
  get(relativePath: string): string | undefined { return this.buffers.get(relativePath); }
  delete(relativePath: string): void { this.buffers.delete(relativePath); }
  clear(): void { this.buffers.clear(); }
}

export class TransactionalEditEngine {
  private readonly approved = new Set<string>();
  private readonly plans = new Map<string, EditPlan>();
  constructor(private readonly workspaceRoot: string, private readonly journalDirectory = '.semantic-engine/transactions', private readonly validators: readonly Validator[] = [], private readonly overlay?: OverlayStore) {}

  async plan(edits: readonly TextEdit[], source: EditPlan['source'] = 'client'): Promise<EditPlan> {
    if (!edits.length) throw new Error('edit plan must contain at least one edit');
    const grouped = new Map<string, TextEdit[]>();
    for (const edit of edits) { this.assertPath(edit.path); if (!Number.isInteger(edit.start) || !Number.isInteger(edit.end) || edit.start < 0 || edit.end < edit.start) throw new Error(`invalid edit range for ${edit.path}`); const list = grouped.get(edit.path) ?? []; list.push(edit); grouped.set(edit.path, list); }
    const operations: EditOperation[] = [];
    for (const [relativePath, fileEdits] of [...grouped.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      const absolute = this.absolute(relativePath); const current = this.overlay?.get(relativePath) ?? await fs.readFile(absolute, 'utf8'); const actualHash = hash(current); const expected = fileEdits[0].expectedHash;
      if (expected !== actualHash) throw new Error(`STALE_HANDLE: ${relativePath}`);
      const sorted = [...fileEdits].sort((a, b) => b.start - a.start || b.end - a.end); let updated = current;
      let lastStart = Number.MAX_SAFE_INTEGER;
      for (const edit of sorted) { if (edit.end > lastStart) throw new Error(`overlapping edits: ${relativePath}`); if (edit.end > current.length) throw new Error(`OUT_OF_RANGE: ${relativePath}`); updated = updated.slice(0, edit.start) + edit.replacement + updated.slice(edit.end); lastStart = edit.start; operations.push({ ...edit, original: current.slice(edit.start, edit.end), updated: edit.replacement }); }
      if (updated === current) throw new Error(`empty edit: ${relativePath}`);
    }
    const id = crypto.randomUUID(); const plan: EditPlan = { id, createdAt: new Date().toISOString(), workspaceRoot: this.workspaceRoot, edits: operations, diff: unifiedDiff(operations), source, approved: false }; this.plans.set(id, plan); return plan;
  }

  approve(planId: string): string { if (!this.plans.has(planId)) throw new Error('plan not found'); this.approved.add(planId); return `approval:${planId}`; }

  async apply(planId: string, approvalToken: string): Promise<TransactionRecord> {
    const plan = this.plans.get(planId); if (!plan) throw new Error('plan not found'); if (!this.approved.has(planId) || approvalToken !== `approval:${planId}`) throw new Error('APPROVAL_REQUIRED');
    const paths = [...new Set(plan.edits.map(e => e.path))].sort(); const originals: { path: string; content: string; hash: string }[] = [];
    for (const relativePath of paths) { const content = await fs.readFile(this.absolute(relativePath), 'utf8'); const expected = plan.edits.find(e => e.path === relativePath)?.expectedHash; if (hash(content) !== expected) throw new Error(`STALE_SNAPSHOT: ${relativePath}`); originals.push({ path: relativePath, content, hash: hash(content) }); }
    for (const validator of this.validators) { const result = await validator.validate(paths); if (!result.ok) throw new Error(`VALIDATION_FAILED:${validator.id}:${result.message ?? 'rejected'}`); }
    const byFile = new Map<string, EditOperation[]>(); for (const edit of plan.edits) (byFile.get(edit.path) ?? (byFile.set(edit.path, []), byFile.get(edit.path)!)).push(edit);
    try { for (const [relativePath, edits] of byFile) { const absolute = this.absolute(relativePath); const original = originals.find(x => x.path === relativePath)!.content; const updated = applyEdits(original, edits); await atomicWrite(absolute, updated); } }
    catch (error) { for (const original of originals) await atomicWrite(this.absolute(original.path), original.content); throw error; }
    const after: { path: string; hash: string }[] = [];
    for (const relativePath of paths) after.push({ path: relativePath, hash: hash(await fs.readFile(this.absolute(relativePath), 'utf8')) });
    const record: TransactionRecord = { transactionId: plan.id, status: 'applied', plan: { ...plan, approved: true }, originals, after, updatedAt: new Date().toISOString() }; await this.writeJournal(record); return record;
  }

  async rollback(transactionId: string): Promise<TransactionRecord> {
    const record = await this.readJournal(transactionId);
    if (!Array.isArray((record as { after?: unknown }).after)) throw new Error(`UNDO_CONFLICT: ${transactionId} has no verifiable after-state`);
    for (const original of record.originals) {
      const expected = record.after.find(a => a.path === original.path)?.hash;
      let current: string;
      try { current = await fs.readFile(this.absolute(original.path), 'utf8'); }
      catch { throw new Error(`UNDO_CONFLICT: ${original.path} is missing or unreadable`); }
      if (expected === undefined || hash(current) !== expected) throw new Error(`UNDO_CONFLICT: ${original.path} changed since apply`);
    }
    for (const original of record.originals) await atomicWrite(this.absolute(original.path), original.content);
    const rolled: TransactionRecord = { ...record, status: 'rolled_back', updatedAt: new Date().toISOString() }; await this.writeJournal(rolled); return rolled;
  }
  async undo(transactionId: string): Promise<TransactionRecord> { return this.rollback(transactionId); }
  async recover(): Promise<readonly TransactionRecord[]> { try { const names = (await fs.readdir(this.absolute(this.journalDirectory))).filter(n => n.endsWith('.json')).sort(); const records: TransactionRecord[] = []; for (const name of names) records.push(JSON.parse(await fs.readFile(path.join(this.absolute(this.journalDirectory), name), 'utf8')) as TransactionRecord); return records; } catch { return []; } }

  private assertPath(relativePath: string): void { if (!relativePath || relativePath.includes('\\') || path.posix.isAbsolute(relativePath) || relativePath.split('/').includes('..') || relativePath.split('/').includes('.')) throw new Error(`DENIED: invalid relative path ${relativePath}`); if (relativePath.startsWith('.env') || /(^|\/)(\.git|node_modules)(\/|$)/u.test(relativePath)) throw new Error(`DENIED: protected path ${relativePath}`); if (!isInside(path.resolve(this.workspaceRoot), this.absolute(relativePath))) throw new Error(`DENIED: path escape ${relativePath}`); }
  private absolute(relativePath: string): string { return path.resolve(this.workspaceRoot, relativePath); }
  private async writeJournal(record: TransactionRecord): Promise<void> { const directory = this.absolute(this.journalDirectory); await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, `${record.transactionId}.json`), JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 }); }
  private async readJournal(id: string): Promise<TransactionRecord> { if (!/^[0-9a-f-]{36}$/u.test(id)) throw new Error('invalid transaction id'); return JSON.parse(await fs.readFile(path.join(this.absolute(this.journalDirectory), `${id}.json`), 'utf8')) as TransactionRecord; }
}

function hash(text: string): string { return crypto.createHash('sha256').update(text, 'utf8').digest('hex'); }
function applyEdits(original: string, edits: readonly EditOperation[]): string { return [...edits].sort((a, b) => b.start - a.start).reduce((text, edit) => text.slice(0, edit.start) + edit.replacement + text.slice(edit.end), original); }
async function atomicWrite(target: string, content: string): Promise<void> { const temp = `${target}.semantic-engine-${crypto.randomUUID()}.tmp`; await fs.writeFile(temp, content, { encoding: 'utf8', mode: 0o600 }); await fs.rename(temp, target); }
function unifiedDiff(edits: readonly EditOperation[]): string { return edits.map(e => `--- a/${e.path}\n+++ b/${e.path}\n@@ ${e.start},${e.end - e.start} @@\n-${e.original}\n+${e.replacement}`).join('\n'); }
export function contentHash(content: string): string { return hash(content); }
