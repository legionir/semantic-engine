#!/usr/bin/env node
"use strict";
/*
 * Fixture-2 generator (unseen fixture, retrieval-design.md §9).
 *
 * Deterministically writes fixture2/src/* and fixture2/index.json.
 * The fixture and its golds (gold-2.json) are FROZEN before the first
 * benchmark run on them; this script documents how the index was produced.
 *
 * Usage: node docs/validation/spike-s/gen-fixture2.js   (from semantic-engine/)
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SPIKE_DIR = __dirname;
const FIXTURE2 = path.join(SPIKE_DIR, "fixture2");

const FILES = {
  "src/tokens.ts": "export function tokenize(input: string): string {\n  return input.trim();\n}\nexport const LIMIT = 32;\n",
  "src/ngrams.ts": "import { tokenize } from './tokens';\nexport function pairs(text: string): number {\n  return tokenize(text).length;\n}\nexport function triple(text: string): number {\n  return tokenize(text).length + 1;\n}\n",
  "src/count.ts": "import { pairs } from './ngrams';\nexport function census(text: string): number {\n  return pairs(text) * 2;\n}\n",
  "src/report.ts": "import { census } from './count';\nexport function summary(text: string): number {\n  return census(text);\n}\n",
  "src/barrel.ts": "export { tokenize } from './tokens';\nexport * from './ngrams';\n",
  "src/pipeline.ts": "import { tokenize } from './barrel';\nimport * as tk from './tokens';\nimport * as nodefs from 'fs';\nexport function stage(raw: string): string {\n  const clean = nodefs.existsSync('x') ? raw : raw;\n  return tk.tokenize(clean) + tokenize(clean);\n}\n",
  "src/fold.ts": "import { tokenize } from './tokens';\nexport function fold(text: string): string {\n  function inner(tokenize: number) {\n    return tokenize + 1;\n  }\n  const mapper = (tokenize: string) => tokenize.slice(1);\n  return text + inner(2) + mapper('ab');\n}\n",
  "src/marks/a.ts": "export function rate(n: number): number {\n  return n + 1;\n}\n",
  "src/marks/b.ts": "export function rate(n: number): number {\n  return n + 2;\n}\n",
  "src/both.ts": "export * from './marks/a';\nexport * from './marks/b';\n",
  "src/judge.ts": "import { rate } from './marks/a';\nimport { rate as rateB } from './marks/b';\nexport const verdict = rate(1) + rateB(2);\n",
  "src/verdict2.ts": "import { rate } from './both';\nexport const prize = rate(3);\n",
  "src/skin.ts": "export default function wrap(text: string): string {\n  return '[' + text + ']';\n}\n",
  "src/view.ts": "import wrap from './skin';\nexport const panel = wrap('a');\n",
  "src/panel2.ts": "import wrap from './skin';\nexport const page = wrap('b');\n",
  "src/decoy.ts": "import { tokenize } from './tokens';\n// tokenize is wonderful, tokenize everywhere\nexport const note = 'tokenize';\nexport const bag = { tokenize: 1 };\nexport const picked = bag.tokenize;\n",
  "src/island.ts": "import { phantom } from './phantom';\nexport function solo(): number {\n  return 0;\n}\n",
};

const SYMBOLS = [
  ["s2-tokenize", "f2-tokens", "function", "tokenize", 1, 3],
  ["s2-limit", "f2-tokens", "variable", "LIMIT", 4, 4],
  ["s2-pairs", "f2-ngrams", "function", "pairs", 2, 4],
  ["s2-triple", "f2-ngrams", "function", "triple", 5, 7],
  ["s2-census", "f2-count", "function", "census", 2, 4],
  ["s2-summary", "f2-report", "function", "summary", 2, 4],
  ["s2-stage", "f2-pipeline", "function", "stage", 4, 7],
  ["s2-fold", "f2-fold", "function", "fold", 2, 8],
  ["s2-rate-a", "f2-marks-a", "function", "rate", 1, 3],
  ["s2-rate-b", "f2-marks-b", "function", "rate", 1, 3],
  ["s2-verdict", "f2-judge", "variable", "verdict", 3, 3],
  ["s2-prize", "f2-verdict2", "variable", "prize", 2, 2],
  ["s2-wrap", "f2-skin", "function", "wrap", 1, 3],
  ["s2-panel", "f2-view", "variable", "panel", 2, 2],
  ["s2-page", "f2-panel2", "variable", "page", 2, 2],
  ["s2-note", "f2-decoy", "variable", "note", 3, 3],
  ["s2-bag", "f2-decoy", "variable", "bag", 4, 4],
  ["s2-picked", "f2-decoy", "variable", "picked", 5, 5],
  ["s2-solo", "f2-island", "function", "solo", 2, 4],
];

function main() {
  const fileIds = {};
  for (const rel of Object.keys(FILES)) {
    fileIds[rel] = `f2-${rel.replace(/^src\//u, "").replace(/[/.]/gu, "-").replace(/-ts$/u, "")}`;
  }
  fs.mkdirSync(path.join(FIXTURE2, "src", "marks"), { recursive: true });
  const files = [];
  for (const [rel, content] of Object.entries(FILES)) {
    fs.writeFileSync(path.join(FIXTURE2, rel), content);
    files.push({
      id: fileIds[rel],
      path: rel,
      language: "typescript",
      encoding: "utf8",
      size: Buffer.byteLength(content, "utf8"),
      lines: content.split("\n").length - 1,
      hash: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
      modified: "2026-09-22T00:00:00Z",
      binary: false,
      testFile: false,
      generated: false,
    });
  }
  const symbols = SYMBOLS.map(([id, fileId, kind, name, line, endLine]) => ({
    id, fileId, parentId: null, kind, name, fullyQualifiedName: name,
    line, endLine, source: "tree-sitter", confidence: 100, exported: true,
  }));
  const index = {
    schemaVersion: "2.0.0",
    root: "spike-s-gold-2",
    rootPath: ".",
    generatedAt: "2026-09-22T00:00:00.000Z",
    languages: ["typescript"],
    files,
    symbols,
    graphs: { callGraph: [], typeGraph: [], dependencyGraph: [] },
    diagnostics: [],
    metrics: {
      totalFiles: files.length,
      totalLoc: files.reduce((a, f) => a + f.lines, 0),
      totalSymbols: symbols.length,
      avgCyclomaticComplexity: 1,
      languageBreakdown: { typescript: files.length },
    },
  };
  fs.writeFileSync(path.join(FIXTURE2, "index.json"), JSON.stringify(index, null, 2) + "\n");
  console.log(`fixture2 written: ${files.length} files, ${symbols.length} symbols`);
}

main();
