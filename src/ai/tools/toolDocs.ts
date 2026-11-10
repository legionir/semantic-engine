/**
 * Documentation the model sees for every tool, kept in one reviewed place.
 *
 * A tool's own `inputSchema` says what is *accepted*; this says what each
 * parameter *means*, when to reach for the tool and what comes back — the three
 * things a model cannot infer from a name. `AiToolRegistry.list()` merges it
 * into the schema and description it serves over MCP, and
 * `scripts/gen-ai-tools-doc.js` renders the same text into docs/AI-TOOLS.md and
 * the Claude Code skill, so the three can never disagree.
 *
 * `toolDocs.test.ts` fails when a tool, or a single parameter of a tool, has no
 * entry here — adding a tool without documenting it does not pass CI.
 */

export interface ToolDoc {
  /** When to use it — and when another tool is the better choice. */
  readonly use: string;
  /** Shape of the result, including the fields that change how it must be read. */
  readonly returns: string;
  /** Meaning of each parameter (units, defaults, how it combines with others). */
  readonly params: Readonly<Record<string, string>>;
  /** Extra JSON-Schema detail for nested parameters the tool itself leaves open. */
  readonly schemaPatch?: Readonly<Record<string, Record<string, unknown>>>;
  /** Tool-group tag used to organise the generated documents. */
  readonly group: 'navigate' | 'understand' | 'impact' | 'read' | 'search' | 'project' | 'edit' | 'experimental';
}

const LIMIT = 'Maximum number of items to return; when more exist the result says `truncated: true` and `matchCount` holds the real total.';
const PATH = 'Project-relative file path using forward slashes, exactly as printed by project_list_files.';
const ID_ANY = 'A file path as printed by project_list_files, a fileId, or a symbolId taken from another tool result.';

