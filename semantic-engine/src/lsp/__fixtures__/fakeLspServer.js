#!/usr/bin/env node
"use strict";

/*
| A language server that exists only to be talked to.
| ---------------------------------------------------
|
| `LspClient` has to survive things a healthy server never does: hanging
| on a request, dying mid-conversation, asking the client questions
| before it will finish starting, and printing noise on stderr. None of
| that can be provoked reliably against `tsgo`, so the unit tests drive
| this instead. The integration test drives the real one.
|
| It speaks the wire protocol by hand - Content-Length framing over
| stdio - on purpose. If the client and this file only agreed because
| they share a library, the tests would prove nothing about the framing.
|
| Behaviour is switched with argv flags:
|
|   --stderr-noise      print a burst of lines on stderr at startup
|   --empty-symbols     declare documentSymbol, always answer []
|   --empty-hover       declare hover, always answer null
|   --declare-nothing   answer initialize with no provider capabilities
|   --fail-references   declare references, always answer with an error
|   --no-pull-diagnostics  do not declare diagnosticProvider, fail the request
|   --push-diagnostics  publish diagnostics on didOpen/didChange
|   --diagnostic-error  answer textDocument/diagnostic with an error
|   --unchanged-diagnostics  hand out a resultId and answer "unchanged" the
|                       second time it is presented
|   --always-unchanged  answer "unchanged" even on the first request, which
|                       is what a buggy server does
|   --warmup=N          behave like gopls: report a $/progress "begin" at
|                       startup, answer documentSymbol with [] until N ms
|                       have passed, then report "end"
|   --quiescent=N       send rust-analyzer's experimental/serverStatus with
|                       quiescent:false, then true after N ms
|   --organize-imports  return a real organize-imports action with an edit
|   --rename-outside    answer rename with an edit that points outside the
|                       workspace, which is what a hostile server would do
|   --rename-null       answer rename with null
|   --hang-initialize   never answer `initialize`
|   --no-server-requests  skip the server->client questions
|   --exit-code=N       exit with N after `exit` (default 0)
|   --exit-on-exit-notification=false  ignore `exit` (tests the kill path)
|
| Test-only methods:
|
|   test/state    what the server has seen: open documents and versions,
|                 plus what the client answered to its questions
|   test/hang     never answers
|   test/crash    exits immediately, without a reply
*/

const flags = new Set(process.argv.slice(2).filter(a => !a.includes("=")));
const values = new Map(
    process.argv
        .slice(2)
        .filter(a => a.includes("="))
        .map(a => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)])
);

const warmupMs = Number(values.get("--warmup") ?? 0);
const quiescentMs = Number(values.get("--quiescent") ?? 0);
let warm = warmupMs <= 0;

const state = {
    counts: {},           // method -> how many times it was asked
    documents: new Map(), // uri -> { version, languageId, text }
    closed: [],
    closedWithLanguage: [],
    handshake: {},
    initialized: false,
};

// ── wire ──────────────────────────────────────────────────────────────

function send(message) {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
    process.stdout.write(body);
}

let pendingId = 1;
const pending = new Map();

function ask(method, params) {
    const id = `s${pendingId++}`;
    return new Promise(resolve => {
        pending.set(id, resolve);
        send({ jsonrpc: "2.0", id, method, params });
    });
}

let buffer = Buffer.alloc(0);

process.stdin.on("data", chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const header = buffer.slice(0, headerEnd).toString("ascii");
        const match = /content-length:\s*(\d+)/i.exec(header);
        if (!match) {
            process.stderr.write(`fake-lsp: no content length in ${JSON.stringify(header)}\n`);
            process.exit(1);
        }
        const length = Number(match[1]);
        const start = headerEnd + 4;
        if (buffer.length < start + length) return;
        const body = buffer.slice(start, start + length).toString("utf8");
        buffer = buffer.slice(start + length);
        let message;
        try {
            message = JSON.parse(body);
        } catch (error) {
            process.stderr.write(`fake-lsp: bad json: ${error.message}\n`);
            continue;
        }
        handle(message);
    }
});

// ── behaviour ─────────────────────────────────────────────────────────

/*
| Diagnostics are derived from the text so a test can put an error on a
| known line and assert the line survives the round trip. A real server
| reports 0-based lines; so does this one.
*/
function diagnosticsOf(text) {
    const out = [];
    text.split(/\r?\n/).forEach((line, index) => {
        const match = /(ERROR|WARN|INFO|HINT):\s*(.*)$/.exec(line);
        if (!match) return;
        const severity = { ERROR: 1, WARN: 2, INFO: 3, HINT: 4 }[match[1]];
        out.push({
            range: {
                start: { line: index, character: line.indexOf(match[1]) },
                end: { line: index, character: line.length },
            },
            severity,
            // A number, exactly like tsgo sends - the schema wants a string.
            code: 1000 + index,
            source: "fake-ts",
            message: match[2],
        });
    });
    return out;
}

