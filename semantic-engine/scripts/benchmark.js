#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const fixture = path.join(root, 'test-fixture');
const benchmarkRoot = process.env.SEMANTIC_BENCHMARK_ROOT
  ? path.resolve(process.env.SEMANTIC_BENCHMARK_ROOT)
  : fixture;
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-benchmark-'));
const maxMs = Number(process.env.SEMANTIC_BENCHMARK_MAX_MS || 30_000);

try {
  if (!fs.existsSync(benchmarkRoot)) {
    if (benchmarkRoot !== fixture) {
      throw new Error(`benchmark root does not exist: ${benchmarkRoot}`);
    }
    execFileSync(process.execPath, [path.join(__dirname, 'gen-fixture.js')], { cwd: root, stdio: 'inherit' });
  }

  const started = performance.now();
  execFileSync(process.execPath, [
    path.join(__dirname, 'run-pipeline.js'),
    benchmarkRoot,
    output,
  ], { cwd: root, stdio: 'inherit' });
  const durationMs = Math.round(performance.now() - started);
  const index = JSON.parse(fs.readFileSync(path.join(output, 'project-index.json'), 'utf8'));
  const files = Array.isArray(index.files) ? index.files.length : 0;
  const symbols = Array.isArray(index.symbols) ? index.symbols.length : 0;

  console.log(JSON.stringify({ root: benchmarkRoot, durationMs, files, symbols, maxMs }));
  if (durationMs > maxMs) {
    console.error(`benchmark exceeded ${maxMs}ms: ${durationMs}ms`);
    process.exitCode = 1;
  }
} finally {
  fs.rmSync(output, { recursive: true, force: true });
}
