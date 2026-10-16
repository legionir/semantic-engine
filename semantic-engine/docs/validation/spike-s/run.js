#!/usr/bin/env node
"use strict";
/*
 * Spike-S runner — executes the REAL Phase 3 pilot (Phase3SemanticGraphPilot
 * from dist/) on the frozen gold fixture and scores M1 (pilot) vs B0
 * (keyword files) vs B1 (depth-1 import closure, independent scan).
 *
 * Reads:  fixture/index.json, gold.json   (both frozen before first run)
 * Writes: results.json
 *
 * Usage: node docs/validation/spike-s/run.js   (from semantic-engine/)
 */

const fs = require("fs");
const path = require("path");

const SPIKE_DIR = __dirname;
const FIXTURE_DIR = path.join(SPIKE_DIR, "fixture");
const { ProjectIndexReader } = require("../../../dist/ai/ProjectIndexReader");
const { Phase3SemanticGraphPilot } = require("../../../dist/core/codeintel/Phase3SemanticGraph");

const gold = JSON.parse(fs.readFileSync(path.join(SPIKE_DIR, "gold.json"), "utf8"));
const index = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "index.json"), "utf8"));
const STOP = new Set(gold.method.STOPWORDS);

const symById = new Map(index.symbols.map((s) => [s.id, s]));
const fileById = new Map(index.files.map((f) => [f.id, f]));
const fileText = new Map();
for (const f of index.files) {
  fileText.set(f.path, fs.readFileSync(path.join(FIXTURE_DIR, f.path), "utf8"));
}

function enclosingSymbolId(filePath, line) {
  const file = index.files.find((f) => f.path === filePath);
  if (!file) return undefined;
  let best;
  for (const s of index.symbols) {
    if (s.fileId !== file.id) continue;
    if (line < s.line || line > s.endLine) continue;
    const span = s.endLine - s.line;
    if (!best || span < best.span) best = { id: s.id, span };
  }
  return best?.id;
}

function tokenize(goal) {
  return goal.toLowerCase().split(/[^a-z0-9]+/u).filter((t) => t && !STOP.has(t));
}

// B0: union of keyword-substring file matches -> all symbols of matched files.
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

// B1: INDEPENDENT import scan (no pilot code). Both-direction depth-1 closure.
function buildImportEdges() {
  const byPath = new Map(index.files.map((f) => [f.path, f]));
  const edges = []; // [fromPath, toPath]
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
  const fp = returned.size - tp;
  const fn = rel.size - tp;
  return {
    tp, fp, fn,
    precision: returned.size === 0 ? 1 : tp / returned.size,
    recall: rel.size === 0 ? 1 : tp / rel.size,
  };
}

