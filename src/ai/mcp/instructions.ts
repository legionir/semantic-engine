/**
 * The `instructions` string of the MCP `initialize` answer: the few lines a
 * model reads once, before it has called anything. Tool descriptions say what
 * each tool does; this says how to use them together and how to read results.
 */
export const MCP_INSTRUCTIONS = [
  'Semantic Engine has a pre-built index of this code base: every symbol, the import graph and the call graph. Prefer these tools over Grep, Glob and whole-file reads for questions about code structure: they answer "where is X defined", "who calls X" and "what breaks if I change X" in one call, where text search needs several rounds and still misses indirect links.',
  'Call project_info once to learn which languages are indexed and how deep the analysis goes. Unfamiliar task: find_context with a plain-language description. Known name: find_symbol, then explain_symbol for callers, callees and tests. Unknown name: search.',
  'Before opening a file use file_outline; then read_code for only the lines you need (line numbers printed by the other tools can be passed straight in).',
  'Before changing code: impact (what depends on it; add `change` to dry-run a rename, move or delete) and find_tests (what to run afterwards).',
  'Reading results: "more exist" means the list was cut, so raise `limit` or narrow the query. "No results in the index" is not proof of absence: read the note and warning lines, and fall back to text search if the language has shallow support in project_info.',
  'The index follows the working tree while the watcher runs; `index generation` changes after a re-index, and ids from an older generation may be stale.',
].join('\n');
