/**
 * `indexGeneration` — فاز ۷.
 *
 * A number that goes up every time the artifacts of one project are written,
 * stored in `project-artifacts.manifest.json` next to the index.
 *
 * ── Why it exists ──────────────────────────────────────────────────────
 *
 * A consumer that caches tool answers cannot tell "same answer" from "stale
 * answer" unless the producer says when the index moved.
 * `structured-ai/agent/mcp/SemanticClient.js` already implements its half of
 * that protocol — it reads `indexGeneration` from an unpacked tool result and
 * drops its whole cache when the value changes — but until this phase the
 * engine never emitted one, so every result looked like generation `null` and
 * the cache stayed off.
 *
 * Monotonic rather than a UUID (the manifest already carries a random
 * `generation`): a counter can be compared, logged and shown in
 * `/internal/status`, and it is what the plan specified.
 *
 * The functions here are pure; the caller owns the I/O.
 */

export const INDEX_GENERATION_FIELD = 'indexGeneration';

/** خواندن generation از یک manifest؛ نبودِ آن یعنی `0`. */
export function parseIndexGeneration(manifest: unknown): number {
  if (typeof manifest !== 'object' || manifest === null) return 0;

  const value = (manifest as Record<string, unknown>)[INDEX_GENERATION_FIELD];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;

  return Math.trunc(value);
}

/** generation بعدی؛ اولین نوشتن `1` می‌شود. */
export function nextIndexGeneration(previous: number): number {
  const base = Number.isFinite(previous) && previous > 0 ? Math.trunc(previous) : 0;
  return base + 1;
}
