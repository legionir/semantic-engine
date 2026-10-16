#!/usr/bin/env node
"use strict";
/*
 * Phase 4 gate measurement — context_build recall@budget (docs/GATES.md, Phase 4).
 *
 * Bars (owner-locked thresholds, unchanged):
 *   - context_build recall@budget  >= B1  and > B0   (B0/B1 = the frozen fixture-1
 *     baselines measured in the Phase 3 gate run: macro recall B0=0.787, B1=0.896)
 *   - no budget overrun: 100% (sum of estimated tokens of returned items <= budget)
 *
 * Method: each of the 20 frozen gold tasks runs through Phase4ContextBuilder
 * (goal-aware path, Phase 3 semantic layer) with a fixed budget. A relevant symbol
 * counts as recalled when an item covers its declaration: same file AND the
 * symbol's start offset falls inside the excerpt. Ablation: the same builder with
 * the goal omitted (legacy name-only path).
 *
 * Usage: node docs/validation/spike-s/phase4-regate.js   (from semantic-engine/, after npm run build)
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const SPIKE_DIR = __dirname;

const FROZEN_HASHES = {
  "gold.json": "636316016d26cca052ac34090316e72213899a0053777b91d059bc2a4f17cebc",
  "cue-lexicon.json": "128577b229dceecd84bf9c588c7ef706eb8733543a3496cd4515a2b6b253c981",
  "fixture/index.json": "27ac808e95ff69b323eb3a2c0e44c0013425460e5f3d14f16f588c11da4ea9df",
};

const { ProjectIndexReader } = require("../../../dist/ai/ProjectIndexReader");
const { Phase4ContextBuilder } = require("../../../dist/core/codeintel/Phase4Controlled");

const B0_RECALL = 0.787; // frozen Phase 3 measurement (results-regate.json)
const B1_RECALL = 0.896; // frozen Phase 3 measurement (results-regate.json)
const BUDGET = 2000;

function sha256(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }

function verifyFreeze() {
  for (const [name, file] of Object.entries({
    "gold.json": path.join(SPIKE_DIR, "gold.json"),
    "fixture/index.json": path.join(SPIKE_DIR, "fixture", "index.json"),
    "cue-lexicon.json": path.join(SPIKE_DIR, "cue-lexicon.json"),
  })) {
    if (sha256(file) !== FROZEN_HASHES[name]) throw new Error(`FREEZE VIOLATION: ${name} hash mismatch — refusing to run`);
  }
}

/** Start offset (chars) of `line` (1-based) in `text`. */
function offsetOfLine(text, line) {
  let offset = 0;
  for (let i = 1; i < line; i++) offset = text.indexOf("\n", offset) + 1;
  return offset;
}

async function main() {
  verifyFreeze();
  const gold = JSON.parse(fs.readFileSync(path.join(SPIKE_DIR, "gold.json"), "utf8"));
  const index = JSON.parse(fs.readFileSync(path.join(SPIKE_DIR, "fixture", "index.json"), "utf8"));
  const root = path.join(SPIKE_DIR, "fixture");
  const reader = new ProjectIndexReader(index);
  const sourceCache = new Map();
  const readSource = async (p) => {
    if (!sourceCache.has(p)) sourceCache.set(p, fs.readFileSync(path.join(root, p), "utf8"));
    return sourceCache.get(p);
  };

  const run = async (withGoal) => {
    const rows = [];
    const builder = new Phase4ContextBuilder(reader, root);
    for (const t of gold.tasks) {
      // Ablation fairness: the legacy name-only path matches by NAME, so it gets the
      // seed's name (what a real caller would pass without the semantic layer).
      const seedValue = withGoal ? t.seed : reader.getSymbolById(t.seed).name;
      const result = await builder.build(seedValue, BUDGET, 100, withGoal ? t.goal : undefined);
      const used = result.items.reduce((a, item) => a + Math.ceil(item.excerpt.length / 4), 0);
      const covered = [];
      for (const id of t.relevant) {
        const symbol = reader.getSymbolById(id);
        if (!symbol) throw new Error(`unknown relevant symbol ${id}`);
        const file = reader.getFileById(symbol.fileId);
        const text = await readSource(file.path);
        const start = offsetOfLine(text, symbol.line);
        const ok = result.items.some(item => item.path === file.path && start < item.excerpt.length && start + 1 <= item.excerpt.length);
        if (ok) covered.push(id);
      }
      rows.push({ id: t.id, recall: covered.length / t.relevant.length, covered, budgetUsed: used, budgetAdherent: used <= BUDGET, itemCount: result.items.length });
    }
    const macroRecall = rows.reduce((a, r) => a + r.recall, 0) / rows.length;
    return { rows, macroRecall, allBudgetAdherent: rows.every(r => r.budgetAdherent) };
  };

  const aware = await run(true);
  const nameOnly = await run(false);

  // Determinism: two consecutive goal-aware builds byte-identical.
  const builder = new Phase4ContextBuilder(reader, root);
  const t0 = gold.tasks[0];
  const d1 = JSON.stringify(await builder.build(t0.seed, BUDGET, 100, t0.goal));
  const d2 = JSON.stringify(await builder.build(t0.seed, BUDGET, 100, t0.goal));
  const deterministic = d1 === d2;

  const pass = aware.macroRecall >= B1_RECALL && aware.macroRecall > B0_RECALL && aware.allBudgetAdherent && deterministic;

  const results = {
    generatedAt: new Date().toISOString(),
    spike: "Phase 4 gate — context_build recall@budget",
    budget: BUDGET,
    bars: { b0Recall: B0_RECALL, b1Recall: B1_RECALL, gate: "macro recall@budget >= B1 and > B0; budget adherence 100%" },
    aware: { macroRecall: aware.macroRecall, allBudgetAdherent: aware.allBudgetAdherent, perTask: aware.rows },
    ablationNameOnly: { macroRecall: nameOnly.macroRecall, allBudgetAdherent: nameOnly.allBudgetAdherent, perTask: nameOnly.rows },
    deterministic,
    gate: {
      recallAtLeastB1: aware.macroRecall >= B1_RECALL,
      recallGreaterThanB0: aware.macroRecall > B0_RECALL,
      noBudgetOverrun: aware.allBudgetAdherent,
      pass,
    },
  };
  const out = path.join(SPIKE_DIR, "results-phase4-regate.json");
  fs.writeFileSync(out, JSON.stringify(results, null, 2) + "\n");
  console.log(`aware (goal-aware)    macro recall@${BUDGET} = ${aware.macroRecall.toFixed(3)}  budget-adherent=${aware.allBudgetAdherent}`);
  console.log(`name-only (ablation)  macro recall@${BUDGET} = ${nameOnly.macroRecall.toFixed(3)}  budget-adherent=${nameOnly.allBudgetAdherent}`);
  console.log(`deterministic=${deterministic}`);
  console.log(`GATE  R>=B1(${B1_RECALL}): ${aware.macroRecall >= B1_RECALL} | R>B0(${B0_RECALL}): ${aware.macroRecall > B0_RECALL} | no-overrun: ${aware.allBudgetAdherent} | PASS=${pass}`);
  console.log(`WROTE ${path.relative(process.cwd(), out)}`);
  process.exitCode = pass ? 0 : 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
