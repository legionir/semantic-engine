#!/usr/bin/env node
"use strict";

/*
| Launcher for the semantic-engine CLI.
|
| Deliberately tiny and dependency-free: everything it does is resolve
| the compiled entry point and forward the exit code. A build that has
| not been run yet is a common first mistake, so it says so rather than
| printing a module resolution stack trace.
*/

const path = require("path");
const fs = require("fs");

const MAIN = path.join(__dirname, "..", "dist", "cli", "main.js");

if (!fs.existsSync(MAIN)) {
    process.stderr.write(
        "semantic-engine is not built.\n" +
        `expected ${MAIN}\n` +
        "run \"npm run build\" in the package directory.\n"
    );
    process.exit(1);
}

require(MAIN)
    .main(process.argv.slice(2))
    .then(code => {
        process.exitCode = code;
    })
    .catch(error => {
        process.stderr.write(`${(error && error.message) || error}\n`);
        process.exitCode = 1;
    });
