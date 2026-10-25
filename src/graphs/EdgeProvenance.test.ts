/**
 * Provenance یال — فاز ۱۹، پیش‌نیاز کل بلوک F.
 *
 * چهار نوع یال در گراف وجود دارد و هیچ‌کدام نمی‌گفتند **از کجا آمده‌اند**.
 * یالی که از تطبیق نام سراسری ساخته شده — یعنی «اولین symbol با این
 * نام در کل پروژه» — از یالی که مستقیم از AST خوانده شده قابل تشخیص
 * نبود. لایهٔ گراف بعدی (بلوک F) روی همین یال‌ها مسیر پیدا می‌کند و
 * توضیح می‌سازد؛ بدون provenance، یک حدس ضعیف و یک واقعیت با هم قاطی
 * می‌شوند و مسیرِ «مطمئنِ غلط» تولید می‌شود.
 */

import {
  makeEdgeId,
  provenanceFor,
  EDGE_CONFIDENCE,
  isHighConfidence,
  packageRef,
  isPackageRef,
  packageNameOf,
} from './EdgeProvenance';

describe('makeEdgeId', () => {

  /*
  | شناسهٔ قبلی `hash('call-edge-' + counter)` بود. یعنی شناسه فقط
  | *جایگاه* یال را کد می‌کرد، نه خودش را. اندازه‌گیری‌شده: دو گراف
  | کاملاً بی‌ربط همان فهرست شناسه را می‌دادند.
  */
  it('derives the id from the edge, not from a counter', () => {
    const first = makeEdgeId({ from: 'a', to: 'b', kind: 'direct', line: 3 });
    const second = makeEdgeId({ from: 'x', to: 'y', kind: 'direct', line: 3 });

    expect(first).not.toBe(second);
  });

  it('gives the same edge the same id every time', () => {
    const edge = { from: 'a', to: 'b', kind: 'direct', line: 3 };

    expect(makeEdgeId(edge)).toBe(makeEdgeId(edge));
  });

  it('does not depend on how many edges came before', () => {
    const target = { from: 'a', to: 'b', kind: 'direct', line: 3 };
    const alone = makeEdgeId(target);

    makeEdgeId({ from: 'q', to: 'r', kind: 'direct', line: 1 });
    makeEdgeId({ from: 's', to: 't', kind: 'direct', line: 2 });

    expect(makeEdgeId(target)).toBe(alone);
  });

  it('distinguishes edges that differ only in kind', () => {
    expect(makeEdgeId({ from: 'a', to: 'b', kind: 'direct', line: 1 }))
      .not.toBe(makeEdgeId({ from: 'a', to: 'b', kind: 'conditional', line: 1 }));
  });

  it('distinguishes edges that differ only in line', () => {
    expect(makeEdgeId({ from: 'a', to: 'b', kind: 'direct', line: 1 }))
      .not.toBe(makeEdgeId({ from: 'a', to: 'b', kind: 'direct', line: 2 }));
  });

  it('tolerates a missing line', () => {
    expect(makeEdgeId({ from: 'a', to: 'b', kind: 'extends' }))
      .toMatch(/^[0-9a-f]{16}$/);
  });

  /*
  | دو فراخوانی یکسان روی یک خط — `f(g(), g())` — واقعاً وجود دارند.
  | بدون شمارندهٔ تکرار، هر دو یک شناسه می‌گیرند و یکی از آن‌ها در هر
  | نگاشتی که کلیدش شناسه است، دیگری را می‌پوشاند.
  */
  it('separates two identical edges on the same line by occurrence', () => {
    const edge = { from: 'a', to: 'b', kind: 'direct', line: 7 };

    expect(makeEdgeId({ ...edge, occurrence: 0 }))
      .not.toBe(makeEdgeId({ ...edge, occurrence: 1 }));
  });
});

