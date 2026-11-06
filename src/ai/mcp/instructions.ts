/**
 * The `instructions` string of the MCP `initialize` answer: the few lines a
 * model reads once, before it has called anything. Tool descriptions say what
 * each tool does; this says how to use them together and how to read results.
 */
export const MCP_INSTRUCTIONS = [
  'Semantic Engine answers questions about one code base from a pre-built index (symbols, dependencies, call graph) plus bounded source reads.',
  'Start with project_info (languages, how deep analysis goes, index age). To find where to work from a plain-language task use discover_context or semantic_search; from a name use find_symbol.',
  'Then narrow: get_file_summary / code_outline / code_fold for structure, explain_symbol for one symbol, code_read only for the exact lines you need.',
  'Before changing code: impact_analysis (who depends on it), find_tests, simulate_mutation for rename/move/delete.',
  'Reading results: every answer has success, items[] and metadata. metadata.truncated=true means more exist (raise limit or narrow the query); an empty items[] is "nothing found in the index", not proof of absence — check metadata.note, warning and degradedReason first; metadata.warnings lists parameters you sent that were ignored.',
  'indexGeneration changes when the project is re-indexed: ids and handles from an older generation may be stale (STALE_HANDLE).',
].join('\n');
