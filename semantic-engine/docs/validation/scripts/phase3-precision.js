#!/usr/bin/env node
'use strict';
/* Gate evidence: Phase 3 pilot precision on a gold micro-fixture.
 * Gold: 2 exact references (unique imports used outside the import),
 * 1 ambiguous case (two files exporting the same name both imported? no —
 * same-name exports in two candidate targets), 1 unresolved import.
 * Measures: exact-class precision, unresolved retention. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ProjectIndexReader } = require('../../../dist/ai/ProjectIndexReader');
const { Phase3SemanticGraphPilot } = require('../../../dist/core/codeintel/Phase3SemanticGraph');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'se-p3gold-'));
try {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const files = {
    'src/math.ts': 'export function add(a: number, b: number) { return a + b; }\nexport function sub(a: number, b: number) { return a - b; }\n',
    'src/other.ts': 'export function add(x: string): string { return x; }\n',
    'src/use.ts': 'import { add } from "./math";\nimport { missing } from "./absent";\nconst r1 = add(1, 2);\nconst r2 = add(3, 4);\nmissing();\n',
  };
  for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(root, rel), text, 'utf8');
  const sha = t => require('crypto').createHash('sha256').update(t, 'utf8').digest('hex');
  const index = {
    schemaVersion: '2.0.0', root: 'gold', rootPath: root, generatedAt: '2026-01-01T00:00:00.000Z',
    languages: ['typescript'],
    files: [
      { id: 'f-math', path: 'src/math.ts', language: 'typescript', encoding: 'utf8', size: 1, lines: 2, hash: sha(files['src/math.ts']), modified: '2026-01-01T00:00:00Z', binary: false, testFile: false, generated: false },
      { id: 'f-other', path: 'src/other.ts', language: 'typescript', encoding: 'utf8', size: 1, lines: 1, hash: sha(files['src/other.ts']), modified: '2026-01-01T00:00:00Z', binary: false, testFile: false, generated: false },
      { id: 'f-use', path: 'src/use.ts', language: 'typescript', encoding: 'utf8', size: 1, lines: 5, hash: sha(files['src/use.ts']), modified: '2026-01-01T00:00:00Z', binary: false, testFile: false, generated: false },
    ],
    symbols: [
      { id: 's-add-math', fileId: 'f-math', parentId: null, kind: 'function', name: 'add', fullyQualifiedName: 'add', line: 1, endLine: 1, source: 'x', confidence: 100, exported: true },
      { id: 's-sub', fileId: 'f-math', parentId: null, kind: 'function', name: 'sub', fullyQualifiedName: 'sub', line: 2, endLine: 2, source: 'x', confidence: 100, exported: true },
      { id: 's-add-other', fileId: 'f-other', parentId: null, kind: 'function', name: 'add', fullyQualifiedName: 'add', line: 1, endLine: 1, source: 'x', confidence: 100, exported: true },
    ],
    graphs: { callGraph: [], typeGraph: [], dependencyGraph: [] }, diagnostics: [],
    metrics: { totalFiles: 3, totalLoc: 8, totalSymbols: 3, avgCyclomaticComplexity: 1, languageBreakdown: { typescript: 3 } },
  };
  (async () => {
    const pilot = new Phase3SemanticGraphPilot(new ProjectIndexReader(index), root);
    const graph = await pilot.build();
    // Gold expectation: add(1,2) and add(3,4) both resolve exact to s-add-math
    // (unique export 'add' in the resolved target file src/math.ts); the
    // same-name export in src/other.ts must NOT poison it; './absent' stays
    // unresolved and retained.
    const exact = graph.references.filter(r => r.provenance.confidence === 'exact');
    const correctExact = exact.filter(r => r.targetSymbolId === 's-add-math').length;
    const exactPrecision = exact.length ? correctExact / exact.length : 1;
    const unresolvedRetained = graph.unresolved.filter(u => u.name === 'missing').length;
    const incremental = await pilot.buildIncremental(graph, ['src/use.ts']);
    const report = {
      references: graph.references.length,
      exact: exact.length,
      correctExact,
      exactPrecision,
      unresolved: graph.unresolved.length,
      unresolvedRetained,
      fileDeps: graph.fileDeps.length,
      incrementalEqualsFull: JSON.stringify(incremental) === JSON.stringify(graph),
      threshold: 0.95,
      pass: exactPrecision >= 0.95 && unresolvedRetained >= 1 && graph.references.length === 2,
    };
    console.log(JSON.stringify(report, null, 2));
    if (!report.pass) process.exit(1);
  })().catch(e => { console.error(e); process.exit(1); });
} finally {
  // cleaned after async work finishes via process exit ordering; keep dir on failure
  process.on('exit', code => { if (code === 0) fs.rmSync(root, { recursive: true, force: true }); });
}
