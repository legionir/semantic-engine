/** Types of the Phase 3 semantic graph pilot (split from Phase3SemanticGraph.ts, unchanged). */

export type ResolutionConfidence = 'exact' | 'heuristic' | 'ambiguous' | 'unresolved';
export type ResolutionVia = 'lsp' | 'import-graph' | 'scope' | 'name-only';
export type ReferenceBindingKind = 'direct' | 'same-file' | 're-export-routed' | 'default-routed' | 'namespace-routed';
export type HardBindingKind = 'local-shadow' | 'unresolved-use';

/**
 * Occurrence classes (F7): every scanned word occurrence of a candidate name is
 * classified into exactly one class. `reference` and `hard-binding` carry
 * binding information; the rest are audit-only exclusions.
 */
export type OccurrenceClass =
  | 'reference' | 'hard-binding'
  | 'declaration' | 'import-declaration' | 'param-declarator'
  | 'comment' | 'string' | 'property-access' | 'property-key'
  | 'namespace-object-use' | 'unclassified';

export interface ResolutionCandidate { readonly symbolId: string; readonly symbolKey: string; readonly path: string; readonly name: string; readonly kind: string; }
export interface ResolutionProvenance { readonly confidence: ResolutionConfidence; readonly via: ResolutionVia; readonly candidates: readonly ResolutionCandidate[]; readonly reason?: string; }
export interface SymbolReference {
  readonly id: string;
  readonly targetSymbolId?: string;
  readonly targetSymbolKey: string;
  readonly sourceFileId: string;
  readonly sourcePath: string;
  readonly line: number;
  readonly column: number;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly provenance: ResolutionProvenance;
  /** How the target was bound (F5/F7). */
  readonly bindingKind?: ReferenceBindingKind;
  /** Innermost index symbol whose span contains the occurrence on the SOURCE side (F4). */
  readonly sourceEnclosingSymbolId?: string;
}
export interface UnresolvedReference {
  readonly id: string;
  readonly sourceFileId: string;
  readonly sourcePath: string;
  readonly name: string;
  readonly line: number;
  readonly column: number;
  readonly reason: string;
  readonly provenance: ResolutionProvenance;
}
/** An occurrence that exists in code but does not bind to an index symbol (F1/F7). */
export interface HardBinding {
  readonly id: string;
  readonly sourceFileId: string;
  readonly sourcePath: string;
  readonly name: string;
  readonly line: number;
  readonly column: number;
  readonly kind: HardBindingKind;
  readonly reason: string;
  readonly sourceEnclosingSymbolId?: string;
  readonly provenance: ResolutionProvenance;
}
export interface OccurrenceAuditRow {
  readonly fileId: string;
  readonly path: string;
  readonly total: number;
  readonly byClass: Readonly<Record<OccurrenceClass, number>>;
}
export interface SemanticGraph {
  readonly schemaVersion: '3-pilot';
  readonly language: 'typescript';
  readonly snapshotId: string;
  readonly references: readonly SymbolReference[];
  readonly unresolved: readonly UnresolvedReference[];
  readonly hardBindings: readonly HardBinding[];
  readonly occurrenceAudit: readonly OccurrenceAuditRow[];
  readonly fileDeps: readonly { readonly fromFileId: string; readonly toFileId?: string; readonly specifier: string; readonly resolved: boolean }[];
}

export interface CandidateWithFile extends ResolutionCandidate { readonly fileId: string; }

/** A syntactic local binding (parameter or shadowing declarator) with an approximate scope (F1). */
export interface LocalBinding {
  readonly name: string;
  readonly declarator: number;
  readonly scopeStart: number;
  readonly scopeEnd: number;
}

export interface ExportRoute {
  readonly kind: 'local' | 'reexport' | 'star-namespace' | 'default-local';
  readonly symbolIds?: readonly string[];
  readonly fromSpecifier?: string;
  readonly importName?: string;
}
export interface FileExports { readonly explicit: ReadonlyMap<string, ExportRoute>; readonly stars: readonly string[] }