export const TOOL_DOCS: Readonly<Record<string, ToolDoc>> = {
  find_symbol: {
    group: 'navigate',
    use: 'Locate a function, class, method or constant by (part of) its name. Use symbol_find instead when you need an exact-name lookup.',
    returns: 'items[]: one per symbol with id, name, kind, path, line and signature in `excerpt`. The `id` can be passed to explain_symbol, impact_analysis and get_dependencies. metadata: matchCount, truncated, limit.',
    params: {
      name: 'Symbol name or a fragment of it; matching is partial and case-insensitive.',
      kind: 'Restrict to symbol kinds such as "function", "class", "method", "interface", "constant"; one value or a list.',
      language: 'Restrict to language ids as listed by project_info (e.g. "typescript", "python"); one value or a list.',
      path: 'Keep only symbols whose file path starts with, or contains, this text.',
      exportedOnly: 'When true, return only exported (public) symbols.',
      limit: LIMIT,
    },
  },
  get_dependencies: {
    group: 'navigate',
    use: 'See what a file or symbol depends on (forward) or what depends on it (backward). For "what breaks if I change this" prefer impact_analysis, which ranks by confidence.',
    returns: 'items[]: related files, symbols or packages (kind "import", "package", "called-by"…), each with metadata.dependents. metadata: truncated, limit.',
    params: {
      id: ID_ANY,
      direction: '"forward" = what this depends on; "backward" = what depends on this.',
      level: '"file" walks import edges between files; "symbol" walks call edges between symbols.',
      depth: 'Number of hops to follow, 1–3. Larger values grow the result quickly.',
      kind: 'Edge kind filter; "all" (default) mixes imports, packages, dynamic imports and call edges.',
      limit: LIMIT,
    },
  },
  get_file_summary: {
    group: 'understand',
    use: 'Get the role, public API, imports and exports of one file in a few lines, before deciding whether to read it. Cheaper than code_read.',
    returns: 'items[]: the file\'s symbols (id, kind, line, signature). `context`: a text card with role, language, line count, summary, public API, imports and exports.',
    params: {
      path: PATH,
      fileId: 'File id from another tool result; use instead of `path`.',
    },
  },
  semantic_search: {
    group: 'search',
    use: 'Find symbols and files from a natural-language description when you do not know their names. Ranked by keyword match, vector similarity (when the index has embeddings) and importance signals.',
    returns: 'items[]: symbols/files with relevanceScore 0–1 and metadata.signals explaining the ranking. metadata.searchMode says what actually ran ("keyword-only" when the index has no vectors — see degradedReason); an empty result with that mode means "no keyword hit", not "nothing relevant exists".',
    params: {
      query: 'What you are looking for, in plain words ("where are passwords hashed").',
      filters: 'Narrowing filters: language, kind, path (prefix/substring) and exportedOnly, same meaning as in find_symbol.',
      limit: LIMIT,
      mode: '"keyword", "vector" or "hybrid" (default). "vector" fails or degrades when the index has no embeddings.',
      minScore: 'Drop results whose final ranked score is below this value (0–1).',
      useEmbeddings: 'Set false to skip vector scoring even when embeddings exist (faster, keyword only).',
    },
  },
  assemble_context: {
    group: 'understand',
    use: 'Build one token-budgeted bundle of the files and symbols needed for a coding task, starting from files/symbols you already know. Use discover_context first when you do not know where to start.',
    returns: 'items[]: ranked files/symbols with metadata.section ("targetFiles", "relatedFiles", "tests"…) and graphHops. `context`: the assembled text within maxTokens. Targets and tests get a guaranteed share of the budget.',
    params: {
      task: 'One or two sentences describing the change; used to rank related files.',
      targetFiles: 'Project-relative paths of files you are going to change; always included.',
      targetSymbols: 'Symbol ids of symbols you are going to change; always included.',
      maxTokens: 'Token budget of the assembled context (default 4000).',
      includeTests: 'Include tests linked to the targets (default true).',
      includeRecentChanges: 'Add recent git commits touching the targets (default false).',
      dependencyDepth: 'How many dependency hops around the targets to include (default 1).',
      explain: 'Add the ranking signals behind each item.',
    },
  },
  discover_context: {
    group: 'search',
    use: 'Start here for an unfamiliar task: give only a plain-language description and get candidate files/symbols with the reason each was chosen. Returns candidates, not source text — follow with assemble_context or code_read.',
    returns: 'items[]: candidates with relevanceScore and metadata.origin ("search", "blueprint", "graph") and graphHops; `excerpt` explains why it was selected.',
    params: {
      task: 'Plain-language description of what you want to do.',
      limit: 'Maximum candidates returned (default 20).',
      expansionDepth: 'Graph hops to expand from the seed hits (default 2).',
      seedLimit: 'Number of search hits used as seeds (default 8).',
      filesPerModule: 'Files taken from each matching architecture module (default 3).',
      maxNodes: 'Ceiling on graph nodes visited during expansion (default 200).',
      includeTests: 'Also return test files among the candidates (default false).',
    },
  },
  impact_analysis: {
    group: 'impact',
    use: 'Before changing a file or symbol, list what depends on it (reverse dependencies), ranked by confidence. Use simulate_mutation for a rename/move/delete you are about to do.',
    returns: 'items[]: impacted files/symbols with relevanceScore and metadata.depth, pathConfidence and `via` (how the edge was found). metadata: truncated/droppedByLimit/traversalExhausted tell whether the list is complete. An unknown id returns success:false.',
    params: {
      id: ID_ANY + ' A module or package id is also accepted.',
      level: 'Result granularity: "file", "symbol" or "any".',
      depth: 'Hops to follow upstream (default 2).',
      limit: LIMIT,
      minConfidence: 'Ignore edges below this confidence (0–100, default 70). 0 also includes name-match guesses.',
    },
  },
  explain_symbol: {
    group: 'understand',
    use: 'Everything known about one symbol in a single call (signature, complexity, callers, callees, tests, git, diagnostics) with the confidence of each part.',
    returns: 'items[0].metadata: signature, visibility, calls[], calledBy[], members[], complexity, referenceCount, plus per-part trust/basis; `truncated` lists which sections were cut. Diagnostics are empty unless the index was built with --lsp-diagnostics: check diagnosticsRun before reading an empty list as "clean".',
    params: {
      id: 'Symbol id. Give this or `name`.',
      name: 'Symbol name when you have no id; add `path` if the name is not unique.',
      path: 'File path used only to disambiguate `name`.',
      limit: 'Maximum callers/callees/members listed per section (default 20).',
      minConfidence: 'Hide calls/callers whose edge confidence is below this (0–100, default 0).',
    },
  },
  find_tests: {
    group: 'navigate',
    use: 'Find the test files that exercise a file or symbol, to know what to run after a change.',
    returns: 'items[]: test files with the reason they were linked. An empty list means no test is linked in the index (naming/import heuristics), not that none exists.',
    params: {
      path: PATH,
      fileId: 'File id; alternative to `path`.',
      symbolId: 'Symbol id; alternative to `path`.',
      limit: LIMIT,
    },
  },
  get_recent_changes: {
    group: 'impact',
    use: 'See the latest commits for the project (or one file) to learn what changed recently and who touched it.',
    returns: 'items[]: commits (id = full hash, name = subject, excerpt = date | subject, source = author). metadata.isGitRepository separates "not a git repo" from "no commits"; examinedCommits and truncated describe the window.',
    params: {
      workspaceRoot: 'Directory to run git in; normally omit it. Relative values resolve against the indexed project root.',
      path: PATH,
      limit: 'Number of most recent commits examined (default 10).',
      since: 'ISO date (e.g. 2026-01-31); only commits after it are kept — applied within the examined window.',
    },
  },
  get_config_usage: {
    group: 'search',
    use: 'Find where an environment variable or config key is read (process.env, config.get, .env files).',
    returns: 'items[]: usages with kind ("env", "config-get", "dotenv", "env-file-reference"), path, line and the source line in `excerpt`.',
    params: {
      key: 'Variable or config key; substring match. Give at least one of key, path, kind.',
      path: 'Only usages in this file.',
      kind: 'Only this usage kind.',
      limit: LIMIT,
    },
  },
  simulate_mutation: {
    group: 'impact',
    use: 'Dry-run a rename, delete or move in the index and list the references it would break. Writes nothing; run it before edit_plan.',
    returns: 'metadata.diff: affectedSymbolsCount, brokenReferences[] (callerFile, callerLine, relation) and isSafe. items[] lists the broken references.',
    params: {
      actionType: '"rename_symbol", "delete_symbol" or "move_symbol".',
      targetSymbolId: 'Symbol id (or "path::name") to mutate.',
      newName: 'New name; required for rename_symbol.',
      newPath: 'New project-relative file path; required for move_symbol.',
    },
  },
  detect_architecture_violations: {
    group: 'impact',
    use: 'Audit the whole project for layer bypasses (e.g. controller → repository), circular dependencies and similar rule violations.',
    returns: 'items[]: one per violation (ruleId, severity, description, suggestion). metadata.report groups circularDependencies and layerViolations; totalViolations is the count.',
    params: {
      checkCyclesOnly: 'When true, only report circular dependencies and skip layer rules.',
    },
  },
  get_git_hotspots: {
    group: 'impact',
    use: 'Find risky files: frequently changed and complex. Good targets for extra review or tests.',
    returns: 'metadata.hotspots[] with score components; `context` states how many were found. Empty means no history data (not a git repo, or no commits), not "no risk".',
    params: {
      limit: 'Maximum hotspots returned (default 10).',
    },
  },
  code_read: {
    group: 'read',
    use: 'Read actual source text, bounded. Use after the index tools told you where to look; use code_fold first for a cheaper structural view.',
    returns: 'items[0].excerpt: the text; metadata: handle (re-readable, bound to the file version), start/end (UTF-16 offsets), truncated, returnedTokens. Errors: NOT_FOUND, OUT_OF_RANGE, STALE_HANDLE (file changed since the handle was issued).',
    params: {
      path: PATH + ' Give one of path, fileId, handle.',
      fileId: 'File id; alternative to path.',
      handle: 'Handle from an earlier code_read/code_fold result; fails with STALE_HANDLE if the file changed.',
      start: 'Start offset in UTF-16 code units (not bytes or lines), 0-based.',
      end: 'End offset (exclusive) in UTF-16 code units; must be ≥ start.',
      maxResultBytes: 'Cap on returned text size in bytes; the result says truncated:true when it cut.',
    },
  },
  code_fold: {
    group: 'read',
    use: 'Read a file with bodies collapsed ("… 13") so you see its structure for a fraction of the tokens; then code_read the part you need.',
    returns: 'items[0].excerpt: folded source where omitted ranges are replaced by "… <line>"; metadata has a handle and token counts.',
    params: {
      path: PATH + ' Give path or fileId.',
      fileId: 'File id; alternative to path.',
      level: 'Fold level 0–4 (default 2). 0 keeps every line (no folding); 1–2 keep each symbol\'s first and last line; 3–4 also keep the first few lines of each body.',
      maxTokens: 'Token cap for the folded output.',
      comments: '"strip" removes comments, "doc-only" keeps doc comments, "keep" keeps all.',
    },
  },
  project_info: {
    group: 'project',
    use: 'Orientation call: project root, index generation/time, languages and, per language, how deep the analysis goes (symbols/callGraph/status). Call first in a session.',
    returns: 'items[0].metadata: root, rootPath, generatedAt, snapshotId, languages[], languageSupport{lang:{symbols,callGraph,status}}, adapter status.',
    params: {},
  },
  project_list_files: {
    group: 'project',
    use: 'List indexed files (path order) to learn the layout or get exact paths for other tools.',
    returns: 'items[]: files with path, language, size, lines, hash, generated, binary. metadata: matchCount, truncated, limit.',
    params: {
      language: 'Only files of this language id.',
      limit: 'Maximum files returned (default 1000).',
    },
  },
  diagnostics_get: {
    group: 'project',
    use: 'Read compiler/language-server diagnostics stored in the index.',
    returns: 'items[]: diagnostics (message, severity, code, line, column). metadata.warning is present when no diagnostics pass was recorded — then an empty list does NOT mean the code is clean.',
    params: {
      path: PATH + ' Omit for project-wide diagnostics.',
      severity: 'Only this severity, e.g. "error" or "warning".',
      limit: 'Maximum diagnostics returned (default 1000).',
    },
  },
  search_text: {
    group: 'search',
    use: 'Exact (case-insensitive) text search through indexed source files — for strings, log messages, TODOs. For meaning-based search use semantic_search.',
    returns: 'items[]: one per matching line with path, line (the real line), excerpt (the line) and metadata.column / enclosingSymbol (symbol id containing the match).',
    params: {
      query: 'Text to find; plain substring, not a regex.',
      path: 'Only search this file path.',
      limit: 'Maximum matches returned (default 100).',
    },
  },
  symbol_inspect: {
    group: 'understand',
    use: 'Identity card of one symbol: stable symbolKey, range, signature hash, confidence. Lighter than explain_symbol.',
    returns: 'items[]: matching symbols with metadata.symbolKey, endLine, confidence, exported. NOT_FOUND when nothing matches.',
    params: {
      id: 'Symbol id. Give id or name.',
      name: 'Exact symbol name when you have no id.',
      path: 'File path to disambiguate `name`.',
    },
  },
  gains_report: {
    group: 'project',
    use: 'Estimate how many tokens code_fold / reading by range saves compared with reading whole files.',
    returns: 'items[]: per file fullTokensEstimate, foldedTokensBudget, avoidedTokensEstimate, compressionRatio. Estimates from line counts, not measurements.',
    params: {
      path: 'One file; omit for every indexed file.',
      maxTokens: 'Folded-token budget to compare against; default is 35% of the estimated full size.',
    },
  },
  code_outline: {
    group: 'understand',
    use: 'Structural outline (all symbols, in order) of one file. Use compact:true to save about two thirds of the tokens.',
    returns: 'items[]: symbols with kind, line, signature and metadata.endLine/range; compact:true keeps only name, kind, lines and signature.',
    params: {
      path: PATH + ' Give path or fileId.',
      fileId: 'File id; alternative to path.',
      includeRanges: 'Include start/end line ranges (default true).',
      compact: 'Return only name, kind, lines and signature per symbol.',
    },
  },
  symbol_find: {
    group: 'navigate',
    use: 'Exact-name symbol lookup (case-insensitive), deterministic order. Use find_symbol for partial/fuzzy matching.',
    returns: 'items[]: symbols with id, kind, path, line, signature; metadata: matchCount, truncated, limit.',
    params: {
      query: 'Symbol name (exact, case-insensitive).',
      kind: 'Only this symbol kind.',
      path: 'Only symbols in this file path.',
      limit: 'Maximum results (default 100).',
    },
  },
  structural_search: {
    group: 'search',
    use: 'Find code by syntax shape with metavariables (e.g. `console.log($A)`), which text search cannot express. Read-only.',
    returns: 'items[]: matches with path, line and metadata.captures (metavariable → matched text), start/end offsets. Languages without a structural grammar fail explicitly.',
    params: {
      pattern: 'Code pattern; `$NAME` matches one node, `$$$NAME` a list.',
      language: 'Language id of the pattern, e.g. "typescript", "python".',
      path: 'Restrict to this file path or folder prefix.',
      maxResults: 'Maximum matches (default 100).',
      ruleId: 'Optional label copied onto each match as metadata.ruleId; it does not select a rule.',
    },
  },
  structural_rule_test: {
    group: 'search',
    use: 'Run a structural rule pack against the project (a lint-style check) without changing anything.',
    returns: 'items[]: one per violation (kind "rule:<severity>", name = rule message, metadata.ruleId). metadata.passed is true when there are no violations; a malformed pack returns INVALID_RULE_PACK.',
    params: {
      rules: 'Rule pack as JSON (or simple YAML) text: {"rules":[{"id","language","pattern","message","severity":"info|warning|error"}]}. Give rules or rulePath.',
      rulePath: 'Project-relative path of a rule pack file.',
      path: 'Restrict testing to this path.',
      maxResults: 'Maximum matches reported.',
    },
  },
  syntax_tree_dump: {
    group: 'understand',
    use: 'Debug aid: dump the parse tree of a file to see why a structural pattern does or does not match.',
    returns: 'items[0].excerpt: JSON tree of the file as the structural engine sees it.',
    params: {
      path: PATH,
      language: 'Language id used to parse the file.',
    },
  },
  edit_plan: {
    group: 'edit',
    use: 'Step 1 of a guarded edit: describe text replacements and get a plan with a diff preview. Writes nothing. Listed only when the server runs with transactional edits enabled (a direct call otherwise answers DISABLED).',
    returns: 'metadata: planId, per-edit diff preview and validation. Next: edit_approve → edit_apply.',
    params: {
      edits: 'Replacements to make. Each needs path, start/end (UTF-16 offsets from code_read), replacement text and expectedHash of the current file text so a changed file is rejected.',
      source: '"client" for edits you wrote yourself, "structural-search" for edits derived from structural_search matches.',
    },
    schemaPatch: {
      edits: {
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Project-relative file path.' },
            start: { type: 'integer', minimum: 0, description: 'Start offset (UTF-16 code units).' },
            end: { type: 'integer', minimum: 0, description: 'End offset, exclusive.' },
            replacement: { type: 'string', description: 'Text that replaces start..end.' },
            expectedHash: { type: 'string', description: 'SHA-256 of the file text the offsets were computed from.' },
          },
          required: ['path', 'start', 'end', 'replacement', 'expectedHash'],
        },
      },
    },
  },
  edit_approve: {
    group: 'edit',
    use: 'Step 2: approve a previewed plan. Approval alone changes no file.',
    returns: 'metadata: planId and approvalToken (needed by edit_apply).',
    params: { planId: 'planId returned by edit_plan.' },
  },
  edit_apply: {
    group: 'edit',
    use: 'Step 3: apply an approved plan atomically; originals are journaled so edit_rollback can undo it.',
    returns: 'metadata: transactionId and status. Fails if the plan is unapproved, the token is wrong or a file changed since planning.',
    params: {
      planId: 'planId returned by edit_plan.',
      approvalToken: 'Token returned by edit_approve for this plan.',
    },
  },
  edit_rollback: {
    group: 'edit',
    use: 'Undo an applied transaction from its journal.',
    returns: 'metadata: transactionId and the resulting status.',
    params: { transactionId: 'transactionId returned by edit_apply.' },
  },
  edit_status: {
    group: 'edit',
    use: 'Inspect journaled transactions (status, files, diff) without changing anything.',
    returns: 'items[]: transactions with metadata.status, planId, paths, editCount, updatedAt.',
    params: {
      transactionId: 'Show only this transaction; omit to list recent ones.',
      limit: 'Maximum transactions returned.',
    },
  },
  symbol_references: {
    group: 'experimental',
    use: 'Experimental (TypeScript only, needs the `semantic-graph` capability). References to a symbol with explicit resolution confidence.',
    returns: 'items[]: references with confidence (exact/heuristic/ambiguous/unresolved) and provenance; metadata.snapshotHandle for follow-up calls. Stale handles fail closed.',
    params: {
      symbolId: 'Symbol id. Give one of symbolId, symbolKey, name.',
      symbolKey: 'Stable symbolKey from symbol_inspect/code_outline.',
      name: 'Symbol name.',
      minConfidence: 'Lowest confidence class to include.',
      limit: 'Maximum references returned.',
      snapshotHandle: 'Handle from a previous response to query the same snapshot.',
    },
  },
  semantic_graph_inspect: {
    group: 'experimental',
    use: 'Experimental. Diagnostics about the TypeScript semantic graph (size, unresolved edges).',
    returns: 'items[]: graph statistics and metadata.snapshotHandle.',
    params: {
      limit: 'Maximum rows returned.',
      snapshotHandle: 'Handle from a previous response.',
    },
  },
  provider_status: {
    group: 'experimental',
    use: 'Experimental (`controlled-expansion`). Which languages have a semantic provider; unsupported ones are listed explicitly.',
    returns: 'items[]: one per language with its provider status.',
    params: { languages: 'Language ids to check, 1–20.' },
  },
  impact_analyze_v4: {
    group: 'experimental',
    use: 'Experimental bounded impact analysis that states where each constraint came from.',
    returns: 'items[]: impacted symbols with explicit constraint provenance.',
    params: {
      symbolId: 'Symbol id to analyse.',
      includeHeuristic: 'Include heuristic (non-exact) edges; default false.',
    },
  },
  context_build_v4: {
    group: 'experimental',
    use: 'Experimental deterministic context builder with a hard token budget.',
    returns: 'items[]: selected context blocks within budgetTokens.',
    params: {
      seed: 'Starting symbol, file or text (1–200 chars).',
      budgetTokens: 'Hard token budget, 1–100000.',
      limit: 'Maximum blocks, 1–1000.',
      goal: 'Natural-language goal; only selects retrieval direction.',
    },
  },
  semantic_rename_v4: {
    group: 'experimental',
    use: 'Experimental rename planner (needs transactional edits enabled). Produces an edit plan; apply it with edit_approve/edit_apply.',
    returns: 'metadata: planId and affected references; heuristic references are flagged.',
    params: {
      symbolId: 'Symbol to rename.',
      replacement: 'New identifier ([A-Za-z_$][\\w$]*).',
      includeHeuristic: 'Also rename heuristic (non-exact) references; default false.',
    },
  },
};
