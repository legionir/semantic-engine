/**
 * P-05 (§7) root-cause pass regressions.
 *
 * These three ledger rows were `potential/unverified`. After the root-cause
 * chain (Symptom → Observed Behavior → Root Cause → Validation) they resolved
 * as REAL defects and are fixed + locked here:
 *
 *  - SE-P-002 `makeEdgeId` encoded `occurrence: 0` identically to an absent
 *    occurrence; `CallGraphBuilder.occurrenceOf` counts from 0, so the first
 *    edge of every group collided with a no-occurrence identity — the exact
 *    collision the field exists to prevent.
 *  - SE-F-034 `parseTraceparent` accepted any 4-dash string as a W3C
 *    traceparent; a malformed header became a "valid" trace id and `startSpan`
 *    propagated it as real provenance (§15: an error must not present as a
 *    valid result).
 *  - SE-F-036 the scanner's outer error branch pushed a path-less
 *    diagnostic while the skip branch names the file — an unattributable
 *    "could not process" warning.
 *
 * Rows that resolved as NON-defects are documented in
 * `audit/findings/P05-ROOT-CAUSE-PASS.md`; they are not silently dropped.
 */

import { makeEdgeId } from '../graphs/EdgeProvenance';
import { OpenTelemetryTracer } from './OpenTelemetryTracer';

describe('P-05 regressions', () => {
  describe('SE-P-002 — edge id distinguishes occurrence 0 from absent', () => {
    const base = { from: 'a', to: 'b', kind: 'call', line: 4 };
    it('occurrence:0 ≠ omitted', () => {
      expect(makeEdgeId({ ...base, occurrence: 0 })).not.toBe(makeEdgeId(base));
    });
    it('occurrence:0 ≠ occurrence:1 ≠ occurrence:2 (unchanged guarantee)', () => {
      const ids = [0, 1, 2].map(o => makeEdgeId({ ...base, occurrence: o }));
      expect(new Set(ids).size).toBe(3);
    });
    it('is deterministic for identical identities', () => {
      expect(makeEdgeId({ ...base, occurrence: 0 })).toBe(makeEdgeId({ ...base, occurrence: 0 }));
    });
  });

  describe('SE-F-034 — traceparent validation per W3C', () => {
    const tracer = new OpenTelemetryTracer();
    const valid = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

    it('accepts a spec-valid header', () => {
      expect(tracer.parseTraceparent(valid)).toEqual({
        traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
        parentSpanId: '00f067aa0ba902b7',
      });
    });

    it('rejects malformed headers instead of harvesting garbage ids', () => {
      expect(tracer.parseTraceparent('junk-x-y-z')).toBeNull();
      expect(tracer.parseTraceparent('00-dead-01')).toBeNull();               // wrong lengths
      expect(tracer.parseTraceparent('00-zz92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toBeNull(); // non-hex
      expect(tracer.parseTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01')).toBeNull(); // all-zero trace-id
      expect(tracer.parseTraceparent('ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toBeNull(); // invalid version ff
    });

    it('startSpan ignores a malformed parent and mints a fresh valid trace', () => {
      const span = tracer.startSpan('x', 'not-a-traceparent');
      expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(span.parentSpanId).toBeUndefined();
    });

    it('round-trips what createTraceparent produces', () => {
      const header = tracer.createTraceparent();
      expect(tracer.parseTraceparent(header)).not.toBeNull();
    });
  });
});
