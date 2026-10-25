#!/usr/bin/env node
"use strict";

/*
| Schema validator
| ----------------
|
| Validates a generated artefact against its contract.
|
|   node scripts/validate-schema.js project-index path/to/project-index.json
|   node scripts/validate-schema.js blueprint     path/to/blueprint.json
|
| Exit code 0 and "validation passed" on success; 1 and a readable list
| of violations otherwise. Kept dependency-light on purpose: ajv is
| already a declared dependency and nothing else is needed.
*/

const fs = require("fs");
const path = require("path");

const Ajv = require("ajv/dist/2020");
const addFormats = require("ajv-formats");

const CONTRACTS = path.join(__dirname, "..", "contracts");

const SCHEMAS = {
    "project-index": "project-index.schema.json",
    blueprint: "blueprint.schema.json"
};


function usage(message) {

    if (message) {
        console.error(`error: ${message}\n`);
    }

    console.error(
        "usage: validate-schema.js <project-index|blueprint> <file.json>"
    );

    process.exit(1);
}


/*
| A raw ajv error is written for tooling, not for a person. "must have
| required property 'x'" with an instancePath of "/files/17" is turned
| into something that says which file entry is at fault.
*/

function describe(error) {

    const where = error.instancePath || "(root)";

    if (error.keyword === "required") {
        return `${where}: missing required property "${error.params.missingProperty}"`;
    }

    if (error.keyword === "additionalProperties") {
        return `${where}: unexpected property "${error.params.additionalProperty}"`;
    }

    if (error.keyword === "enum") {
        return `${where}: ${error.message} (${error.params.allowedValues.join(", ")})`;
    }

    return `${where}: ${error.message}`;
}


function main() {

    const [kind, target] = process.argv.slice(2);

    if (!kind || !target) {
        usage("both a schema name and a file are required");
    }

    if (!SCHEMAS[kind]) {
        usage(`unknown schema "${kind}", expected one of: ${Object.keys(SCHEMAS).join(", ")}`);
    }

    if (!fs.existsSync(target)) {
        usage(`file not found: ${target}`);
    }

    const schema =
        JSON.parse(
            fs.readFileSync(path.join(CONTRACTS, SCHEMAS[kind]), "utf8")
        );

    const ajv = new Ajv({ allErrors: true, strict: false });

    addFormats(ajv);

    const validate = ajv.compile(schema);

    const data =
        JSON.parse(fs.readFileSync(target, "utf8"));

    if (validate(data)) {

        console.log(`${kind} validation passed: ${target}`);

        process.exit(0);
    }

    const problems =
        (validate.errors || []).map(describe);

    console.error(
        `${kind} validation failed: ${target}\n`
    );

    /*
    | A file with one wrong field produces hundreds of errors once the
    | failure cascades through anyOf branches. The first twenty are the
    | ones worth reading.
    */

    for (const problem of problems.slice(0, 20)) {
        console.error(`  ${problem}`);
    }

    if (problems.length > 20) {
        console.error(`  ... and ${problems.length - 20} more`);
    }

    process.exit(1);
}


main();