function publishIfAsked(uri) {
    if (!flags.has("--push-diagnostics")) return;
    const doc = state.documents.get(uri);
    send({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: { uri, diagnostics: diagnosticsOf(doc ? doc.text : "") },
    });
}

/*
| Rename edits computed from the stored text: find the word under the
| requested position and replace every occurrence of it. Crude, but it
| produces a real WorkspaceEdit against real content, which is what the
| applier needs to be tested against.
*/
function renameEdits(params) {
    const uri = params.textDocument.uri;
    const doc = state.documents.get(uri);
    if (!doc) return {};
    const lines = doc.text.split(/\r?\n/);
    const line = lines[params.position.line] ?? "";
    const before = line.slice(0, params.position.character);
    const after = line.slice(params.position.character);
    const start = /[A-Za-z0-9_$]*$/.exec(before)[0];
    const end = /^[A-Za-z0-9_$]*/.exec(after)[0];
    const word = start + end;
    if (!word) return {};

    const edits = [];
    lines.forEach((text, index) => {
        const pattern = new RegExp(`\\b${word}\\b`, "g");
        let match;
        while ((match = pattern.exec(text)) !== null) {
            edits.push({
                range: {
                    start: { line: index, character: match.index },
                    end: { line: index, character: match.index + word.length },
                },
                newText: params.newName,
            });
        }
    });
    return { [uri]: edits };
}

