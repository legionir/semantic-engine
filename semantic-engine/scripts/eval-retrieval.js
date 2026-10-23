#!/usr/bin/env node
'use strict';

/*
| Retrieval quality for AI consumers
| ----------------------------------
|   node scripts/eval-retrieval.js            measure, print JSON
|   node scripts/eval-retrieval.js --write    also write eval/baseline.json
|   node scripts/eval-retrieval.js --check    fail when quality drops below eval/baseline.json
|
| Indexes this package's `src/`, then asks every question in eval/queries.json two ways:
|   search   - the keyword `semantic_search` tool alone;
|   discover - ContextDiscoverer (search + blueprint seeds + graph expansion + ranking).
| A question is a hit at k when any expected file is among the first k DISTINCT files of
| the result. Reported: recall@1/3/5/10 and MRR. Deterministic: no network, no model.
*/

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const CORPUS = path.join(ROOT, 'src');
const BASELINE = path.join(ROOT, 'eval', 'baseline.json');
const TOLERANCE = Number(process.env.SEMANTIC_EVAL_TOLERANCE || 0.03);
const KS = [1, 3, 5, 10];

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

function distinctFiles(items) {
  const seen = [];
  for (const item of items) {
    const file = item.path;
    if (file && !seen.includes(file)) seen.push(file);
  }
  return seen;
}

function score(rankedByQuery, queries) {
  const hits = Object.fromEntries(KS.map(k => [k, 0]));
  let reciprocal = 0;
  const detail = [];
  queries.forEach((query, i) => {
    const files = rankedByQuery[i];
    const rank = files.findIndex(f => query.expect.includes(f)) + 1; // 0 = miss
    for (const k of KS) if (rank > 0 && rank <= k) hits[k]++;
    if (rank > 0) reciprocal += 1 / rank;
    detail.push({ q: query.q, rank: rank || null, top: files.slice(0, 3) });
  });
  const n = queries.length;
  const metrics = { mrr: Math.round((reciprocal / n) * 1000) / 1000 };
  for (const k of KS) metrics[`recall@${k}`] = Math.round((hits[k] / n) * 1000) / 1000;
  return { metrics, detail };
}

