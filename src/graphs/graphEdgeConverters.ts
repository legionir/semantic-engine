/**
 * Conversion of index edges to the query engine's edge shape
 * (split from GraphQueryEngine.ts, behavior unchanged).
 */

import {
  CallEdge,
  DependencyEdge,
  ReverseDependencyEdge,
  TypeEdge,
} from '../core/types/project-index.types';
import type { GraphEdge } from './graphQueryTypes';

// ── تبدیل یال‌های ایندکس ───────────────────────────────────────────────

export function dependencyEdge(edge: DependencyEdge): GraphEdge | null {
  /*
  | یال به بستهٔ بیرونی (`pkg:react`) گره‌ای در این پروژه نیست.
  | نگه داشتنش یعنی پیمایش به جایی می‌رسد که هیچ فایلی ندارد.
  */
  if (edge.to.startsWith('pkg:')) return null;
  return {
    from: edge.from,
    to: edge.to,
    relation: 'imports',
    kind: edge.kind,
    confidence: edge.provenance.confidence,
    basis: edge.provenance.basis,
    extractor: edge.provenance.extractor,
  };
}

export function callEdge(edge: CallEdge): GraphEdge | null {
  return {
    from: edge.caller,
    to: edge.callee,
    relation: 'calls',
    kind: edge.kind,
    confidence: edge.provenance.confidence,
    basis: edge.provenance.basis,
    extractor: edge.provenance.extractor,
  };
}

export function typeEdge(edge: TypeEdge): GraphEdge {
  /*
  | جهت: از فرزند به والد. «چه چیزی از این ارث می‌برد» با
  | `direction: 'in'` پرسیده می‌شود، مثل بقیه.
  */
  return {
    from: edge.child,
    to: edge.parent,
    relation: 'types',
    kind: edge.kind,
    confidence: edge.provenance.confidence,
    basis: edge.provenance.basis,
    extractor: edge.provenance.extractor,
  };
}

/** برای مصرف‌کننده‌هایی که فقط یال معکوس دارند. */
export function reverseEdge(edge: ReverseDependencyEdge): GraphEdge {
  return {
    from: edge.to,
    to: edge.from,
    relation: edge.kind === 'called-by' ? 'calls' : edge.kind === 'imported-by' ? 'imports' : 'types',
    kind: edge.kind,
    confidence: edge.provenance.confidence,
    basis: edge.provenance.basis,
    extractor: edge.provenance.extractor,
  };
}
