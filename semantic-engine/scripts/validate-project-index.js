#!/usr/bin/env node
"use strict";

/*
| Project index validator
| -----------------------
|
|   node scripts/validate-project-index.js path/to/project-index.json
|
| Schema validation plus the invariants a schema cannot express:
| references that point at nothing, duplicate ids, ranges that run
| backwards. A file can satisfy the contract and still be incoherent,
| and an incoherent index is worse than a missing one because whatever
| reads it will answer confidently and wrongly.
*/

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");


function fail(message) {

    console.error(`error: ${message}`);

    process.exit(1);
}


/*
| Referential checks. Each returns a list of complaints so one run
| reports everything wrong rather than the first thing wrong.
*/

function checkFileIds(index) {

    const problems = [];
    const seen = new Set();

    for (const file of index.files || []) {

        if (seen.has(file.id)) {
            problems.push(`duplicate file id ${file.id} (${file.path})`);
        }

        seen.add(file.id);
    }

    return problems;
}


function checkSymbolIds(index) {

    const problems = [];
    const seen = new Set();
    const fileIds = new Set((index.files || []).map(file => file.id));
    const lineCount = new Map((index.files || []).map(file => [file.id, file.lines]));

    for (const symbol of index.symbols || []) {

        if (seen.has(symbol.id)) {
            problems.push(`duplicate symbol id ${symbol.id} (${symbol.name})`);
        }

        seen.add(symbol.id);

        if (!fileIds.has(symbol.fileId)) {
            problems.push(
                `symbol ${symbol.name} points at unknown file ${symbol.fileId}`
            );
        }

        if (symbol.endLine < symbol.line) {
            problems.push(
                `symbol ${symbol.name} ends before it starts (${symbol.line} > ${symbol.endLine})`
            );
        }

        /*
        | Until phase 14 every endLine equalled line, so a range could not
        | run off the end of the file and there was nothing to check. Now
        | that block ends are computed, an unbalanced brace or a bad tag
        | match can push one past the last line - which then silently
        | truncates or over-reads for every consumer that slices source by
        | range.
        */
        const lines = lineCount.get(symbol.fileId);

        if (lines !== undefined && symbol.endLine > lines) {
            problems.push(
                `symbol ${symbol.name} ends at line ${symbol.endLine}, ` +
                `past the end of its ${lines}-line file`
            );
        }
    }

    return problems;
}


function checkSymbolParents(index) {

    const problems = [];
    const symbolIds = new Set((index.symbols || []).map(symbol => symbol.id));

    for (const symbol of index.symbols || []) {

        if (symbol.parentId && !symbolIds.has(symbol.parentId)) {
            problems.push(
                `symbol ${symbol.name} has parent ${symbol.parentId}, which does not exist`
            );
        }
    }

    return problems;
}


function checkFileSymbolLinks(index) {

    const problems = [];
    const symbolIds = new Set((index.symbols || []).map(symbol => symbol.id));

    for (const file of index.files || []) {

        for (const id of file.symbolIds || []) {

            if (!symbolIds.has(id)) {
                problems.push(`${file.path} lists unknown symbol ${id}`);
            }
        }
    }

    return problems;
}


function checkResolvedImports(index) {

    const problems = [];
    const fileIds = new Set((index.files || []).map(file => file.id));

    for (const file of index.files || []) {

        for (const entry of file.imports || []) {

            if (entry.resolvedFileId && !fileIds.has(entry.resolvedFileId)) {
                problems.push(
                    `${file.path} resolves "${entry.from}" to unknown file ${entry.resolvedFileId}`
                );
            }
        }
    }

    return problems;
}


function checkVectorChunks(index) {

    const problems = [];
    const fileIds = new Set((index.files || []).map(file => file.id));
    const symbolIds = new Set((index.symbols || []).map(symbol => symbol.id));

    for (const chunk of index.vectorChunks || []) {

        if (!fileIds.has(chunk.fileId)) {
            problems.push(`chunk ${chunk.id} points at unknown file ${chunk.fileId}`);
        }

        if (chunk.symbolId && !symbolIds.has(chunk.symbolId)) {
            problems.push(`chunk ${chunk.id} points at unknown symbol ${chunk.symbolId}`);
        }

        if (chunk.endLine < chunk.startLine) {
            problems.push(`chunk ${chunk.id} ends before it starts`);
        }
    }

    return problems;
}


/*
| Graph edges are deliberately not checked for dangling references yet.
| dependencyGraph.to holds a file id for a local import and a bare
| package name for anything else, so "unknown id" cannot be told from
| "package". Phase 19 separates the two namespaces; the check belongs
| with that change, not before it.
*/

