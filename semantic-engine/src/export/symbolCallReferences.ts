/**
 * Fills `calls` / `calledBy` on every symbol from the call graph. Shared by the
 * full exporter and the incremental engine so both produce identical indexes.
 */

import { CallEdge, SymbolEntry } from '../core/types/project-index.types';

function addToSetMap(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key);
  if (set) {
    set.add(value);
  } else {
    map.set(key, new Set([value]));
  }
}

/**
 * پر کردن symbol.calls و symbol.calledBy از روی callGraph.
 * فقط edge هایی که هر دو سر آن‌ها symbol id موجود باشند در نظر گرفته می‌شوند.
 */
export function populateSymbolCallReferences(
  symbols: readonly SymbolEntry[],
  callGraph: readonly CallEdge[]
): SymbolEntry[] {
  const symbolMap = new Map(symbols.map(s => [s.id, s]));
  const calls = new Map<string, Set<string>>();
  const calledBy = new Map<string, Set<string>>();

  for (const edge of callGraph) {
    const caller = symbolMap.get(edge.caller);
    const callee = symbolMap.get(edge.callee);
    if (!caller || !callee) continue;

    addToSetMap(calls, caller.id, callee.id);
    addToSetMap(calledBy, callee.id, caller.id);
  }

  return symbols.map(sym => {
    const c = Array.from(calls.get(sym.id) ?? []).sort();
    const cb = Array.from(calledBy.get(sym.id) ?? []).sort();
    return {
      ...sym,
      calls: c,
      calledBy: cb,
    };
  });
}
