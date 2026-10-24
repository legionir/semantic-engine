#!/usr/bin/env node
'use strict';

/*
| Real embedding model check (network required)
| ----------------------------------------------
|   node scripts/e2e-embedding.js
|
| Downloads Xenova/all-MiniLM-L6-v2 from the model hub and verifies the whole local-embedding path
| with the real model instead of the hashing stand-in:
|   1. the generator loads (sharp / onnxruntime / @xenova/transformers) and returns 384-d unit vectors;
|   2. paraphrases land closer than unrelated text — the vocabulary-gap case hashing cannot solve;
|   3. `index --embedding-provider local --vectors` writes vector chunks with the real model recorded.
| Without network or without @xenova/transformers the script prints "skipped" and exits 0;
| E2E_REQUIRED=1 (CI) turns that into a failure.
*/

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const required = process.env.E2E_REQUIRED === '1';
const MODEL = 'Xenova/all-MiniLM-L6-v2';
const failures = [];

function skip(reason) {
  const message = `e2e-embedding: skipped (${reason})`;
  if (required) {
    console.error(message.replace('skipped', 'FAILED, but E2E_REQUIRED=1'));
    process.exit(1);
  }
  console.log(message);
  process.exit(0);
}

function fail(reason) {
  console.error(`e2e-embedding: FAILED — ${reason}`);
  process.exit(1);
}

function check(name, condition, detail = '') {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${condition || !detail ? '' : ` — ${detail}`}`);
  if (!condition) failures.push(name);
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.js'))) skip('dist/ is not built');
  try { require.resolve('@xenova/transformers'); } catch { skip('@xenova/transformers is not installed'); }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'se-embed-'));
  try {
    const { LocalEmbeddingGenerator, cosine } = require(path.join(ROOT, 'dist'));
    const { LocalModelStore } = require(path.join(ROOT, 'dist', 'services', 'providers', 'LocalModelStore'));

    /* The same download the Embeddings panel performs; `index --embedding-provider local` reads from here. */
    const dataDir = path.join(work, 'data');
    const modelsDir = path.join(dataDir, 'models');
    const store = new LocalModelStore({ modelsDir });
    store.start(MODEL);
    await store.finished(MODEL);
    if (!store.isReady(MODEL)) skip('the model could not be downloaded (no network?)');

    const generator = new LocalEmbeddingGenerator({ model: MODEL, localModelPath: modelsDir });
    if (!(await generator.isReady())) fail('the downloaded model could not be loaded by the generator');

    const [query, paraphrase, unrelated] = (await generator.generateBatch([
      'read the configuration file',
      'load settings from a json document on disk',
      'draw a pie chart on a canvas element',
    ])).map(r => r.embedding);

    check('vectors are 384-dimensional', query.length === 384, `got ${query.length}`);
    const norm = Math.sqrt(query.reduce((sum, v) => sum + v * v, 0));
    check('vectors are unit length', Math.abs(norm - 1) < 1e-3, `norm ${norm}`);
    const near = cosine(query, paraphrase);
    const far = cosine(query, unrelated);
    check('a paraphrase with no shared words is closer than unrelated text', near > far + 0.15, `near ${near.toFixed(3)} far ${far.toFixed(3)}`);

    const project = path.join(work, 'project');
    fs.cpSync(path.join(ROOT, 'test-fixture'), project, { recursive: true });
    const out = path.join(work, 'out');
    const run = spawnSync(process.execPath, [
      path.join(ROOT, 'bin', 'semantic-engine.js'), 'index', '--root', project, '--out', out, '--no-git',
      '--data-dir', dataDir, '--project-id', 'prj-embed-12345678',
      '--embedding-provider', 'local', '--embedding-model', MODEL, '--vectors',
    ], { encoding: 'utf8', timeout: 600_000 });
    check('index with the local provider exits 0', run.status === 0, `${run.stderr}`.slice(-600));

    const index = JSON.parse(fs.readFileSync(path.join(out, 'project-index.json'), 'utf8'));
    const chunks = index.vectorChunks ?? [];
    check('index carries vector chunks', chunks.length > 0, `${chunks.length}`);
    check('chunks use the real model dimension', chunks.length > 0 && chunks.every(c => (c.embedding ?? c.vector ?? []).length === 384));
    check('the real model is recorded', JSON.stringify(index).includes(MODEL));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error(`\ne2e-embedding: ${failures.length} failure(s): ${failures.join('; ')}`);
    process.exit(1);
  }
  console.log('\ne2e-embedding: all checks passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