/*
| Dangling graph edges - SE-EXP-11.
|
| This check could not be written before phase 19. DependencyEdge.to held
| either a fileId or a raw module name, so an id that resolved to nothing was
| indistinguishable from a package that legitimately is not a file, and the
| graph stayed a blind spot in validation. Now that anything which is not a
| file of this project carries a pkg: prefix, the two are separable and a
| dangling reference is a real error again.
*/
function checkGraphEdges(index) {

    const problems = [];
    const graphs = index.graphs || {};

    const fileIds = new Set((index.files || []).map(file => file.id));
    const symbolIds = new Set((index.symbols || []).map(symbol => symbol.id));
    const anyId = new Set([...fileIds, ...symbolIds]);

    const isPackage = value => typeof value === "string" && value.startsWith("pkg:");

    for (const edge of graphs.dependencyGraph || []) {

        if (!fileIds.has(edge.from)) {
            problems.push(`dependency edge starts at unknown file ${edge.from}`);
        }

        if (!isPackage(edge.to) && !fileIds.has(edge.to)) {
            problems.push(
                `dependency edge points at ${edge.to}, which is neither a file ` +
                `of this project nor a pkg: reference`
            );
        }
    }

    for (const edge of graphs.typeGraph || []) {

        for (const [role, id] of [["parent", edge.parent], ["child", edge.child]]) {
            if (!symbolIds.has(id)) {
                problems.push(`type edge ${role} ${id} is not a known symbol`);
            }
        }
    }

    /*
    | A call edge's callee may legitimately be an external name rather than an
    | id - that is what basis "unresolved" records. The caller, though, is
    | always meant to be something this index knows about.
    */
    for (const edge of graphs.callGraph || []) {

        if (!anyId.has(edge.caller)) {
            problems.push(`call edge caller ${edge.caller} is not a known file or symbol`);
        }

        if (edge.provenance && edge.provenance.basis !== "unresolved" && !anyId.has(edge.callee)) {
            problems.push(
                `call edge callee ${edge.callee} claims basis ` +
                `${edge.provenance.basis} but is not a known id`
            );
        }
    }

    return problems;
}


function checkEdgeProvenance(index) {

    const problems = [];
    const graphs = index.graphs || {};

    const groups = [
        ["callGraph", graphs.callGraph],
        ["typeGraph", graphs.typeGraph],
        ["dependencyGraph", graphs.dependencyGraph],
        ["reverseDependencyGraph", graphs.reverseDependencyGraph]
    ];

    for (const [name, edges] of groups) {

        for (const edge of edges || []) {

            if (!edge.provenance) {
                problems.push(`${name} has an edge with no provenance`);
                continue;
            }

            const { confidence, basis, extractor } = edge.provenance;

            if (typeof confidence !== "number" || confidence < 0 || confidence > 100) {
                problems.push(`${name} edge has confidence ${confidence}, outside 0..100`);
            }

            if (!basis || !extractor) {
                problems.push(`${name} edge provenance is missing basis or extractor`);
            }
        }
    }

    return problems;
}


const CHECKS = [
    ["file ids", checkFileIds],
    ["symbol ids", checkSymbolIds],
    ["symbol parents", checkSymbolParents],
    ["file to symbol links", checkFileSymbolLinks],
    ["resolved imports", checkResolvedImports],
    ["vector chunks", checkVectorChunks],
    ["graph edges", checkGraphEdges],
    ["edge provenance", checkEdgeProvenance]
];


function main() {

    const target = process.argv[2];

    if (!target) {
        fail("usage: validate-project-index.js <project-index.json>");
    }

    if (!fs.existsSync(target)) {
        fail(`file not found: ${target}`);
    }

    /*
    | Schema first: a structurally broken file makes every referential
    | complaint below it noise.
    */

    try {

        execFileSync(
            process.execPath,
            [
                path.join(__dirname, "validate-schema.js"),
                "project-index",
                target
            ],
            { stdio: ["ignore", "pipe", "inherit"] }
        );

    } catch {

        fail("schema validation failed, see above");
    }

    const index =
        JSON.parse(fs.readFileSync(target, "utf8"));

    const problems = [];

    for (const [name, check] of CHECKS) {

        for (const problem of check(index)) {
            problems.push(`[${name}] ${problem}`);
        }
    }

    if (problems.length > 0) {

        console.error(`project-index validation failed: ${target}\n`);

        for (const problem of problems.slice(0, 20)) {
            console.error(`  ${problem}`);
        }

        if (problems.length > 20) {
            console.error(`  ... and ${problems.length - 20} more`);
        }

        process.exit(1);
    }

    console.log(
        `Validation passed: ${target}\n` +
        `  ${(index.files || []).length} files, ` +
        `${(index.symbols || []).length} symbols, ` +
        `${(index.vectorChunks || []).length} chunks`
    );
}


main();