async function runConfig(vectors, queries) {
  /* SEMANTIC_EVAL_INDEX_DIR keeps the indexes between runs so tuning iterations skip the 10 s index step. */
  const base = process.env.SEMANTIC_EVAL_INDEX_DIR ? path.resolve(process.env.SEMANTIC_EVAL_INDEX_DIR) : null;
  const reuse = base ? path.join(base, vectors ? 'hashing' : 'keyword') : null;
  const tmp = reuse || fs.mkdtempSync(path.join(os.tmpdir(), 'se-eval-'));
  if (reuse) fs.mkdirSync(reuse, { recursive: true });
  try {
    const existing = reuse ? findFile(tmp, 'project-index.json') : null;
    if (!existing) {
      const indexed = spawnSync(
        process.execPath,
        [path.join(ROOT, 'bin', 'semantic-engine.js'), 'index', '--root', CORPUS, '--out', tmp, '--no-git', '--data-dir', path.join(tmp, '.data'), '--project-id', 'prj-eval-12345678', ...(vectors ? ['--vectors'] : [])],
        { cwd: ROOT, encoding: 'utf8', env: { ...process.env, SEMANTIC_ENGINE_LOG_LEVEL: 'error' } }
      );
      if (indexed.status !== 0) throw new Error(`index failed: ${indexed.stderr || indexed.stdout}`);
    }

    const indexPath = findFile(tmp, 'project-index.json');
    const projectIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    const { ProjectIndexReader } = require(path.join(DIST, 'ai/ProjectIndexReader'));
    const { SemanticSearchTool } = require(path.join(DIST, 'ai/tools/SemanticSearchTool'));
    const { ContextDiscoverer } = require(path.join(DIST, 'ai/discovery/ContextDiscoverer'));
    const { loadBlueprintBeside } = require(path.join(DIST, 'ai/discovery/loadBlueprint'));

    const reader = new ProjectIndexReader(projectIndex);
    const loaded = loadBlueprintBeside(indexPath);
    const blueprint = loaded.index || undefined;
    if (!blueprint) console.error(`note: running without blueprint (${loaded.note})`);
    const search = new SemanticSearchTool(reader);
    const discoverer = new ContextDiscoverer(reader, blueprint ? { blueprint } : {});

    const { AssembleContextTool } = require(path.join(DIST, 'ai/tools/AssembleContextTool'));
    const assembler = new AssembleContextTool(reader, undefined, {
      workspaceRoot: CORPUS,
      ...(blueprint ? { blueprint } : {}),
    });
    /* Coverage: share of questions whose expected file appears in the assembled context at a token budget. */
    const assemble = {};
    for (const budget of [1000, 4000]) {
      let covered = 0;
      let tokens = 0;
      for (const query of queries) {
        const out = await assembler.execute({ task: query.q, maxTokens: budget });
        const paths = (out.items || []).map(item => item.path).filter(Boolean);
        const text = out.context || '';
        if (query.expect.some(file => paths.includes(file) || text.includes(file))) covered++;
        tokens += (out.metadata && out.metadata.estimatedTokens) || 0;
      }
      assemble[`coverage@${budget}`] = Math.round((covered / queries.length) * 1000) / 1000;
      assemble[`avgTokens@${budget}`] = Math.round(tokens / queries.length);
    }

    const searchRanked = [];
    const discoverRanked = [];
    for (const query of queries) {
      const s = await search.execute({ query: query.q, mode: vectors ? 'hybrid' : 'keyword', limit: 40 });
      searchRanked.push(distinctFiles(s.items.map(item => ({ path: item.path || (item.file && item.file.path) }))));
      const d = await discoverer.discover({ task: query.q, limit: 40 });
      discoverRanked.push(distinctFiles(d.candidates));
    }

    const only = (ranked, split) => {
      const idx = queries.map((query, i) => (split === 'all' || query.split === split ? i : -1)).filter(i => i >= 0);
      return score(idx.map(i => ranked[i]), idx.map(i => queries[i]));
    };
    return {
      files: projectIndex.files.length,
      search: only(searchRanked, 'all').metrics,
      discover: only(discoverRanked, 'all').metrics,
      holdout: { search: only(searchRanked, 'holdout').metrics, discover: only(discoverRanked, 'holdout').metrics },
      assemble,
      detail: only(discoverRanked, 'all').detail,
    };
  } finally {
    if (!reuse) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  if (!fs.existsSync(path.join(DIST, 'cli/commands/index-command.js'))) {
    console.error('dist/ missing - run "npm run build" first');
    process.exit(2);
  }
  const { queries } = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval', 'queries.json'), 'utf8'));
  const keyword = await runConfig(false, queries);
  const hashing = await runConfig(true, queries);
  const strip = ({ detail, ...rest }) => rest;
  const result = {
    version: 3,
    corpus: 'src',
    queries: queries.length,
    holdoutQueries: queries.filter(query => query.split === 'holdout').length,
    /* keyword: index without vectors. hashing: index with the built-in hashing embeddings (what `start` builds by default). */
    configs: { keyword: strip(keyword), hashing: strip(hashing) },
  };
  console.log(JSON.stringify(result, null, 2));
  if (process.argv.includes('--detail')) {
    for (const row of hashing.detail) console.error(`${row.rank === null ? 'MISS' : '#' + row.rank}\t${row.q}\t${row.top.join(', ')}`);
  }

  if (process.argv.includes('--write')) {
    fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
    fs.writeFileSync(BASELINE, JSON.stringify(result, null, 2) + '\n');
    console.error(`baseline written: ${path.relative(ROOT, BASELINE)}`);
  }
  if (process.argv.includes('--check')) {
    const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
    let failed = false;
    for (const config of Object.keys(result.configs)) {
      for (const system of ['search', 'discover']) {
        for (const [name, value] of Object.entries(result.configs[config][system])) {
          const was = base.configs[config][system][name];
          const ok = value >= was - TOLERANCE;
          console.error(`${ok ? 'ok  ' : 'FAIL'} ${config} ${system} ${name}: ${value} (baseline ${was})`);
          if (!ok) failed = true;
        }
      }
    }
    for (const config of Object.keys(result.configs)) {
      for (const [name, value] of Object.entries(result.configs[config].assemble)) {
        if (!name.startsWith('coverage')) continue;
        const was = base.configs[config].assemble[name];
        const ok = value >= was - TOLERANCE;
        console.error(`${ok ? 'ok  ' : 'FAIL'} ${config} assemble ${name}: ${value} (baseline ${was})`);
        if (!ok) failed = true;
      }
    }
    if (failed) process.exitCode = 1;
  }
}

main().catch(error => { console.error(error); process.exit(1); });
