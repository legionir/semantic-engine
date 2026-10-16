#!/usr/bin/env node
"use strict";
/*
 * Spike-S re-gate harness (retrieval-design.md §7, D-0022/D-0023).
 *
 * Verifies frozen artifact hashes, then scores the FIXED engine + goal-aware
 * retrieval on the frozen gold fixture:
 *   - aware / blind runs and the full ablation matrix (per-cue + combined)
 *   - B0/B1 baselines recomputed (must reproduce Spike-S exactly)
 *   - post-fix calibration per design §8.3
 *   - incremental == full, determinism, wrong-exact audit
 *
 * Reads:  fixture/index.json, gold.json, cue-lexicon.json (frozen, hash-checked)
 *         fixture2/ + gold-2.json when --fixture2 is passed (soft bars only)
 * Writes: results-regate.json (or results-regate-fixture2.json)
 *
 * Usage: node docs/validation/spike-s/regate.js [--fixture2]   (from semantic-engine/)
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SPIKE_DIR = __dirname;
const FIXTURE_DIR = path.join(SPIKE_DIR, "fixture");
const { ProjectIndexReader } = require("../../../dist/ai/ProjectIndexReader");
const { Phase3SemanticGraphPilot } = require("../../../dist/core/codeintel/Phase3SemanticGraph");
const { GoalRetriever, CUE_LEXICON, referenceModeCounts } = require("../../../dist/core/codeintel/GoalRetrieval");
const { GraphSnapshotStore } = require("../../../dist/core/codeintel/GraphSnapshotStore");
const os = require("os");
const distLexicon = require("../../../dist/core/codeintel/cue-lexicon.json");

const useFixture2 = process.argv.includes("--fixture2");
const FIXTURE = useFixture2 ? path.join(SPIKE_DIR, "fixture2") : FIXTURE_DIR;
const GOLD_FILE = useFixture2 ? path.join(SPIKE_DIR, "gold-2.json") : path.join(SPIKE_DIR, "gold.json");
const OUT_FILE = path.join(SPIKE_DIR, useFixture2 ? "results-regate-fixture2.json" : "results-regate.json");

// Frozen hashes (fixture-1 artifacts, locked at the design freeze commit 996fdd3).
const FROZEN_HASHES = {
  "gold.json": "636316016d26cca052ac34090316e72213899a0053777b91d059bc2a4f17cebc",
  "cue-lexicon.json": "128577b229dceecd84bf9c588c7ef706eb8733543a3496cd4515a2b6b253c981",
  "fixture/index.json": "27ac808e95ff69b323eb3a2c0e44c0013425460e5f3d14f16f588c11da4ea9df",
};

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const FROZEN_HASHES_F2 = {
  "gold-2.json": "f997b5514cb89bf1077dcea81f171cbb54cf817579ce41375f8f87390085b04d",
  "fixture2/index.json": "9d0ff9026c212ad3f69fe4ee07956eee1ec8de0888d83c1f0023350a2c8c7684",
};

function verifyFreeze() {
  const checks = [];
  if (useFixture2) {
    checks.push(["fixture2/index.json", path.join(SPIKE_DIR, "fixture2", "index.json"), FROZEN_HASHES_F2]);
    checks.push(["gold-2.json", GOLD_FILE, FROZEN_HASHES_F2]);
  } else {
    checks.push(["fixture/index.json", path.join(SPIKE_DIR, "fixture", "index.json"), FROZEN_HASHES]);
    checks.push(["gold.json", GOLD_FILE, FROZEN_HASHES]);
  }
  checks.push(["cue-lexicon.json", path.join(SPIKE_DIR, "cue-lexicon.json"), FROZEN_HASHES]);
  for (const [name, file, table] of checks) {
    if (sha256(file) !== table[name]) {
      throw new Error(`FREEZE VIOLATION: ${name} hash mismatch — refusing to run`);
    }
  }
  // Anti-drift: the engine's embedded lexicon must be identical to the frozen one.
  if (JSON.stringify(distLexicon) !== JSON.stringify(CUE_LEXICON)) {
    throw new Error("FREEZE VIOLATION: dist lexicon differs from CUE_LEXICON");
  }
  if (JSON.stringify(distLexicon) !== JSON.stringify(JSON.parse(fs.readFileSync(path.join(SPIKE_DIR, "cue-lexicon.json"), "utf8")))) {
    throw new Error("FREEZE VIOLATION: dist lexicon differs from frozen cue-lexicon.json");
  }
}

const gold = JSON.parse(fs.readFileSync(GOLD_FILE, "utf8"));
const index = JSON.parse(fs.readFileSync(path.join(FIXTURE, "index.json"), "utf8"));
const STOP = new Set(gold.method.STOPWORDS);

const symById = new Map(index.symbols.map((s) => [s.id, s]));
const fileById = new Map(index.files.map((f) => [f.id, f]));
const fileText = new Map();
for (const f of index.files) {
  fileText.set(f.path, fs.readFileSync(path.join(FIXTURE, f.path), "utf8"));
}

// ── B0/B1: identical recomputation to the frozen Spike-S method ──────────────
function tokenize(goal) {
  return goal.toLowerCase().split(/[^a-z0-9]+/u).filter((t) => t && !STOP.has(t));
}
function b0Set(goal) {
  const kws = tokenize(goal);
  const out = new Set();
  for (const f of index.files) {
    const low = fileText.get(f.path).toLowerCase();
    if (kws.some((k) => low.includes(k))) {
      for (const s of index.symbols) if (s.fileId === f.id) out.add(s.id);
    }
  }
  return { set: out, keywords: kws };
}
function buildImportEdges() {
  const byPath = new Map(index.files.map((f) => [f.path, f]));
  const edges = [];
  const re = /(?:import|export)[^;]*?\bfrom\s*['"]([^'"]+)['"]/gu;
  for (const f of index.files) {
    const text = fileText.get(f.path);
    let m;
    while ((m = re.exec(text))) {
      const spec = m[1];
      if (!spec.startsWith(".")) continue;
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(f.path), spec));
      const probes = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}/index.ts`, `${base}/index.tsx`];
      const hit = probes.map((p) => byPath.get(p)).find(Boolean);
      if (hit) edges.push([f.path, hit.path]);
    }
  }
  return edges;
}
function b1Set(seedFilePath, edges) {
  const files = new Set([seedFilePath]);
  for (const [a, b] of edges) {
    if (a === seedFilePath) files.add(b);
    if (b === seedFilePath) files.add(a);
  }
  const out = new Set();
  for (const s of index.symbols) {
    const f = fileById.get(s.fileId);
    if (f && files.has(f.path)) out.add(s.id);
  }
  return { set: out, files: [...files].sort() };
}
function pr(returned, relevant) {
  const rel = new Set(relevant);
  let tp = 0;
  for (const id of returned) if (rel.has(id)) tp++;
  return {
    tp, fp: returned.length - tp, fn: rel.size - tp,
    precision: returned.length === 0 ? 1 : tp / returned.length,
    recall: rel.size === 0 ? 1 : tp / rel.size,
  };
}

// ── Retrieval configurations (§6.5 ablation matrix) ─────────────────────────
const MODES = {
  AWARE: { label: "full (goal-aware)", options: {} },
  BLIND: { label: "all-off (blind, fixes only)", options: { cuesEnabled: false } },
  NO_CHAIN: { label: "-CHAIN", options: { disabledClasses: ["CHAIN"] } },
  NO_DEPENDEES: { label: "-DEPENDEES", options: { disabledClasses: ["DEPENDEES"] } },
  NO_HARD_SURFACE: { label: "-HARD_SURFACE", options: { disabledClasses: ["HARD_SURFACE"] } },
  NO_REFERRERS_EXPLICIT: { label: "-REFERRERS-explicit (R1-R5 off, AV kept)", options: { disabledClasses: ["REFERRERS"] } },
  NO_SINGLETON: { label: "-SINGLETON", options: { disabledClasses: ["SINGLETON"] } },
  NO_DEPTH: { label: "-DEPTH", options: { disabledClasses: ["DEPTH_MODIFIER"] } },
  NO_AMBIGUITY_EXPANSION: { label: "-AMBIGUITY_EXPANSION", options: { disableAmbiguityExpansion: true } },
};

// Post-fix calibration expectations (design §8.3; fixture-1).
const POSTFIX = {
  unresolved: [
    { name: "fs", sourcePath: "src/app.ts", reasonContains: "unresolved namespace import" },
    { name: "ghost", sourcePath: "src/unused.ts", reasonContains: "unresolved import 'ghost'" },
  ],
  hardBindings: [{ sourcePath: "src/shadow.ts", line: 3, kind: "local-shadow", enclosing: "s-f" }],
  bindingHardEnclosings: ["s-f", "s-v", "s-s"],
  ambiguousRefs: 1,
  wrongExact: 0,
  fileDepCount: 13,
  midEdge: { from: "src/mid.ts", to: "src/math.ts" },
  viaMidYields: "s-add",
  touchedUnresolved: { T4: ">=1", T5: ">=1", T6: ">=1", T13: ">=1" }, // all other tasks 0; derivation erratum vs design 8.3 (T6 gold includes grand@app -> fs; T10 has no app file)
  touchedBindingHard: { T1: 1, T5: 1, T6: 1, T7: 1, T9: 1, T10: 3, T14: 1, T16: 1, T17: 1, T18: 1, T19: 1, T20: 1 },
};

async function main() {
  verifyFreeze();
  const reader = new ProjectIndexReader(index);
  const pilot = new Phase3SemanticGraphPilot(reader, FIXTURE);
  const graph = await pilot.build();
  const retriever = new GoalRetriever(reader);
  const edges = buildImportEdges();

  // Determinism: 3 consecutive builds byte-identical.
  const d1 = JSON.stringify(await pilot.build());
  const d2 = JSON.stringify(await pilot.build());
  const d3 = JSON.stringify(await pilot.build());
  const deterministic = d1 === d2 && d2 === d3;

  // ── Persisted-store parity (D-0021 ordered step: goldens re-run through the
  // persisted path). Publish, REOPEN a fresh store instance (simulated restart),
  // verify the persisted graph is identical, and re-run every gold task against
  // the persisted graph: results must be byte-identical to the in-memory run.
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "regate-store-"));
  const store = new GraphSnapshotStore(storeDir);
  const digest = new (require("../../../dist/core/codeintel/Phase1Platform").Phase1IndexPlatform)().snapshotId(index);
  const published = await store.publish(graph, digest);
  const reopened = new GraphSnapshotStore(storeDir);
  const persistedRecord = await reopened.current();
  const persistedGraphEqual = JSON.stringify(persistedRecord.graph) === JSON.stringify(graph);
  const persistedResolveEqual = JSON.stringify((await reopened.resolveHandle(published.handle)).graph) === JSON.stringify(graph);
  const persistedTasks = [];
  let persistedParity = true;
  for (const t of gold.tasks) {
    const seed = symById.get(t.seed);
    const live = retriever.retrieve(graph, seed, t.goal);
    const persisted = retriever.retrieve(persistedRecord.graph, seed, t.goal);
    const equal = JSON.stringify([...persisted.symbols].sort()) === JSON.stringify([...live.symbols].sort());
    if (!equal) persistedParity = false;
    persistedTasks.push({ id: t.id, equal });
  }
  fs.rmSync(storeDir, { recursive: true, force: true });
  const persistedLeg = {
    storeSchemaVersion: require("../../../dist/core/codeintel/GraphSnapshotStore").GRAPH_STORE_SCHEMA_VERSION,
    graphEqualAfterReopen: persistedGraphEqual,
    handleResolvesAfterReopen: persistedResolveEqual,
    allTasksEqual: persistedTasks.every(t => t.equal),
    taskParity: persistedParity,
    tasks: persistedTasks,
  };

  // ── Per-task scoring across all modes ──
  const taskRows = [];
  for (const t of gold.tasks) {
    const seed = symById.get(t.seed);
    if (!seed) throw new Error(`unknown seed ${t.seed}`);
    const row = { id: t.id, seed: t.seed, goal: t.goal, relevant: t.relevant, modes: {} };
    for (const [modeName, mode] of Object.entries(MODES)) {
      const result = retriever.retrieve(graph, seed, t.goal, mode.options);
      const p = pr(result.symbols, t.relevant);
      row.modes[modeName] = {
        symbols: [...result.symbols].sort(),
        ...p,
        meta: { direction: result.meta.direction, cue: result.meta.cue ? result.meta.cue.patternId : null, reason: result.meta.reason, depth: result.meta.depth, truncated: result.meta.truncated },
      };
    }
    // Resolution-mode reporting (design 7 criterion 7): counts by confidence class
    // for references that touch this task's seed (incoming + outgoing) + hard bindings.
    const seedRefs = graph.references.filter(r => r.targetSymbolId === t.seed || r.provenance.candidates.some(c => c.symbolId === t.seed) || r.sourceEnclosingSymbolId === t.seed);
    row.resolution = { ...referenceModeCounts(seedRefs), hardBindings: graph.hardBindings.filter(h => h.sourceEnclosingSymbolId === t.seed || h.name === seed.name).length };
    const b0 = b0Set(t.goal);
    const seedFile = fileById.get(seed.fileId);
    const b1 = b1Set(seedFile.path, edges);
    row.b0 = { set: [...b0.set].sort(), ...pr([...b0.set], t.relevant), keywords: b0.keywords };
    row.b1 = { set: [...b1.set].sort(), ...pr([...b1.set], t.relevant), files: b1.files };
    taskRows.push(row);
  }

  const macroOf = (mode) => ({
    precision: taskRows.reduce((a, r) => a + r.modes[mode].precision, 0) / taskRows.length,
    recall: taskRows.reduce((a, r) => a + r.modes[mode].recall, 0) / taskRows.length,
  });
  const microOf = (mode) => {
    const tp = taskRows.reduce((a, r) => a + r.modes[mode].tp, 0);
    const fp = taskRows.reduce((a, r) => a + r.modes[mode].fp, 0);
    const fn = taskRows.reduce((a, r) => a + r.modes[mode].fn, 0);
    return { tp, fp, fn, precision: tp / (tp + fp), recall: tp / (tp + fn) };
  };
  const summary = { macro: {}, micro: {} };
  for (const modeName of Object.keys(MODES)) {
    summary.macro[modeName] = macroOf(modeName);
    summary.micro[modeName] = microOf(modeName);
  }
  summary.macro.B0 = { precision: taskRows.reduce((a, r) => a + r.b0.precision, 0) / taskRows.length, recall: taskRows.reduce((a, r) => a + r.b0.recall, 0) / taskRows.length };
  summary.macro.B1 = { precision: taskRows.reduce((a, r) => a + r.b1.precision, 0) / taskRows.length, recall: taskRows.reduce((a, r) => a + r.b1.recall, 0) / taskRows.length };

  // ── Gates (aware run, §7) ──
  const aware = summary.macro.AWARE;
  const wrongExact = [];
  for (const row of taskRows) {
    const rel = new Set(row.relevant);
    const inResult = new Set(row.modes.AWARE.symbols);
    for (const ref of graph.references) {
      if (ref.provenance.confidence !== "exact" || !ref.sourceEnclosingSymbolId) continue;
      // A wrong-exact for a task: an exact reference that CONTRIBUTED a symbol to the
      // task's aware result whose enclosing symbol is outside the task gold.
      if (!inResult.has(ref.sourceEnclosingSymbolId)) continue;
      if (!rel.has(ref.sourceEnclosingSymbolId)) wrongExact.push({ task: row.id, ref: `${ref.sourcePath}:${ref.line}`, enclosing: ref.sourceEnclosingSymbolId });
    }
  }
  const gates = {
    precision_ge_095: aware.precision >= 0.95,
    exact_class_precision_1: wrongExact.length === 0,
    recall_ge_b1: aware.recall >= summary.macro.B1.recall,
    recall_gt_b0: aware.recall > summary.macro.B0.recall,
  };

  // ── Post-fix calibration (§8.3) ──
  const unresolvedExpectations = useFixture2
    ? gold.calibration.globalUnresolved.map((g) => ({ name: g.name, sourcePath: g.sourcePath, reasonContains: g.reasonContains }))
    : POSTFIX.unresolved;
  const unresolvedChecks = unresolvedExpectations.map((exp) => ({
    ...exp,
    found: graph.unresolved.some((u) => u.name === exp.name && u.sourcePath === exp.sourcePath && u.reason.includes(exp.reasonContains)),
  }));
  const hardBindingChecks = POSTFIX.hardBindings.map((exp) => ({
    ...exp,
    found: graph.hardBindings.some((h) => h.sourcePath === exp.sourcePath && h.line === exp.line && h.kind === exp.kind && h.sourceEnclosingSymbolId === exp.enclosing),
  }));
  const routedKinds = new Set(["re-export-routed", "default-routed", "namespace-routed"]);
  const bindingHardEnclosings = new Set([
    ...graph.references.filter((r) => routedKinds.has(r.bindingKind) && r.sourceEnclosingSymbolId).map((r) => r.sourceEnclosingSymbolId),
    ...graph.hardBindings.filter((h) => h.sourceEnclosingSymbolId).map((h) => h.sourceEnclosingSymbolId),
  ]);
  const bindingHardCheck = [...bindingHardEnclosings].sort().join(",") === [...POSTFIX.bindingHardEnclosings].sort().join(",");
  const ambiguousRefs = graph.references.filter((r) => r.provenance.confidence === "ambiguous");
  const depRows = graph.fileDeps.map((d) => ({ from: fileById.get(d.fromFileId)?.path, to: d.toFileId ? fileById.get(d.toFileId)?.path : null, specifier: d.specifier, resolved: d.resolved }));
  const midEdgeCheck = depRows.some((d) => d.from === POSTFIX.midEdge.from && d.to === POSTFIX.midEdge.to && d.resolved);
  const viaMidCheck = depRows.some((d) => d.from === "src/via.ts" && d.to === "src/mid.ts" && d.resolved)
    && graph.references.some((r) => r.sourcePath === "src/via.ts" && r.targetSymbolId === POSTFIX.viaMidYields && r.bindingKind === "re-export-routed");
  const unclassifiedRows = graph.occurrenceAudit.filter((a) => a.byClass.unclassified > 0);

  // touched unresolved / binding-hard per task (fixture-1 only; calibration)
  const touched = {};
  const touchedHard = {};
  if (!useFixture2) {
    for (const t of gold.tasks) {
      const ids = new Set([...t.relevant, t.seed]);
      const files = new Set([...ids].map((id) => symById.get(id)?.fileId));
      const names = new Set([...ids].map((id) => symById.get(id)?.name));
      touched[t.id] = graph.unresolved.filter((u) => files.has(u.sourceFileId) || names.has(u.name)).length;
      touchedHard[t.id] = graph.hardBindings.filter((h) => files.has(h.sourceFileId) || ids.has(h.sourceEnclosingSymbolId)).length
        + graph.references.filter((r) => routedKinds.has(r.bindingKind) && r.sourceEnclosingSymbolId && (files.has(r.sourceFileId) || ids.has(r.sourceEnclosingSymbolId))).length;
    }
  }
  const touchedPass = !useFixture2 ? Object.entries(POSTFIX.touchedUnresolved).every(([id, exp]) => touched[id] >= 1) && Object.entries(POSTFIX.touchedUnresolved).length >= 1 && Object.entries(touched).every(([id]) => POSTFIX.touchedUnresolved[id] ? touched[id] >= 1 : touched[id] === 0) : null;
  const touchedHardPass = !useFixture2 ? Object.entries(POSTFIX.touchedBindingHard).every(([id, exp]) => touchedHard[id] === exp) && Object.entries(touchedHard).every(([id]) => POSTFIX.touchedBindingHard[id] !== undefined ? touchedHard[id] === POSTFIX.touchedBindingHard[id] : touchedHard[id] === 0) : null;

  // Incremental equality + rejection.
  const inc = await pilot.buildIncremental(graph, gold.incremental.changedPaths);
  const full = await pilot.build();
  const incrementalEqual = JSON.stringify(inc) === JSON.stringify(full);
  let invalidRejected = false;
  try { await pilot.buildIncremental(graph, ["/abs/path.ts"]); } catch { invalidRejected = true; }

  const calibration = {
    unresolvedCount: graph.unresolved.length,
    unresolvedChecks,
    hardBindingChecks,
    bindingHardEnclosings: [...bindingHardEnclosings].sort(),
    bindingHardCheck,
    ambiguousRefCount: ambiguousRefs.length,
    ambiguousRefs: ambiguousRefs.map((r) => ({ at: `${r.sourcePath}:${r.line}`, candidates: r.provenance.candidates.map((c) => c.symbolId) })),
    wrongExactRefs: wrongExact,
    fileDepCount: depRows.length,
    fileDepCountExpected: useFixture2 ? (gold.calibration.fileDeps?.expectedDepCount ?? null) : POSTFIX.fileDepCount,
    midEdgeCheck: useFixture2 ? null : midEdgeCheck,
    viaMidYieldsCheck: useFixture2 ? null : viaMidCheck,
    unclassifiedOccurrences: unclassifiedRows.length,
    touchedUnresolved: useFixture2 ? null : touched,
    touchedUnresolvedPass: touchedPass,
    touchedBindingHard: useFixture2 ? null : touchedHard,
    touchedBindingHardPass: touchedHardPass,
    deterministic,
    persistedLeg,
    incremental: { equal: incrementalEqual, invalidPathRejected: invalidRejected, changedPaths: gold.incremental.changedPaths },
    b0b1Reproduction: useFixture2 ? null : {
      expected: { b0: { precision: 0.582, recall: 0.787 }, b1: { precision: 0.603, recall: 0.896 } },
      actual: { b0: summary.macro.B0, b1: summary.macro.B1 },
      pass: Math.abs(summary.macro.B0.recall - 0.787) < 0.0005 && Math.abs(summary.macro.B1.recall - 0.896) < 0.0005 && Math.abs(summary.macro.B0.precision - 0.582) < 0.0005 && Math.abs(summary.macro.B1.precision - 0.603) < 0.0005,
    },
  };

  const results = {
    generatedAt: new Date().toISOString(),
    fixture: useFixture2 ? "fixture2/" : "fixture/",
    goldFile: path.basename(GOLD_FILE),
    gateBars: "macro precision >= 0.95 AND exact-class precision = 1.0; macro recall >= B1 AND > B0 (docs/GATES.md; measured, never changed)",
    softBars: useFixture2 ? "fixture-2 is generalization evidence: macro P >= 0.90 and macro R >= B1(f2) - 0.05 (reported, not gate-blocking)" : null,
    freezeVerified: true,
    lexicon: { version: CUE_LEXICON.version, patterns: CUE_LEXICON.patterns.length },
    summary,
    gates: useFixture2 ? null : gates,
    softGateResult: useFixture2 ? {
      precision_ge_090: aware.precision >= 0.90,
      recall_ge_b1_minus_05: aware.recall >= summary.macro.B1.recall - 0.05,
    } : null,
    calibration,
    graphCounts: { references: graph.references.length, unresolved: graph.unresolved.length, hardBindings: graph.hardBindings.length, fileDeps: graph.fileDeps.length, resolutionModes: referenceModeCounts(graph.references) },
    tasks: taskRows,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 2));

  const f3 = (n) => n.toFixed(3);
  console.log(`MODES (${useFixture2 ? "fixture2" : "fixture1"})  macro P / macro R`);
  for (const [modeName, mode] of Object.entries(MODES)) {
    console.log(`  ${mode.label.padEnd(42)} ${f3(summary.macro[modeName].precision)} / ${f3(summary.macro[modeName].recall)}`);
  }
  console.log(`  ${"B0 keywords".padEnd(42)} ${f3(summary.macro.B0.precision)} / ${f3(summary.macro.B0.recall)}`);
  console.log(`  ${"B1 depth-1 closure".padEnd(42)} ${f3(summary.macro.B1.precision)} / ${f3(summary.macro.B1.recall)}`);
  if (!useFixture2) {
    console.log(`GATES  P>=0.95: ${gates.precision_ge_095} | exactP=1.0: ${gates.exact_class_precision_1} | R>=B1: ${gates.recall_ge_b1} | R>B0: ${gates.recall_gt_b0}`);
    console.log(`CALIB  unresolved=${graph.unresolved.length}/2 hard=${graph.hardBindings.length}/1 bindingHardEnc={${calibration.bindingHardEnclosings}} ambiguous=${ambiguousRefs.length}/1 wrongExact=${wrongExact.length}/0`);
    console.log(`       deps=${depRows.length}/13 midEdge=${midEdgeCheck} viaMidYields=${viaMidCheck} unclassified=${unclassifiedRows.length}/0`);
    console.log(`       touchedUnresolvedPass=${touchedPass} touchedBindingHardPass=${touchedHardPass} b0b1Repro=${calibration.b0b1Reproduction.pass}`);
  } else {
    console.log(`SOFT   P>=0.90: ${results.softGateResult.precision_ge_090} | R>=B1-0.05: ${results.softGateResult.recall_ge_b1_minus_05}`);
  }
  console.log(`INCR   equal=${incrementalEqual} invalidRejected=${invalidRejected} deterministic=${deterministic}`);
  console.log(`STORE  graphEqual=${persistedLeg.graphEqualAfterReopen} handleResolves=${persistedLeg.handleResolvesAfterReopen} taskParity=${persistedLeg.allTasksEqual && persistedLeg.taskParity}`);
  console.log(`WROTE  ${path.relative(process.cwd(), OUT_FILE)}`);
}

main().catch((e) => { console.error("REGATE FAILED:", e); process.exit(1); });
