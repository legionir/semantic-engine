#!/usr/bin/env node
"use strict";

/*
| Audit bookkeeping check
| -----------------------
|
|   node scripts/check-audit-coverage.js
|
| Two invariants over AUDIT-2026-08.md and EXECUTION-PLAN.md:
|
|   1. every finding id is assigned to a phase in the coverage tables
|   2. every finding id is used exactly once as a heading
|   3. every GAP the plan calls fixed is also marked fixed in the gaps doc
|
| The second one is new. Until phase 48 the check only asked the first
| question, and three id collisions slipped through in phases 40, 47 and
| 48 — a new finding reusing an id that already belonged to another one.
| The coverage table still looked complete, because both findings mapped
| to the same cell.
|
| The third is newer still. Phase 49 found five gaps that the plan had
| recorded as fixed for up to thirty phases while GRAPH-INTELLIGENCE-GAPS.md
| still opened them with a red cross. Nothing was wrong with the code; the
| document that a reader reaches for first was simply stale. Two documents
| that disagree are worse than one, because the reader cannot tell which
| one nobody is maintaining.
*/

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const AUDIT = path.join(ROOT, "AUDIT-2026-08.md");
const PLAN = path.join(ROOT, "EXECUTION-PLAN.md");
const GAPS = path.join(ROOT, "GRAPH-INTELLIGENCE-GAPS.md");

/*
| Preflight (Phase 0, 2026-09-21): the three inputs have never been
| committed to this repository — not at docs/audit-file-status, not on
| main. Until the owner supplies them, this check is unsatisfiable no
| matter what the code does, and the raw ENOENT stack hid that. Fail
| with the named gap instead of an exception trace.
*/
const missingInputs = [AUDIT, PLAN, GAPS].filter(file => !fs.existsSync(file));
if (missingInputs.length > 0) {
    console.error("check:audit cannot run — input documents are not in this repository:");
    for (const file of missingInputs) {
        console.error(`  missing: ${path.basename(file)} (expected at ${path.relative(ROOT, file)})`);
    }
    console.error("These audit documents exist outside this repo; ask the owner to commit them.");
    process.exit(1);
}

const audit = fs.readFileSync(AUDIT, "utf8");
const plan = fs.readFileSync(PLAN, "utf8");
const gaps = fs.readFileSync(GAPS, "utf8");

const ids = new Set();
for (const match of audit.matchAll(/SE-([A-Z]+)-(\d+)/g)) {
    ids.add(`${match[1]}-${match[2]}`);
}

/* ── 1. coverage ──────────────────────────────────────────────────── */

const start = plan.indexOf("### AUDIT —");
const end = plan.indexOf("### MIGRATION —");

if (start === -1 || end === -1) {
    console.error("error: could not find the AUDIT coverage table in the plan");
    process.exit(1);
}

const covered = new Set();
for (const line of plan.slice(start, end).split("\n")) {
    const match = /^\|\s*([A-Z]+)\s*\|\s*([0-9,\s]+)\|/.exec(line);
    if (!match) continue;
    for (const num of match[2].split(",")) {
        const trimmed = num.trim();
        if (trimmed) covered.add(`${match[1]}-${trimmed}`);
    }
}

const missing = [...ids].filter(id => !covered.has(id)).sort();

/* ── 2. uniqueness ────────────────────────────────────────────────── */

const headingCounts = new Map();
for (const match of audit.matchAll(/^\*\*[🔴🟠🟡🔵]\s*SE-([A-Z]+-\d+)\s*[—-]/gm)) {
    const id = match[1];
    headingCounts.set(id, (headingCounts.get(id) ?? 0) + 1);
}
const duplicated = [...headingCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id, count]) => `${id} (${count}×)`)
    .sort();

/* ── 3. gap statuses agree ────────────────────────────────────────── */

/*
| The plan's GRAPH GAPS table is the schedule; the gaps document is the
| explanation. Only one direction is checked: a gap the plan calls fixed
| must not still be open in the gaps document. The reverse is fine — a
| gap can be closed early and the plan row updated later.
*/
const planSaysFixed = new Set();
for (const match of plan.matchAll(/GAP-(\d+)\s*\|\s*[^|\n]*رفع‌شده/g)) {
    planSaysFixed.add(`GAP-${match[1]}`);
}

const gapsSaysFixed = new Set();
for (const match of gaps.matchAll(/^### (GAP-\d+)[^\n]*\n\*\*وضعیت:\*\*\s*✅/gm)) {
    gapsSaysFixed.add(match[1]);
}

const stale = [...planSaysFixed].filter(id => !gapsSaysFixed.has(id)).sort();

/* ── report ───────────────────────────────────────────────────────── */

console.log(`audit findings: ${ids.size}`);

let failed = false;

if (missing.length > 0) {
    failed = true;
    console.error(`\nerror: ${missing.length} finding(s) not assigned to a phase:`);
    for (const id of missing) console.error(`  SE-${id}`);
}

if (stale.length > 0) {
    failed = true;
    console.error(
        `\nerror: ${stale.length} gap(s) the plan calls fixed are still open in ` +
        "GRAPH-INTELLIGENCE-GAPS.md:"
    );
    for (const id of stale) console.error(`  ${id}`);
}

if (duplicated.length > 0) {
    failed = true;
    console.error(`\nerror: ${duplicated.length} id(s) used by more than one finding:`);
    for (const id of duplicated) console.error(`  SE-${id}`);
    console.error(
        "\nA reused id makes two different findings share one coverage cell,\n" +
        "so the table looks complete while one of them is unassigned."
    );
}

if (failed) process.exit(1);

console.log(`graph gaps marked fixed: ${planSaysFixed.size}`);
console.log(
    "every finding is assigned to a phase, every id is unique, and the two documents agree"
);
