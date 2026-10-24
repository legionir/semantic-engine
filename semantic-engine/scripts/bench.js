#!/usr/bin/env node
'use strict';

/*
| Performance baseline
| --------------------
|   node scripts/bench.js            measure, print JSON
|   node scripts/bench.js --write    also write bench/baseline.json
|   node scripts/bench.js --check    compare with bench/baseline.json (fails on regression)
|
| Corpus: this package's own `src/` (override: SEMANTIC_BENCH_ROOT). Everything
| runs against dist/, so `npm run build` first. Each metric is the median of N
| runs (default 3, SEMANTIC_BENCH_RUNS) with the min..max spread recorded.
| Wall-clock numbers depend on the machine; the check therefore uses a wide
| tolerance (SEMANTIC_BENCH_TOLERANCE, default 0.35) and ignores sub-50 ms noise.
*/

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const BASELINE = path.join(ROOT, 'bench', 'baseline.json');
const RUNS = Number(process.env.SEMANTIC_BENCH_RUNS || 3);
const TOLERANCE = Number(process.env.SEMANTIC_BENCH_TOLERANCE || 0.35);
const corpus = process.env.SEMANTIC_BENCH_ROOT
  ? path.resolve(process.env.SEMANTIC_BENCH_ROOT)
  : path.join(ROOT, 'src');

const QUERIES = [
  'fix a timeout bug in the language server client',
  'how are call graph edges built',
  'where is the config file loaded',
  'http request body size limit',
  'incremental re-index after a file changes',
  'embedding model download',
  'blueprint module dependency graph',
  'git history hotspot scoring',
  'json export of the project index',
  'symbol extraction with tree-sitter',
];

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return { median: Math.round(median * 10) / 10, min: Math.round(sorted[0] * 10) / 10, max: Math.round(sorted[sorted.length - 1] * 10) / 10 };
}

/* One CLI run in a child process so RSS is that of the run alone. */
function cliIndex(out, extra = []) {
  const started = process.hrtime.bigint();
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, 'bin', 'semantic-engine.js'), 'index', '--root', corpus, '--out', out, '--no-git', '--data-dir', path.join(out, '.data'), '--project-id', 'prj-bench-12345678', ...extra],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, SEMANTIC_ENGINE_LOG_LEVEL: 'error' } }
  );
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  if (result.status !== 0) throw new Error(`index failed: ${result.stderr || result.stdout}`);
  return ms;
}

/* Peak RSS of an in-process index, measured in a fresh child. */
function peakRss(out) {
  const code = `
    const { runIndex } = require(${JSON.stringify(path.join(DIST, 'cli/commands/index-command'))});
    const { parseArgs } = require(${JSON.stringify(path.join(DIST, 'cli/args'))});
    const { silentLogger } = require(${JSON.stringify(path.join(DIST, 'host/Logger'))});
    let peak = 0; const t = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 20);
    runIndex(parseArgs(['index','--root',${JSON.stringify(corpus)},'--out',${JSON.stringify(out)},'--no-git','--data-dir',${JSON.stringify(path.join(out, '.data'))},'--project-id','prj-bench-12345678']),
      { cwd: ${JSON.stringify(ROOT)}, logger: silentLogger }).then(r => { clearInterval(t); peak = Math.max(peak, process.memoryUsage().rss); console.log(JSON.stringify({ code: r.code, peak })); });`;
  const result = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' });
  const line = result.stdout.trim().split('\n').pop();
  return JSON.parse(line).peak / (1024 * 1024);
}

async function main() {
  if (!fs.existsSync(path.join(DIST, 'cli/commands/index-command.js'))) {
    console.error('dist/ missing - run "npm run build" first');
    process.exit(2);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'se-bench-'));
  try {
    const cold = [];
    const warm = [];
    for (let i = 0; i < RUNS; i++) {
      const out = path.join(tmp, `run-${i}`);
      cold.push(cliIndex(out));
      warm.push(cliIndex(out)); // second run over the same output: previous index present
    }

    const out = path.join(tmp, 'run-0');
    const indexFile = fs.readdirSync(out).find(f => f.endsWith('project-index.json')) || 'project-index.json';
    const located = findFile(out, 'project-index.json');
    const index = JSON.parse(fs.readFileSync(located, 'utf8'));
    const indexBytes = fs.statSync(located).size;

    const { ProjectIndexReader } = require(path.join(DIST, 'ai/ProjectIndexReader'));
    const { ContextDiscoverer } = require(path.join(DIST, 'ai/discovery/ContextDiscoverer'));
    const loadStart = process.hrtime.bigint();
    const reader = new ProjectIndexReader(index);
    const loadMs = Number(process.hrtime.bigint() - loadStart) / 1e6;
    const discoverer = new ContextDiscoverer(reader);
    await discoverer.discover({ task: QUERIES[0] }); // warm JIT/caches, not measured
    const latencies = [];
    for (let round = 0; round < Math.max(RUNS, 3); round++) {
      for (const task of QUERIES) {
        const s = process.hrtime.bigint();
        await discoverer.discover({ task });
        latencies.push(Number(process.hrtime.bigint() - s) / 1e6);
      }
    }
    latencies.sort((a, b) => a - b);

    const result = {
      version: 1,
      corpus: path.relative(ROOT, corpus) || '.',
      files: index.files.length,
      symbols: index.symbols.length,
      node: process.version,
      cpus: os.cpus().length,
      runs: RUNS,
      metrics: {
        indexColdMs: stats(cold),
        indexWarmMs: stats(warm),
        indexPeakRssMb: { median: Math.round(peakRss(path.join(tmp, 'rss'))) },
        indexFileMb: { median: Math.round((indexBytes / (1024 * 1024)) * 100) / 100 },
        readerLoadMs: { median: Math.round(loadMs * 10) / 10 },
        discoverP50Ms: { median: Math.round(latencies[Math.floor(latencies.length * 0.5)] * 10) / 10 },
        discoverP95Ms: { median: Math.round(latencies[Math.floor(latencies.length * 0.95)] * 10) / 10 },
      },
    };
    void indexFile;
    console.log(JSON.stringify(result, null, 2));

    if (process.argv.includes('--write')) {
      fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
      fs.writeFileSync(BASELINE, JSON.stringify(result, null, 2) + '\n');
      console.error(`baseline written: ${path.relative(ROOT, BASELINE)}`);
    }
    if (process.argv.includes('--check')) {
      const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
      let failed = false;
      for (const [name, now] of Object.entries(result.metrics)) {
        const was = base.metrics[name];
        if (!was) continue;
        const allowed = was.median * (1 + TOLERANCE) + (name.endsWith('Ms') ? 50 : 0);
        const ok = now.median <= allowed;
        console.error(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${now.median} (baseline ${was.median}, limit ${Math.round(allowed * 10) / 10})`);
        if (!ok) failed = true;
      }
      if (failed) process.exitCode = 1;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(full, name);
      if (hit) return hit;
    } else if (entry.name === name) return full;
  }
  return null;
}

main().catch(error => { console.error(error); process.exit(1); });