function zeroRange() {
    return { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
}

function symbolsOf(text) {
    // Deliberately crude: one symbol per `class X` / `function X` / `const X`.
    const out = [];
    text.split(/\r?\n/).forEach((line, index) => {
        const match = /^\s*(?:export\s+)?(class|function|const)\s+([A-Za-z_$][\w$]*)/.exec(line);
        if (!match) return;
        const kind = match[1] === "class" ? 5 : match[1] === "function" ? 12 : 13;
        const character = line.indexOf(match[2]);
        out.push({
            name: match[2],
            kind,
            range: {
                start: { line: index, character: 0 },
                end: { line: index, character: line.length },
            },
            selectionRange: {
                start: { line: index, character },
                end: { line: index, character: character + match[2].length },
            },
            children: [],
        });
    });
    return out;
}

async function askTheClientEverything() {
    /*
    | The three questions real servers ask. `tsgo` asks the first two
    | during startup and waits for both; a client that ignores them
    | leaves the server waiting forever.
    */
    state.handshake.configuration = await ask("workspace/configuration", {
        items: [{ section: "fake" }, { section: "other" }],
    });
    state.handshake.registerCapability = await ask("client/registerCapability", {
        registrations: [{ id: "fake-watch", method: "workspace/didChangeConfiguration" }],
    });
    state.handshake.workDoneProgress = await ask("window/workDoneProgress/create", {
        token: "fake-token",
    });
    send({
        jsonrpc: "2.0",
        method: "$/progress",
        params: { token: "fake-token", value: { kind: "end", message: "ready" } },
    });
}

function handle(message) {
    if (message.id !== undefined && message.method === undefined) {
        const resolve = pending.get(message.id);
        if (resolve) {
            pending.delete(message.id);
            resolve("error" in message ? { error: message.error } : message.result);
        }
        return;
    }

    const { id, method, params } = message;
    state.counts[method] = (state.counts[method] ?? 0) + 1;
    const reply = result => send({ jsonrpc: "2.0", id, result });

    switch (method) {
        case "initialize": {
            if (flags.has("--hang-initialize")) return;
            const providers = flags.has("--declare-nothing")
                ? {}
                : {
                      documentSymbolProvider: true,
                      hoverProvider: true,
                      referencesProvider: true,
                      definitionProvider: true,
                      renameProvider: true,
                      callHierarchyProvider: true,
                      codeActionProvider: true,
                      ...(flags.has("--no-pull-diagnostics")
                          ? {}
                          : {
                                diagnosticProvider: {
                                    identifier: "fake",
                                    interFileDependencies: false,
                                    workspaceDiagnostics: false,
                                },
                            }),
                  };
            reply({
                capabilities: {
                    positionEncoding: "utf-16",
                    textDocumentSync: { openClose: true, change: 1, save: true },
                    ...providers,
                },
                serverInfo: { name: "fake-lsp", version: "1.0.0" },
            });
            return;
        }

        case "initialized":
            state.initialized = true;
            if (warmupMs > 0) {
                send({
                    jsonrpc: "2.0",
                    method: "$/progress",
                    params: { token: "warmup", value: { kind: "begin", title: "Indexing" } },
                });
                setTimeout(() => {
                    warm = true;
                    send({
                        jsonrpc: "2.0",
                        method: "$/progress",
                        params: { token: "warmup", value: { kind: "end" } },
                    });
                }, warmupMs);
            }
            if (quiescentMs > 0) {
                send({
                    jsonrpc: "2.0",
                    method: "experimental/serverStatus",
                    params: { quiescent: false },
                });
                setTimeout(() => {
                    send({
                        jsonrpc: "2.0",
                        method: "experimental/serverStatus",
                        params: { quiescent: true },
                    });
                }, quiescentMs);
            }
            if (!flags.has("--no-server-requests")) void askTheClientEverything();
            return;

        case "textDocument/didOpen": {
            const doc = params.textDocument;
            if (state.documents.has(doc.uri)) {
                process.stderr.write(`fake-lsp: didOpen on an already open document ${doc.uri}\n`);
            }
            state.documents.set(doc.uri, {
                version: doc.version,
                languageId: doc.languageId,
                text: doc.text,
            });
            publishIfAsked(doc.uri);
            return;
        }

        case "textDocument/didChange": {
            const doc = state.documents.get(params.textDocument.uri);
            if (!doc) {
                process.stderr.write(`fake-lsp: didChange on a closed document\n`);
                return;
            }
            doc.version = params.textDocument.version;
            for (const change of params.contentChanges) doc.text = change.text;
            publishIfAsked(params.textDocument.uri);
            return;
        }

        case "textDocument/didClose":
            /*
            | P-05/continuation-9-P-1 probe: the test needs the languageId a
            | document was OPENED with, but by didClose time the entry is
            | gone from `documents` — remember it at close.
            */
            state.closed.push(params.textDocument.uri);
            state.closedWithLanguage.push({
                uri: params.textDocument.uri,
                languageId: (state.documents.get(params.textDocument.uri) || {}).languageId,
            });
            state.documents.delete(params.textDocument.uri);
            return;

        case "textDocument/documentSymbol": {
            const doc = state.documents.get(params.textDocument.uri);
            if (flags.has("--empty-symbols") || !warm) return reply([]);
            reply(doc ? symbolsOf(doc.text) : null);
            return;
        }

        // ── capability probing surface ────────────────────────────────
        case "textDocument/hover":
            reply(flags.has("--empty-hover") ? null : { contents: { kind: "markdown", value: "hi" } });
            return;

        case "textDocument/references":
            if (flags.has("--fail-references")) {
                send({ jsonrpc: "2.0", id, error: { code: -32603, message: "references exploded" } });
                return;
            }
            {
                /*
                | One location per line containing REF, so a test can
                | decide how many references a symbol has. With no REF
                | lines it falls back to a single location, which is
                | what the capability probe expects.
                */
                const doc = state.documents.get(params.textDocument.uri);
                const lines = (doc ? doc.text : "").split(/\r?\n/);
                const found = [];
                lines.forEach((line, index) => {
                    if (!line.includes("REF")) return;
                    found.push({
                        uri: params.textDocument.uri,
                        range: {
                            start: { line: index, character: 0 },
                            end: { line: index, character: line.length },
                        },
                    });
                });
                reply(found.length > 0 ? found : [{ uri: params.textDocument.uri, range: zeroRange() }]);
            }
            return;

        case "textDocument/definition":
            reply([{ uri: params.textDocument.uri, range: zeroRange() }]);
            return;

        case "textDocument/diagnostic": {
            if (flags.has("--no-pull-diagnostics") || flags.has("--diagnostic-error")) {
                send({ jsonrpc: "2.0", id, error: { code: -32601, message: "no diagnostics here" } });
                return;
            }
            const doc = state.documents.get(params.textDocument.uri);
            if (flags.has("--always-unchanged")) {
                reply({ kind: "unchanged", resultId: "r1" });
                return;
            }
            if (flags.has("--unchanged-diagnostics")) {
                if (params.previousResultId === "r1") {
                    reply({ kind: "unchanged", resultId: "r1" });
                    return;
                }
                reply({ kind: "full", resultId: "r1", items: diagnosticsOf(doc ? doc.text : "") });
                return;
            }
            reply({ kind: "full", items: diagnosticsOf(doc ? doc.text : "") });
            return;
        }

        case "textDocument/prepareRename":
            reply({ range: zeroRange(), placeholder: "x" });
            return;

        case "textDocument/prepareCallHierarchy":
            reply([{ name: "x", kind: 12, uri: params.textDocument.uri, range: zeroRange(), selectionRange: zeroRange() }]);
            return;

        case "textDocument/codeAction": {
            if (!flags.has("--organize-imports")) {
                // Declared, and always empty - the trap the probe exists for.
                reply([]);
                return;
            }
            const doc = state.documents.get(params.textDocument.uri);
            const first = (doc ? doc.text : "").split(/\r?\n/)[0] ?? "";
            reply([
                {
                    title: "Organize Imports",
                    kind: "source.organizeImports",
                    edit: {
                        changes: {
                            [params.textDocument.uri]: [
                                {
                                    range: {
                                        start: { line: 0, character: 0 },
                                        end: { line: 1, character: 0 },
                                    },
                                    newText: `${first.trim()} // organized\n`,
                                },
                            ],
                        },
                    },
                },
            ]);
            return;
        }

        case "textDocument/rename": {
            if (flags.has("--rename-null")) return reply(null);
            if (flags.has("--rename-outside")) {
                reply({
                    changes: {
                        "file:///etc/passwd": [
                            {
                                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                                newText: "owned",
                            },
                        ],
                    },
                });
                return;
            }
            reply({ changes: renameEdits(params) });
            return;
        }

        case "callHierarchy/incomingCalls":
            /*
            | P-05/SE-P-002 probe: `f(g(), g())` — the real server reports
            | two `fromRanges` on the SAME line for one incoming item.
            | Without per-range occurrence numbering both edges hash to
            | the same id and any id-keyed map loses one.
            */
            if (flags.has("--dup-ranges")) {
                reply([
                    {
                        from: {
                            name: "caller",
                            kind: 12,
                            uri: params.item.uri,
                            range: { start: { line: 5, character: 0 }, end: { line: 7, character: 1 } },
                            selectionRange: { start: { line: 5, character: 9 }, end: { line: 5, character: 15 } },
                        },
                        fromRanges: [
                            { start: { line: 6, character: 4 }, end: { line: 6, character: 10 } },
                            { start: { line: 6, character: 12 }, end: { line: 6, character: 18 } },
                        ],
                    },
                ]);
                return;
            }
            /*
            | The second entry copies what tsgo really does for a call
            | made at module level: the caller is the file itself,
            | named with its absolute path and reported as kind 2.
            */
            reply([
                {
                    from: {
                        name: "caller",
                        kind: 12,
                        uri: params.item.uri,
                        range: { start: { line: 5, character: 0 }, end: { line: 7, character: 1 } },
                        selectionRange: { start: { line: 5, character: 9 }, end: { line: 5, character: 15 } },
                    },
                    fromRanges: [
                        { start: { line: 6, character: 4 }, end: { line: 6, character: 10 } },
                    ],
                },
                {
                    from: {
                        name: decodeURIComponent(String(params.item.uri).replace("file://", "")),
                        kind: 2,
                        uri: params.item.uri,
                        range: { start: { line: 0, character: 0 }, end: { line: 9, character: 0 } },
                        selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    },
                    fromRanges: [
                        { start: { line: 8, character: 0 }, end: { line: 8, character: 6 } },
                    ],
                },
            ]);
            return;

        case "test/state":
            reply({
                counts: state.counts,
                initialized: state.initialized,
                openDocuments: Array.from(state.documents, ([uri, d]) => ({
                    uri,
                    version: d.version,
                    languageId: d.languageId,
                })),
                closed: state.closed,
                closedWithLanguage: state.closedWithLanguage,
                handshake: state.handshake,
            });
            return;

        case "test/hang":
            return;

        case "test/close-channel":
            /*
            | The channel dies but the process lives on. A wrapper
            | script, a container shim, or a server that closes its
            | own stdio all look like this, and the `exit` event
            | never arrives to clean up after them.
            */
            setInterval(() => {}, 1000);
            process.stdout.end();
            return;

        case "test/crash":
            process.exit(9);
            return;

        case "shutdown":
            reply(null);
            return;

        case "exit":
            if (values.get("--exit-on-exit-notification") === "false") return;
            process.exit(Number(values.get("--exit-code") ?? 0));
            return;

        default:
            if (id !== undefined) {
                send({
                    jsonrpc: "2.0",
                    id,
                    error: { code: -32601, message: `no such method: ${method}` },
                });
            }
    }
}

if (flags.has("--stderr-noise")) {
    for (let i = 0; i < 5; i++) {
        process.stderr.write(`fake-lsp: noisy line ${i} that must never reach client stdout\n`);
    }
}