async function main() {
  const reader = new ProjectIndexReader(index);
  const pilot = new Phase3SemanticGraphPilot(reader, FIXTURE_DIR);
  const graph = await pilot.build();
  const edges = buildImportEdges();

  const taskRows = [];
  for (const t of gold.tasks) {
    const seed = symById.get(t.seed);
    if (!seed) throw new Error(`unknown seed ${t.seed}`);
    const { references } = await pilot.referencesFor(t.seed);
    const m1 = new Set([t.seed]);
    const refDetail = [];
    let unenclosed = 0;
    for (const r of references) {
      const enc = enclosingSymbolId(r.sourcePath, r.line);
      if (enc) m1.add(enc);
      else unenclosed++;
      refDetail.push({ at: `${r.sourcePath}:${r.line}`, conf: r.provenance.confidence, enclosing: enc ?? null });
    }
    const b0 = b0Set(t.goal);
    const seedFile = fileById.get(seed.fileId);
    const b1 = b1Set(seedFile.path, edges);
    const m1pr = pr(m1, t.relevant);
    const b0pr = pr(b0.set, t.relevant);
    const b1pr = pr(b1.set, t.relevant);
    taskRows.push({
      id: t.id, seed: t.seed, goal: t.goal,
      relevant: t.relevant,
      m1: { set: [...m1].sort(), ...m1pr, refCount: references.length, unenclosedRefs: unenclosed, refs: refDetail },
      b0: { set: [...b0.set].sort(), ...b0pr, keywords: b0.keywords },
      b1: { set: [...b1.set].sort(), ...b1pr, files: b1.files },
    });
  }

  const macro = (k, m) => taskRows.reduce((a, r) => a + r[m][k], 0) / taskRows.length;
  const micro = (m) => {
    const tp = taskRows.reduce((a, r) => a + r[m].tp, 0);
    const fp = taskRows.reduce((a, r) => a + r[m].fp, 0);
    const fn = taskRows.reduce((a, r) => a + r[m].fn, 0);
    return { tp, fp, fn, precision: tp / (tp + fp), recall: tp / (tp + fn) };
  };
  const summary = {
    macro: {
      m1: { precision: macro("precision", "m1"), recall: macro("recall", "m1") },
      b0: { precision: macro("precision", "b0"), recall: macro("recall", "b0") },
      b1: { precision: macro("precision", "b1"), recall: macro("recall", "b1") },
    },
    micro: { m1: micro("m1"), b0: micro("b0"), b1: micro("b1") },
    gates: {
      precision_ge_095: macro("precision", "m1") >= 0.95,
      recall_ge_b1: macro("recall", "m1") >= macro("recall", "b1"),
      recall_gt_b0: macro("recall", "m1") > macro("recall", "b0"),
    },
  };

  // Calibration: global unresolved.
  const unresolvedActual = graph.unresolved.map((u) => ({ name: u.name, sourcePath: u.sourcePath, reason: u.reason }));
  const unresolvedChecks = gold.calibration.globalUnresolved.map((g) => ({
    ...g,
    found: graph.unresolved.some((u) => u.name === g.name && u.sourcePath === g.sourcePath && u.reason.includes(g.reasonContains)),
  }));
  const ambiguousRefs = graph.references.filter((r) => r.provenance.confidence === "ambiguous");

  // Calibration: per-task touched-unresolved.
  const touched = {};
  for (const t of gold.tasks) {
    const ids = new Set([...t.relevant, t.seed]);
    const files = new Set([...ids].map((id) => symById.get(id)?.fileId));
    const names = new Set([...ids].map((id) => symById.get(id)?.name));
    const hits = graph.unresolved.filter((u) => files.has(u.sourceFileId) || names.has(u.name));
    const exp = gold.calibration.touchedUnresolvedPerTask[t.id];
    const pass = exp === "0" ? hits.length === 0 : hits.length >= 1;
    touched[t.id] = { expected: exp, actual: hits.length, pass, hits: hits.map((u) => `${u.sourcePath}#${u.name}`) };
  }

  // Exact-claim audit: exact refs whose enclosing symbol is outside task gold.
  const wrongExact = [];
  for (const row of taskRows) {
    const rel = new Set(row.relevant);
    for (const r of row.m1.refs) {
      if (r.conf === "exact" && r.enclosing && !rel.has(r.enclosing)) {
        wrongExact.push({ task: row.id, ref: r.at, enclosing: r.enclosing });
      }
    }
  }

  // fileDeps audit.
  const depRows = graph.fileDeps.map((d) => ({
    from: fileById.get(d.fromFileId)?.path, to: d.toFileId ? fileById.get(d.toFileId)?.path : null,
    specifier: d.specifier, resolved: d.resolved,
  }));
  const unresolvedSpecs = [...new Set(depRows.filter((d) => !d.resolved).map((d) => d.specifier))].sort();

  // Incremental equality.
  const inc = await pilot.buildIncremental(graph, gold.incremental.changedPaths);
  const full = await pilot.build();
  const incrementalEqual = JSON.stringify(inc) === JSON.stringify(full);
  let invalidRejected = false;
  try {
    await pilot.buildIncremental(graph, ["/abs/path.ts"]);
  } catch { invalidRejected = true; }

  const results = {
    generatedAt: new Date().toISOString(),
    gateBars: "macro precision >= 0.95; macro recall >= B1 AND > B0 (docs/GATES.md; measured, never changed)",
    summary,
    calibration: {
      unresolvedCount: graph.unresolved.length,
      unresolvedExpected: gold.calibration.globalUnresolvedCount,
      unresolvedChecks,
      ambiguousRefCount: ambiguousRefs.length,
      ambiguousRefs: ambiguousRefs.map((r) => ({ at: `${r.sourcePath}:${r.line}`, key: r.targetSymbolKey, candidates: r.provenance.candidates.map((c) => c.symbolId) })),
      touchedUnresolvedPerTask: touched,
      touchedPassCount: Object.values(touched).filter((t) => t.pass).length,
      wrongExactRefs: wrongExact,
    },
    fileDeps: { count: depRows.length, expected: gold.fileDeps.expectedDepCount, unresolvedSpecifiers: unresolvedSpecs, deps: depRows },
    incremental: { equal: incrementalEqual, expected: gold.incremental.expectedEquality, invalidPathRejected: invalidRejected },
    graphCounts: { references: graph.references.length, unresolved: graph.unresolved.length, fileDeps: graph.fileDeps.length, snapshotId: graph.snapshotId },
    tasks: taskRows,
  };
  fs.writeFileSync(path.join(SPIKE_DIR, "results.json"), JSON.stringify(results, null, 2));

  // Console report.
  const f3 = (n) => n.toFixed(3);
  console.log("task  seed      M1 P/R      B0 P/R      B1 P/R      |M1| rel");
  for (const r of taskRows) {
    console.log(
      `${r.id.padEnd(5)} ${r.seed.padEnd(9)} ${f3(r.m1.precision)}/${f3(r.m1.recall)}  ${f3(r.b0.precision)}/${f3(r.b0.recall)}  ${f3(r.b1.precision)}/${f3(r.b1.recall)}  ${String(r.m1.set.length).padStart(3)} ${String(r.relevant.length).padStart(3)}  M1={${r.m1.set.join(",")}}`
    );
  }
  console.log("----");
  console.log(`MACRO  M1 P=${f3(summary.macro.m1.precision)} R=${f3(summary.macro.m1.recall)} | B0 P=${f3(summary.macro.b0.precision)} R=${f3(summary.macro.b0.recall)} | B1 P=${f3(summary.macro.b1.precision)} R=${f3(summary.macro.b1.recall)}`);
  console.log(`MICRO  M1 P=${f3(summary.micro.m1.precision)} R=${f3(summary.micro.m1.recall)} | B0 P=${f3(summary.micro.b0.precision)} R=${f3(summary.micro.b0.recall)} | B1 P=${f3(summary.micro.b1.precision)} R=${f3(summary.micro.b1.recall)}`);
  console.log(`GATES  P>=0.95: ${summary.gates.precision_ge_095} | R>=B1: ${summary.gates.recall_ge_b1} | R>B0: ${summary.gates.recall_gt_b0}`);
  console.log(`CALIB  unresolved=${graph.unresolved.length}/4 checks=${unresolvedChecks.filter((c) => c.found).length}/4 ambiguousRefs=${ambiguousRefs.length} touchedPass=${results.calibration.touchedPassCount}/20 wrongExact=${wrongExact.length}`);
  console.log(`DEPS   count=${depRows.length}/12 unresolvedSpecs=[${unresolvedSpecs.join(",")}]`);
  console.log(`INCR   equal=${incrementalEqual} invalidRejected=${invalidRejected}`);
}

main().catch((e) => { console.error("RUNNER FAILED:", e); process.exit(1); });
