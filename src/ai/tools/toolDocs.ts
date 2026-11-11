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
const PATH = 'Project-relative file path using forward slashes, exactly as printed by list_files.';

export const TOOL_DOCS: Readonly<Record<string, ToolDoc>> = {
  project_info: {
    group: 'project',
    use: 'Call this first in a session. It tells you which languages are indexed, how deep the analysis goes for each (symbols only, or call graph too) and how old the index is, so you know how far to trust the other tools.',
    returns: 'Project root, index time, languages and per-language support (symbols / callGraph / status).',
    params: {},
  },
  find_context: {
    group: 'search',
    use: 'Start here for a task in code you do not know: describe the task in plain words and get the files and symbols that matter, each with the reason it was chosen. One call replaces a round of Grep/Glob guesses, because it follows imports and call edges from the first hits. Set includeSource (or pass files/symbols you already know) to get the relevant source assembled within a token budget.',
    returns: 'Candidates with a relevance score and why each was selected (search hit, architecture module, graph neighbour). With includeSource: the assembled source text of the targets, related files and tests.',
    params: {
      task: 'One or two sentences describing what you want to do or understand.',
      includeSource: 'When true, return assembled source text instead of a list of candidates (default false).',
      files: 'Project-relative paths you already know are involved; always included, and implies includeSource.',
      symbols: 'Symbol names, ids or "path::name" you already know are involved; implies includeSource.',
      maxTokens: 'Token budget of the assembled source (default 4000); only used with includeSource.',
      includeTests: 'Include test files linked to the candidates.',
      limit: 'Maximum candidates returned when listing (default 20).',
    },
  },
  search: {
    group: 'search',
    use: 'Find code when you do not have an exact name. mode "meaning" (default) ranks symbols and files by a plain-language description, which Grep cannot do. mode "text" is a case-insensitive substring search that also reports the enclosing symbol of every hit. mode "pattern" matches syntax with metavariables (`console.log($A)`), independent of formatting. For a known identifier use find_symbol.',
    returns: 'Ranked matches with path and line. "meaning" adds a relevance score and says in `searchMode` whether vectors were used ("keyword-only" means the index has no embeddings). "text" adds the enclosing symbol. "pattern" adds the captured metavariables.',
    params: {
      query: 'A description ("where are passwords hashed"), the text to find, or the syntax pattern, depending on `mode`. In a pattern `$NAME` matches one node and `$$$NAME` a list.',
      mode: '"meaning" (default), "text" or "pattern".',
      path: 'Restrict to file paths containing this text (a folder prefix or a file).',
      language: 'Language id as listed by project_info, e.g. "typescript". Required for mode "pattern".',
      kind: 'Only symbols of this kind ("function", "class", "method", ...); mode "meaning" only.',
      limit: LIMIT,
    },
  },
  find_symbol: {
    group: 'navigate',
    use: 'Jump to the definition of a function, class, method or constant from (part of) its name. Unlike Grep it returns definitions only, not every mention, with kind and signature.',
    returns: 'One line per symbol: name, kind, path:line and signature. The `id` can be passed to explain_symbol and impact.',
    params: {
      name: 'Symbol name or a fragment of it; matching is partial and case-insensitive.',
      kind: 'Restrict to symbol kinds such as "function", "class", "method", "interface", "constant"; one value or a list.',
      language: 'Restrict to language ids as listed by project_info (e.g. "typescript", "python"); one value or a list.',
      path: 'Keep only symbols whose file path starts with, or contains, this text.',
      exportedOnly: 'When true, return only exported (public) symbols.',
      limit: LIMIT,
    },
  },
  explain_symbol: {
    group: 'understand',
    use: 'Everything the index knows about one symbol in a single call: signature, who calls it, what it calls, members, tests, complexity and recent git activity. Use it instead of reading the file and grepping for callers.',
    returns: 'Signature, visibility, calls, calledBy, members, complexity and reference count, each with the confidence of the underlying edges. `truncated` lists sections that were cut. Diagnostics are empty unless the index was built with --lsp-diagnostics.',
    params: {
      id: 'Symbol id from another result. Give this or `name`.',
      name: 'Symbol name when you have no id; add `path` if the name is not unique.',
      path: 'File path used only to disambiguate `name`.',
      limit: 'Maximum callers/callees/members listed per section (default 20).',
      minConfidence: 'Hide calls/callers whose edge confidence is below this (0–100, default 0).',
    },
  },
  file_outline: {
    group: 'understand',
    use: 'Look at a file before deciding to read it. "summary" (default) gives its role, public API, imports and exports in a few lines; "symbols" lists every symbol with its line range; "folded" returns the source with bodies collapsed. All three cost a fraction of reading the file.',
    returns: '"summary": a text card plus the public symbols. "symbols": name, kind, lines and signature per symbol. "folded": the source where omitted ranges are replaced by "… <line>".',
    params: {
      path: PATH,
      detail: '"summary" (default), "symbols" or "folded".',
      maxTokens: 'Token cap for the "folded" view.',
    },
  },
  read_code: {
    group: 'read',
    use: 'Read source lines of an indexed file by line range. Use it after find_symbol, search or file_outline told you which lines matter; the line numbers those tools print can be passed straight in.',
    returns: 'The requested lines, numbered. Without a range only the first 200 lines are returned. Errors: NOT_FOUND (unknown path), OUT_OF_RANGE (startLine is past the end of the file).',
    params: {
      path: PATH,
      startLine: 'First line to read, 1-based (default 1).',
      endLine: 'Last line to read, inclusive (default startLine + 199).',
    },
  },
  list_files: {
    group: 'project',
    use: 'List indexed files to learn the layout or to get exact paths for the other tools. Generated, vendored and ignored files are already left out.',
    returns: 'Files in path order with language, size and line count. `matchCount` holds the real total when the list was cut.',
    params: {
      path: 'Only files whose path contains this text (a folder prefix such as "src/gateway/").',
      language: 'Only files of this language id.',
      limit: 'Maximum files returned (default 100).',
    },
  },
  impact: {
    group: 'impact',
    use: 'Before changing a file or symbol, see what would be affected. By default it lists what depends on the target, ranked by how certain each link is (Grep finds mentions, not dependents). direction "dependencies" lists what the target itself uses. With `change` it dry-runs a rename, move or delete and lists the references that would break; nothing is written.',
    returns: 'Affected files and symbols with depth, confidence and how each link was found; `truncated` says whether the list is complete. With `change`: the broken references (file, line, relation) and whether the change is safe.',
    params: {
      target: 'A project-relative file path, a symbol name, "path::name" or an id from another result.',
      direction: '"dependents" (default) = what depends on the target; "dependencies" = what the target depends on.',
      change: 'Dry-run this change to a symbol: "rename", "move" or "delete".',
      newName: 'New name; required with change "rename".',
      newPath: 'New project-relative file path; required with change "move".',
      depth: 'Hops to follow, 1–3 (default 2 for dependents, 1 for dependencies).',
      limit: LIMIT,
    },
  },
  find_tests: {
    group: 'navigate',
    use: 'Find the test files that exercise a file or symbol, to know what to run after a change.',
    returns: 'Test files with the reason each was linked. An empty list means no test is linked in the index (naming/import heuristics), not that none exists.',
    params: {
      path: PATH,
      fileId: 'File id; alternative to `path`.',
      symbolId: 'Symbol id; alternative to `path`.',
      limit: LIMIT,
    },
  },
  git_history: {
    group: 'impact',
    use: 'view "recent" (default): the latest commits for the project or one file, to learn what changed and who touched it. view "hotspots": files that change often and are complex, which deserve extra care or tests.',
    returns: '"recent": commits with hash, date, subject and author; `isGitRepository` separates "not a git repo" from "no commits". "hotspots": files with commit count and score components.',
    params: {
      view: '"recent" (default) or "hotspots".',
      path: 'Only commits touching this file; view "recent" only.',
      since: 'ISO date (e.g. 2026-01-31); only commits after it; view "recent" only.',
      limit: 'Number of commits examined or hotspots returned (default 10).',
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
  detect_architecture_violations: {
    group: 'impact',
    use: 'Audit the whole project for layer bypasses (e.g. controller → repository), circular dependencies and similar rule violations.',
    returns: 'items[]: one per violation (ruleId, severity, description, suggestion). metadata.report groups circularDependencies and layerViolations; totalViolations is the count.',
    params: {
      checkCyclesOnly: 'When true, only report circular dependencies and skip layer rules.',
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
      edits: 'Replacements to make. Each needs path, start/end (UTF-16 offsets), replacement text and expectedHash of the current file text so a changed file is rejected.',
      source: '"client" for edits you wrote yourself, "structural-search" for edits derived from pattern-search matches.',
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
      symbolKey: 'Stable symbolKey from a symbol result.',
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