describe('provenanceFor', () => {

  it('gives an AST-derived edge high confidence', () => {
    const provenance = provenanceFor('ast', 'tree-sitter');

    expect(provenance.basis).toBe('ast');
    expect(provenance.confidence).toBeGreaterThanOrEqual(90);
  });

  /*
  | معیار پذیرش فاز: یال حاصل از `findByName` سراسری باید
  | `basis: 'name-match'` و `confidence ≤ 40` بگیرد. این پایین‌ترین
  | ردهٔ اعتماد است چون «اولین symbol با این نام در کل پروژه» در هر
  | مخزنی با نام تکراری، اشتباه است.
  */
  it('gives a global name match at most 40', () => {
    const provenance = provenanceFor('name-match', 'heuristic');

    expect(provenance.basis).toBe('name-match');
    expect(provenance.confidence).toBeLessThanOrEqual(40);
  });

  it('gives an unresolved target even less', () => {
    expect(provenanceFor('unresolved', 'heuristic').confidence)
      .toBeLessThan(EDGE_CONFIDENCE['name-match']);
  });

  it('records which extractor produced the edge', () => {
    expect(provenanceFor('ast', 'typescript-api').extractor).toBe('typescript-api');
  });

  it('carries an optional location', () => {
    const provenance = provenanceFor('ast', 'tree-sitter', { file: 'src/a.ts', line: 12 });

    expect(provenance.location).toEqual({ file: 'src/a.ts', line: 12 });
  });

  it('omits the location when there is none', () => {
    expect(provenanceFor('declared', 'heuristic').location).toBeUndefined();
  });

  it('orders the bases by how much they can be trusted', () => {
    expect(EDGE_CONFIDENCE.ast).toBeGreaterThan(EDGE_CONFIDENCE['import-resolved']);
    expect(EDGE_CONFIDENCE['import-resolved']).toBeGreaterThan(EDGE_CONFIDENCE['name-match']);
    expect(EDGE_CONFIDENCE['name-match']).toBeGreaterThan(EDGE_CONFIDENCE.unresolved);
  });

  it('keeps every confidence inside 0 to 100', () => {
    for (const value of Object.values(EDGE_CONFIDENCE)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });
});

describe('isHighConfidence', () => {

  it('accepts an AST edge and rejects a name match', () => {
    expect(isHighConfidence(provenanceFor('ast', 'tree-sitter'))).toBe(true);
    expect(isHighConfidence(provenanceFor('name-match', 'heuristic'))).toBe(false);
  });

  it('uses 70 as the default threshold', () => {
    expect(isHighConfidence({ ...provenanceFor('ast', 'tree-sitter'), confidence: 70 })).toBe(true);
    expect(isHighConfidence({ ...provenanceFor('ast', 'tree-sitter'), confidence: 69 })).toBe(false);
  });

  it('accepts a different threshold', () => {
    expect(isHighConfidence(provenanceFor('name-match', 'heuristic'), 30)).toBe(true);
  });
});

describe('package references (SE-GRAPH-01)', () => {

  /*
  | `DependencyEdge.to` هم fileId بود و هم نام خام ماژول. اندازه‌گیری
  | روی snapshot: ۱۶ یال از ۳۶ به چیزی اشاره می‌کردند که fileId نبود —
  | `stdio.h`، `context`، `java.util.List`. هر مصرف‌کننده‌ای که آن را
  | id فرض می‌کرد چیزی پیدا نمی‌کرد، و هیچ راهی نبود که «شناسهٔ
  | ناشناخته» را از «پکیج معتبر» تشخیص داد.
  */
  it('marks a package target so it cannot be mistaken for an id', () => {
    expect(packageRef('lodash')).toBe('pkg:lodash');
  });

  it('recognises its own references', () => {
    expect(isPackageRef('pkg:lodash')).toBe(true);
    expect(isPackageRef('a1b2c3d4e5f60718')).toBe(false);
  });

  it('reads the package name back out', () => {
    expect(packageNameOf('pkg:node:fs')).toBe('node:fs');
    expect(packageNameOf('pkg:@scope/thing')).toBe('@scope/thing');
  });

  it('returns null for something that is not a package reference', () => {
    expect(packageNameOf('a1b2c3d4e5f60718')).toBeNull();
  });

  it('round-trips any module name', () => {
    for (const name of ['fs', 'node:fs', '@scope/pkg', 'java.util.List', 'stdio.h', './x']) {
      expect(packageNameOf(packageRef(name))).toBe(name);
    }
  });

  it('does not double-prefix', () => {
    expect(packageRef(packageRef('fs'))).toBe('pkg:fs');
  });
});
