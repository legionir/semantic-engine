#!/usr/bin/env node
'use strict';
/* Gate evidence: Phase 4 benchmark + Phase 1 fold/unfold checks on a REAL
 * pipeline-built index of test-fixture (402-line file included).
 * Usage: node docs/validation/scripts/phase4-bench.js
 * Exit 0 only if: budget respected, determinism holds, unfold reconstructs
 * byte-identical lines, and fold-L2 compression is reported (threshold 0.60,
 * blocking per Appendix B). */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..', '..');
const WORKSPACE = path.join(ROOT, 'test-fixture');

async function main() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'se-bench-'));
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'run-pipeline.js'), WORKSPACE, out], { cwd: ROOT, stdio: 'pipe' });
    const index = JSON.parse(fs.readFileSync(path.join(out, 'project-index.json'), 'utf8'));
    const { ProjectIndexReader } = require('../../../dist/ai/ProjectIndexReader');
    const { AiToolRegistry } = require('../../../dist/ai/AiToolRegistry');
    const reader = new ProjectIndexReader(index);
    const registry = new AiToolRegistry({
      reader, workspaceRoot: WORKSPACE, projectHash: index.generatedAt,
      experimental: { 'semantic-graph': true, 'controlled-expansion': true },
    });
    const rss = () => process.memoryUsage().rss;
    const report = {
      files: index.files.length, symbols: index.symbols.length,
      rssBefore: rss(),
    };
    const time = async (label, fn) => {
      const t0 = performance.now();
      const value = await fn();
      report[`${label}Ms`] = Math.round((performance.now() - t0) * 100) / 100;
      return value;
    };

    // Phase 4: impact + context over the real index.
    const seedSymbol = index.symbols.find(s => s.name && s.name.length > 2) || index.symbols[0];
    if (!seedSymbol) throw new Error('fixture index has no symbols');
    await time('impact', () => registry.execute('impact_analyze_v4', { symbolId: seedSymbol.id }));
    report.rssAfterImpact = rss();
    const ctxA = await time('contextBuild', () => registry.execute('context_build_v4', { seed: seedSymbol.name, budgetTokens: 2000, limit: 100 }));
    report.rssAfterContext = rss();
    const ctxB = await registry.execute('context_build_v4', { seed: seedSymbol.name, budgetTokens: 2000, limit: 100 });
    if (!ctxA.success) throw new Error(`context_build failed: ${ctxA.error}`);
    const usedTokens = (ctxA.items || []).reduce((n, i) => n + Math.ceil((i.excerpt || '').length / 4), 0);
    report.contextItems = ctxA.items.length;
    report.contextUsedTokens = usedTokens;
    report.contextBudget = 2000;
    report.contextWithinBudget = usedTokens <= 2000;
    report.contextDeterministic = JSON.stringify(ctxA) === JSON.stringify(ctxB);
    report.contextSnapshotId = ctxA.metadata && ctxA.metadata.snapshotId;
    report.contextOmitted = ctxA.metadata && ctxA.metadata.omittedSummary;

    // Phase 3: references query over the real index (must not crash; honest counts).
    const refs = await time('symbolReferences', () => registry.execute('symbol_references', { symbolId: seedSymbol.id, limit: 50 }));
    report.referencesSuccess = refs.success === true;
    report.referencesCount = refs.success ? refs.items.length : -1;

    // Phase 1: fold L2 on the >200-line file + unfold reconstruction.
    const big = index.files.filter(f => f.lines > 200 && !f.binary).sort((a, b) => b.lines - a.lines)[0];
    if (!big) throw new Error('no >200-line file in fixture index');
    const foldA = await time('foldL2', () => registry.execute('code_fold', { path: big.path, level: 2, maxTokens: 100000 }));
    const foldB = await registry.execute('code_fold', { path: big.path, level: 2, maxTokens: 100000 });
    if (!foldA.success) throw new Error(`code_fold failed: ${foldA.error}`);
    const raw = fs.readFileSync(path.join(WORKSPACE, big.path), 'utf8').replace(/^\uFEFF/, '');
    const rawLines = raw.split('\n').map(l => (l.endsWith('\r') ? l.slice(0, -1) : l));
    if (raw.endsWith('\n')) rawLines.pop();
    const foldedLines = (foldA.items[0].excerpt || '').split('\n');
    const fullTokens = Math.ceil(raw.length / 4);
    const foldedTokens = Math.ceil((foldA.items[0].excerpt || '').length / 4);
    report.foldFile = big.path;
    report.foldLines = rawLines.length;
    report.foldCompression = Math.round((1 - foldedTokens / fullTokens) * 10000) / 10000;
    report.foldThreshold = 0.6;
    report.foldPass = report.foldCompression >= 0.6;
    report.foldTruncated = foldA.items[0].metadata.truncated === true;
    report.foldDeterministic = JSON.stringify(foldA) === JSON.stringify(foldB);
    // Unfold: every elided line re-read via code_read must reproduce the original.
    let offset = 0;
    const offsets = rawLines.map(line => {
      const start = offset;
      offset += line.length + 1; // normalized '\n'; raw may hold '\r' before it
      return start;
    });
    // Recompute exact raw offsets (CRLF-aware).
    const rawParts = raw.split('\n');
    let cursor = 0;
    const exact = rawParts.map(part => { const s = cursor; cursor += part.length + 1; return [s, s + part.length]; });
    let reconstructed = 0;
    for (let i = 0; i < foldedLines.length && i < rawLines.length; i++) {
      const marker = foldedLines[i].match(/^… (\d+)$/);
      if (!marker) {
        if (foldedLines[i] !== rawLines[i]) throw new Error(`kept line ${i + 1} differs`);
        reconstructed++;
        continue;
      }
      const lineNo = Number(marker[1]);
      const [s, e] = exact[lineNo - 1];
      const reread = await registry.execute('code_read', { path: big.path, start: s, end: e });
      if (!reread.success) throw new Error(`code_read failed for line ${lineNo}: ${reread.error}`);
      const text = (reread.items[0].excerpt || '').replace(/\r$/, '');
      if (text !== rawLines[lineNo - 1]) throw new Error(`unfold mismatch at line ${lineNo}`);
      reconstructed++;
    }
    report.unfoldLinesVerified = reconstructed;
    report.unfoldExact = true;

    report.rssPeakSampled = Math.max(report.rssBefore, report.rssAfterImpact, report.rssAfterContext, rss());
    console.log(JSON.stringify(report, null, 2));
    const pass = report.contextWithinBudget && report.contextDeterministic && report.foldDeterministic
      && report.unfoldExact && report.foldPass && !report.foldTruncated && report.referencesSuccess;
    if (!pass) { console.error('BENCH GATE: FAIL'); process.exit(1); }
    console.log('BENCH GATE: PASS');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(`BENCH FAILED: ${error.stack || error}`); process.exit(1); });
