#!/usr/bin/env node
'use strict';
/* Gate evidence: Phase 2 apply→undo fuzz, 1500 seeded cycles, byte-exact.
 * Usage: node docs/validation/scripts/fuzz-apply-undo.js [cycles]
 * Exit 0 only if every cycle restores byte-identical content. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TransactionalEditEngine, contentHash } = require('../../../dist/core/codeintel/Phase2Transactions');

const CYCLES = Number(process.argv[2] || 1500);
const ALPHABET = 'abcXYZ019 \n\t;(){}:=>importexportفارسی🎉\r';

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
function randomText(rand, maxLength) {
  const length = Math.floor(rand() * maxLength);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return out;
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'se-fuzz-1500-'));
  const started = Date.now();
  let applied = 0;
  let skippedNoop = 0;
  try {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    const rand = seededRandom(0xF02);
    const file = 'src/a.ts';
    fs.writeFileSync(path.join(root, file), randomText(rand, 600) || 'seed\n', 'utf8');
    const engine = new TransactionalEditEngine(root);
    for (let cycle = 0; cycle < CYCLES; cycle++) {
      const original = fs.readFileSync(path.join(root, file), 'utf8');
      const at = Math.floor(rand() * (original.length + 1));
      const span = Math.min(original.length - at, Math.floor(rand() * 16));
      const replacement = randomText(rand, 16);
      if (original.slice(at, at + span) === replacement) { skippedNoop++; continue; }
      const plan = await engine.plan([{ path: file, start: at, end: at + span, replacement, expectedHash: contentHash(original) }]);
      const record = await engine.apply(plan.id, engine.approve(plan.id));
      if (record.status !== 'applied') throw new Error(`cycle ${cycle}: status=${record.status}`);
      const rolled = await engine.rollback(record.transactionId);
      if (rolled.status !== 'rolled_back') throw new Error(`cycle ${cycle}: rollback=${rolled.status}`);
      const restored = fs.readFileSync(path.join(root, file), 'utf8');
      if (restored !== original) throw new Error(`cycle ${cycle}: BYTE MISMATCH after rollback`);
      applied++;
    }
    console.log(JSON.stringify({ cycles: CYCLES, applied, skippedNoop, byteExact: true, elapsedMs: Date.now() - started }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(`FUZZ FAILED: ${error.stack || error}`); process.exit(1); });
