#!/usr/bin/env node
"use strict";

/*
| Golden snapshot
| ---------------
|
|   node scripts/snapshot.js            compare against the stored golden
|   node scripts/snapshot.js --update   overwrite the golden
|
| The blocks after this one deliberately change what the pipeline emits.
| Without a recorded baseline there is no way to tell an intended change
| from a break, so every phase compares against this and updates it with
| the diff reviewed by hand.
|
| Values that move on their own - timestamps, absolute paths, the host's
| line endings - are normalised away. Everything else is compared byte
| for byte.
*/

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const FIXTURE = path.join(ROOT, "test-fixture");
const GOLDEN_DIR = path.join(ROOT, "test", "golden");
const WORK = path.join(ROOT, "tmp-snapshot");

const UPDATE = process.argv.includes("--update");


/*
| Fields that change between runs on the same input. Dropping them is
| the difference between a snapshot that catches regressions and one
| that cries wolf on every run.
*/

const VOLATILE = new Set([
    "generatedAt",
    /*
    | Phase 24 added rootPath, which is the absolute path of the
    | workspace and therefore different on every machine. That is the
    | whole point of the field (SE-EXP-05) and also the reason it can
    | never be compared byte for byte.
    */
    "rootPath",
    "modified",
    "lastCommitDate",
    "lastCommitHash",
    "commitCount",
    "topContributors",
    "hotspotScore",
    "churnRank",
    "lastSyncedCommit",
    "driftScore",
    "id",             // blueprint meta id folds in generatedAt
    "size",           // differs on checkout when line endings are rewritten
    "hash"
]);

/* Kept even though the name matches: these are stable identifiers. */
const KEEP_ID_UNDER = new Set([
    "files", "symbols", "nodes", "edges", "callGraph", "typeGraph",
    "dependencyGraph", "reverseDependencyGraph", "vectorChunks",
    "moduleMap", "symbolIndex", "technicalConstraints", "apiMap"
]);


/*
| `keepIds` is the parent context and it is inherited by the whole subtree:
| once inside `files`, `symbols`, `nodes`, ... every `id` is a stable
| identifier. The previous version passed the child's own key as the parent
| key, so an `id` that sat one level below a keep-container (an object
| keyed by name, a nested entry) lost the context and was replaced by
| "<volatile>" - the snapshot then could not notice an identity change.
*/
function normalise(value, keepIds = false) {

    if (Array.isArray(value)) {
        return value.map(item => normalise(item, keepIds));
    }

    if (value && typeof value === "object") {

        const out = {};

        for (const name of Object.keys(value).sort()) {

            const isVolatile =
                VOLATILE.has(name) &&
                !(name === "id" && keepIds);

            out[name] =
                isVolatile
                    ? "<volatile>"
                    : normalise(value[name], keepIds || KEEP_ID_UNDER.has(name));
        }

        return out;
    }

    if (typeof value === "string") {

        /* Absolute paths and the workspace name leak the machine. */
        return value
            .split(ROOT).join("<root>")
            .split(FIXTURE).join("<fixture>")
            .replace(/\r\n/g, "\n");
    }

    return value;
}


function generate() {

    fs.rmSync(WORK, { recursive: true, force: true });
    fs.mkdirSync(WORK, { recursive: true });

    if (!fs.existsSync(FIXTURE)) {
        execFileSync(
            process.execPath,
            [path.join(__dirname, "gen-fixture.js")],
            { stdio: "inherit" }
        );
    }

    /*
    | The pipeline is driven through the compiled output so the snapshot
    | reflects what actually ships, not what ts-jest happens to compile.
    */

    execFileSync(
        process.execPath,
        [path.join(__dirname, "run-pipeline.js"), FIXTURE, WORK],
        { stdio: "inherit" }
    );

    return {
        "project-index.json":
            JSON.parse(fs.readFileSync(path.join(WORK, "project-index.json"), "utf8")),
        "blueprint.json":
            JSON.parse(fs.readFileSync(path.join(WORK, "blueprint.json"), "utf8"))
    };
}


/*
| A diff a person can read. json.stringify of two large trees says
| "they differ" and nothing else, which is useless when the tree has
| eleven thousand symbols in it.
*/

function diff(expected, actual, trail = "", found = []) {

    if (found.length >= 40) {
        return found;
    }

    const bothObjects =
        expected && actual &&
        typeof expected === "object" && typeof actual === "object" &&
        Array.isArray(expected) === Array.isArray(actual);

    if (!bothObjects) {

        if (JSON.stringify(expected) !== JSON.stringify(actual)) {
            found.push(
                `${trail || "(root)"}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`
            );
        }

        return found;
    }

    if (Array.isArray(expected)) {

        if (expected.length !== actual.length) {
            found.push(
                `${trail}: length ${expected.length} -> ${actual.length}`
            );
        }

        const limit = Math.min(expected.length, actual.length);

        for (let i = 0; i < limit; i++) {
            diff(expected[i], actual[i], `${trail}[${i}]`, found);
        }

        return found;
    }

    const keys =
        new Set([...Object.keys(expected), ...Object.keys(actual)]);

    for (const key of [...keys].sort()) {

        if (!(key in expected)) {
            found.push(`${trail}.${key}: added`);
            continue;
        }

        if (!(key in actual)) {
            found.push(`${trail}.${key}: removed`);
            continue;
        }

        diff(expected[key], actual[key], `${trail}.${key}`, found);
    }

    return found;
}


function main() {

    const produced = generate();

    fs.mkdirSync(GOLDEN_DIR, { recursive: true });

    let failures = 0;

    for (const [name, value] of Object.entries(produced)) {

        const goldenPath =
            path.join(GOLDEN_DIR, name.replace(".json", ".golden.json"));

        const normalised = normalise(value);

        if (UPDATE || !fs.existsSync(goldenPath)) {

            fs.writeFileSync(
                goldenPath,
                JSON.stringify(normalised, null, 2) + "\n",
                "utf8"
            );

            console.log(`wrote ${path.relative(ROOT, goldenPath)}`);

            continue;
        }

        const golden =
            JSON.parse(fs.readFileSync(goldenPath, "utf8"));

        const problems = diff(golden, normalised);

        if (problems.length === 0) {
            console.log(`${name}: unchanged`);
            continue;
        }

        failures++;

        console.error(`\n${name}: ${problems.length} difference(s)\n`);

        for (const problem of problems) {
            console.error(`  ${problem}`);
        }

        console.error(
            `\n  If the change is intended, review it and run:\n` +
            `    npm run snapshot:update\n`
        );
    }

    fs.rmSync(WORK, { recursive: true, force: true });

    process.exit(failures === 0 ? 0 : 1);
}


if (require.main === module) {
    main();
}

module.exports = { normalise, diff };
