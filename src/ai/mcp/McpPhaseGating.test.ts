/**
 * MCP gating for Phase 2/3/4 — fail-closed by default, explicit opt-in.
 *
 * Default server: experimental tools are unlisted and edit tools refuse with
 * DISABLED. Opt-in server (enablePhase2Edits + experimental flags): the full
 * mutation path runs over `tools/call` — structural_search → edit_plan →
 * edit_approve → edit_apply → edit_rollback — with byte-level verification,
 * repeated apply is honestly rejected (mutation results are never cached),
 * and Phase 3/4 experimental tools execute.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SemanticEngineMcpServer } from './SemanticEngineMcpServer';
import { ProjectIndex } from '../../core/types/project-index.types';
import { makeConfidence } from '../../core/types/common.types';
import { contentHash } from '../../core/codeintel/Phase2Transactions';

const A_TS = 'import { add } from "./b";\nexport const total = add(1, 2);\n';
const B_TS = 'export function add(a: number, b: number) {\n  return a + b;\n}\n';
const C_PY = 'x = 1\n';

function createIndex(rootPath: string): ProjectIndex {
  return {
    schemaVersion: '2.0.0',
    root: 'gate-fixture',
    rootPath,
    generatedAt: '2026-01-01T00:00:00.000Z',
    languages: ['typescript'],
    files: [
      { id: 'fa', path: 'src/a.ts', language: 'typescript', encoding: 'utf8', size: A_TS.length, lines: 2, hash: contentHash(A_TS), modified: '2026-01-01T00:00:00.000Z', binary: false, testFile: false, generated: false },
      { id: 'fb', path: 'src/b.ts', language: 'typescript', encoding: 'utf8', size: B_TS.length, lines: 3, hash: contentHash(B_TS), modified: '2026-01-01T00:00:00.000Z', binary: false, testFile: false, generated: false },
      { id: 'fc', path: 'src/c.php', language: 'php', encoding: 'utf8', size: C_PY.length, lines: 1, hash: contentHash(C_PY), modified: '2026-01-01T00:00:00.000Z', binary: false, testFile: false, generated: false },
    ],
    symbols: [
      { id: 's-add', fileId: 'fb', parentId: null, kind: 'function', name: 'add', fullyQualifiedName: 'add', line: 1, endLine: 3, signature: 'function add(a: number, b: number)', source: 'tree-sitter', confidence: makeConfidence(100), exported: true },
      { id: 's-total', fileId: 'fa', parentId: null, kind: 'variable', name: 'total', fullyQualifiedName: 'total', line: 2, endLine: 2, source: 'tree-sitter', confidence: makeConfidence(100), exported: true },
    ],
    graphs: { callGraph: [], typeGraph: [], dependencyGraph: [] },
    diagnostics: [],
    metrics: { totalFiles: 3, totalLoc: 6, totalSymbols: 2, avgCyclomaticComplexity: 1, languageBreakdown: { typescript: 2, python: 1 } },
  } as ProjectIndex;
}

function payload(result: { content: unknown }): any {
  const text = (result.content as { text: string }[])[0].text;
  return JSON.parse(text);
}

describe('MCP Phase 2/3/4 gating', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'se-mcp-gate-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), A_TS, 'utf8');
    fs.writeFileSync(path.join(root, 'src', 'b.ts'), B_TS, 'utf8');
    fs.writeFileSync(path.join(root, 'src', 'c.php'), C_PY, 'utf8');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('fails closed by default: experimental tools unlisted, edits DISABLED', async () => {
    const server = new SemanticEngineMcpServer({ projectIndex: createIndex(root), workspaceRoot: root });
    try {
      const refs = await server.callTool('symbol_references', { symbolId: 's-add' });
      expect(refs.isError).toBe(true);
      expect(payload(refs).error).toContain('not found');

      const impact = await server.callTool('impact_analyze_v4', { symbolId: 's-add' });
      expect(impact.isError).toBe(true);
      expect(payload(impact).error).toContain('not found');

      const apply = await server.callTool('edit_apply', { planId: 'x', approvalToken: 'y' });
      expect(apply.isError).toBe(true);
      expect(payload(apply).error).toContain('DISABLED');
    } finally {
      await server.close();
    }
  });

  it('runs the Phase 2 mutation path over tools/call with byte verification', async () => {
    const server = new SemanticEngineMcpServer({
      projectIndex: createIndex(root),
      workspaceRoot: root,
      enablePhase2Edits: true,
    });
    try {
      const search = await server.callTool('structural_search', { pattern: 'add($A, $B)', language: 'typescript', path: 'src/a.ts' });
      expect(search.isError).toBe(false);
      expect(payload(search).items).toHaveLength(1);

      const current = fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf8');
      const start = current.indexOf('add(1, 2)');
      const plan = await server.callTool('edit_plan', {
        edits: [{ path: 'src/a.ts', start, end: start + 'add(1, 2)'.length, replacement: 'add(3, 4)', expectedHash: contentHash(current) }],
      });
      expect(plan.isError).toBe(false);
      const planId = payload(plan).items[0].metadata.planId as string;
      // Dry-run preview must not touch the file.
      expect(fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf8')).toBe(A_TS);

      const approve = await server.callTool('edit_approve', { planId });
      expect(approve.isError).toBe(false);
      const approvalToken = (payload(approve).metadata as { approvalToken: string }).approvalToken;

      const apply = await server.callTool('edit_apply', { planId, approvalToken });
      expect(apply.isError).toBe(false);
      const transactionId = (payload(apply).metadata as { transactionId: string }).transactionId;
      expect(fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf8')).toBe(A_TS.replace('add(1, 2)', 'add(3, 4)'));
      expect(fs.existsSync(path.join(root, '.semantic-engine', 'transactions', `${transactionId}.json`))).toBe(true);

      // A repeated apply must be honestly rejected, not served from cache.
      const replay = await server.callTool('edit_apply', { planId, approvalToken });
      expect(replay.isError).toBe(true);
      expect(payload(replay).error).toContain('STALE_SNAPSHOT');

      const statusApplied = await server.callTool('edit_status', { transactionId });
      expect(statusApplied.isError).toBe(false);
      expect(payload(statusApplied).items[0].metadata.status).toBe('applied');

      const rollback = await server.callTool('edit_rollback', { transactionId });
      expect(rollback.isError).toBe(false);
      expect(fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf8')).toBe(A_TS);

      const statusRolled = await server.callTool('edit_status', { transactionId });
      expect(statusRolled.isError).toBe(false);
      expect(payload(statusRolled).items[0].metadata.status).toBe('rolled_back');
    } finally {
      await server.close();
    }
  });

  it('ignores client-supplied validator/command fields: validators are host-only', async () => {
    const server = new SemanticEngineMcpServer({
      projectIndex: createIndex(root),
      workspaceRoot: root,
      enablePhase2Edits: true,
    });
    try {
      const current = fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf8');
      const plan = await server.callTool('edit_plan', {
        edits: [{ path: 'src/a.ts', start: 0, end: 0, replacement: '// note\n', expectedHash: contentHash(current) }],
        validator: 'rm -rf /',
        cmd: 'evil',
      } as Record<string, unknown> as { edits: unknown });
      expect(plan.isError).toBe(false);
      expect(payload(plan).items[0].metadata.readOnlyPreview).toBe(true);
      expect(fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf8')).toBe(A_TS);
    } finally {
      await server.close();
    }
  });

  it('runs rule packs on the ast-grep engine and fails rules honestly (F-11)', async () => {
    const server = new SemanticEngineMcpServer({
      projectIndex: createIndex(root),
      workspaceRoot: root,
    });
    try {
      const pack = JSON.stringify({ rules: [{ id: 'r-add', language: 'typescript', pattern: 'add($A, $B)', message: 'add call' }] });
      const ok = await server.callTool('structural_rule_test', { rules: pack, path: 'src/a.ts' });
      expect(ok.isError).toBe(false);
      const body = payload(ok);
      expect(body.items).toHaveLength(1);
      expect(body.items[0].kind).toBe('rule:warning');
      expect(body.metadata.passed).toBe(false);

      // A rule the engine cannot execute must FAIL, never report passed:true.
      const pyPack = JSON.stringify({ rules: [{ id: 'r-py', language: 'php', pattern: 'x', message: 'py' }] });
      const bad = await server.callTool('structural_rule_test', { rules: pyPack, path: 'src/c.php' });
      expect(bad.isError).toBe(true);
      expect(payload(bad).error).toContain('UNSUPPORTED_LANGUAGE');
      expect(payload(bad).error).not.toContain('INVALID_RULE_PACK');

      const search = await server.callTool('structural_search', { pattern: 'x', language: 'php', path: 'src/c.php' });
      expect(search.isError).toBe(true);
      expect(payload(search).error).toContain('UNSUPPORTED_LANGUAGE');
    } finally {
      await server.close();
    }
  });

  it('exposes Phase 3/4 experimental tools only with explicit flags', async () => {
    const server = new SemanticEngineMcpServer({
      projectIndex: createIndex(root),
      workspaceRoot: root,
      experimental: { 'semantic-graph': true, 'controlled-expansion': true },
    });
    try {
      const refs = await server.callTool('symbol_references', { symbolId: 's-add' });
      expect(refs.isError).toBe(false);
      const body = payload(refs);
      expect(body.items.length).toBeGreaterThan(0);
      expect(body.items[0].metadata.confidence).toBe('exact');
      expect(body.metadata.trust).toBe('untrusted-source-content');

      const status = await server.callTool('provider_status', { languages: ['typescript', 'cobol'] });
      expect(status.isError).toBe(false);
      const rows = payload(status).items as { id: string; metadata: { status: string } }[];
      expect(rows.find(r => r.id === 'typescript')?.metadata.status).toBe('degraded');
      expect(rows.find(r => r.id === 'cobol')?.metadata.status).toBe('unavailable');

      // Rename planning is approval-gated: without enablePhase2Edits the tool
      // is not even registered.
      const rename = await server.callTool('semantic_rename_v4', { symbolId: 's-add', replacement: 'sum' });
      expect(rename.isError).toBe(true);
      expect(payload(rename).error).toContain('not found');
    } finally {
      await server.close();
    }
  });
});
