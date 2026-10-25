#!/usr/bin/env node
"use strict";

/*
| Test gate
| ---------
|
|   node scripts/check-tests.js
|
| Runs the suite and fails unless *every* suite ran — or the number of
| suite-level skips stays inside test-skip-budget.json (SE-F-049).
|
| Why this exists: a jest suite that fails to compile contributes zero
| tests, so the "Tests:" line keeps reporting a healthy, and even a
| growing, number while suites quietly stop running. Five suites stopped
| running when a required field was added in phase 19 and stayed dead
| through two more phases, because the passing test count went up the
| whole time - 1072 passed, five suites dead.
|
| Reading the exit code is enough on its own. The point of this script is
| that it prints the two numbers next to each other, so the failure mode
| is visible rather than something you have to know to look for.
| Recorded as SE-BUILD-11.
*/

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

const result = spawnSync(
    "npx",
    ["jest", "--ci"],
    { cwd: ROOT, encoding: "utf8" }
);

/* Jest writes its summary to stderr. */
const output = `${result.stdout || ""}${result.stderr || ""}`;

/*
| ~10 suites (gateway e2e, CLI, LSP client) run against dist/ and silently skip when it is
| missing; globalSetup says so in its output. Failing here replaces the second Jest run CI used
| to make only to grep for that line.
*/
if (/dist\/ is not built/.test(output)) {
    console.error("error: dist/ is not built, so the dist-gated suites were skipped. Run `npm run build` first.");
    process.exit(1);
}

const suites = output.match(/Test Suites:.*/);
const tests = output.match(/Tests:.*/);

console.log(suites ? suites[0] : "Test Suites: (not reported)");
console.log(tests ? tests[0] : "Tests: (not reported)");

/*
| Which tests failed, not just how many.
|
| Phase 36: one run in six failed with a single red test, and the only
| thing this script printed was "1 failed". Re-running turned it green
| and the evidence was gone - which is the worst outcome for a flake,
| because the next person concludes it was nothing.
|
| Jest already names them; the summary block just was not being passed
| through. Recorded as SE-BUILD-15.
*/
function failedTestNames() {
    const names = [];
    for (const line of output.split("\n")) {
        const bullet = /^\s*●\s+(.+?)\s*$/.exec(line);
        if (bullet && !/Console|Test suite failed to run/.test(bullet[1])) {
            names.push(bullet[1]);
        }
        const cross = /^\s*✕\s+(.+?)(?:\s+\(\d+\s*m?s\))?\s*$/.exec(line);
        if (cross) names.push(cross[1]);
    }
    return Array.from(new Set(names));
}

function reportFailures() {
    const names = failedTestNames();
    if (names.length === 0) return;
    console.error("\nfailing tests:");
    for (const name of names) console.error(`  ${name}`);
}

const failedSuites = /Test Suites:.*?(\d+) failed/.exec(output);

if (failedSuites) {
    reportFailures();
    console.error(
        `\nerror: ${failedSuites[1]} test suite(s) did not run.\n` +
        `A suite that fails to compile reports zero tests, so the test count\n` +
        `stays green while the suite is dead. Fix the suite, do not ignore it.`
    );
    process.exit(1);
}

if (result.status !== 0) {
    reportFailures();
    console.error("\nerror: the test run failed");
    process.exit(result.status ?? 1);
}

if (!suites) {
    console.error("\nerror: could not read the suite summary from jest output");
    process.exit(1);
}

/*
| Skipped suites are named and bounded (SE-F-049).
|
| The header of this file promises: "fails unless *every* suite ran". A run
| where 10 of 267 suites are `describe.skip`-gated (the dist-built e2e suites)
| satisfied the old gate while printing "all suites ran" - the promise and the
| surface of trust diverged, which is exactly the failure mode this script
| exists to catch. Honest states:
|   - suites did not RUN because they failed to compile  → exit 1 (old check).
|   - suites SKIPPED by an environment guard            → allowed, but the
|     count must match the recorded budget and every name is printed, so a
|     NEW silent skip or a shrinking run is still a failure.
| The budget lives in test-skip-budget.json: raise it deliberately (with the
| reason next to the suite), never implicitly by re-running a red CI.
*/
const skippedSuites = /Test Suites:.*?(\d+) skipped/.exec(output);
const skipCount = skippedSuites ? Number(skippedSuites[1]) : 0;

const BUDGET_FILE = path.join(ROOT, "test-skip-budget.json");
let budget = 0;
try {
    budget = JSON.parse(fs.readFileSync(BUDGET_FILE, "utf8")).suites;
    /* CI can tighten the budget when it provides the optional cross-repo consumer. */
    if (process.env.SEMANTIC_ENGINE_SKIP_BUDGET !== undefined && process.env.SEMANTIC_ENGINE_SKIP_BUDGET !== "") {
        budget = Number(process.env.SEMANTIC_ENGINE_SKIP_BUDGET);
    }
} catch {
    console.error(
        `\nerror: ${BUDGET_FILE} missing/unreadable — the skip budget must exist,\n` +
        "even if it is 0. A gate that cannot bound skips cannot call them honest."
    );
    process.exit(1);
}

if (skipCount > budget) {
    console.error(
        `\nerror: ${skipCount} suite(s) skipped, budget is ${budget} (${BUDGET_FILE}).\n` +
        "Either un-skip/fix the new suite, or raise the budget deliberately with\n" +
        "a recorded reason — do not let a silent skip widen the gap between\n" +
        "'all suites ran' and what actually ran."
    );
    process.exit(1);
}

if (skipCount < budget) {
    console.error(
        `\nwarning: only ${skipCount} of ${budget} budgeted suites skipped — some\n` +
        `previously-skipped suite now runs. Lower the budget in ` +
        `${path.relative(ROOT, BUDGET_FILE)} to keep the gate tight.`
    );
}

console.log(`\nsuites ran; ${skipCount} suite(s) skipped within the recorded budget (${budget}).`);
