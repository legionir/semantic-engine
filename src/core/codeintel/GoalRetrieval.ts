import { ProjectIndexReader } from '../../ai/ProjectIndexReader';
import { SymbolEntry } from '../types/project-index.types';
import { compareCanonical } from '../contracts/codeintel';
import { SemanticGraph, SymbolReference } from './Phase3SemanticGraph';
import { symbolKeyFor } from './Phase3SemanticGraph';
import lexiconJson from './cue-lexicon.json';

/**
 * Goal-aware retrieval (design freeze: docs/validation/spike-s/retrieval-design.md,
 * cue-lexicon.json v1.0.0, D-0022/D-0023).
 *
 * Separation principle (binding):
 *   goal text  → direction/class selection only (fixed enum via the frozen lexicon)
 *   source graph → all candidate generation and resolution
 *   gold fixture → never a runtime input (this module has no gold access)
 *
 * The cue layer NEVER raises resolution confidence; it is recorded separately in
 * `retrievalMeta`. Deterministic: fixed tie-breaks, no scores, no randomness.
 */

export type RetrievalDirection = 'REFERRERS' | 'DEPENDEES' | 'CHAIN' | 'HARD_SURFACE' | 'SINGLETON';

export interface CueLexiconPattern {
  readonly id: string;
  readonly class: string;
  readonly regex: string;
  readonly flags: string;
  readonly behavior: string;
  readonly note?: string;
}
export interface CueLexicon {
  readonly name: string;
  readonly version: string;
  readonly frozenAt: string;
  readonly language: string;
  readonly status: string;
  readonly notes: readonly string[];
  readonly defaults: { readonly direction: string; readonly depth: number; readonly maxSymbols: number; readonly maxDepth: number; readonly defaultJustification: string };
  readonly priority: readonly string[];
  readonly additiveBehaviors: Readonly<Record<string, string>>;
  readonly targetReferringTokens: { readonly pronouns: readonly string[]; readonly seedName: string };
  readonly tieBreak: Readonly<Record<string, string>>;
  readonly budgetBehavior: { readonly maxSymbols: number; readonly ranking: string; readonly onTruncation: string };
  readonly patterns: readonly CueLexiconPattern[];
}

/** The frozen lexicon v1.0.0, byte-identical to docs/validation/spike-s/cue-lexicon.json. */
export const CUE_LEXICON = lexiconJson as CueLexicon;

export interface RetrievalOptions {
  /** Blind mode: cues disabled, default direction only. */
  readonly cuesEnabled?: boolean;
  /** Ablation: directional classes whose patterns are removed (AV falls back to REFERRERS). */
  readonly disabledClasses?: readonly string[];
  /** Ablation: ambiguous references contribute no targets and no same-name siblings. */
  readonly disableAmbiguityExpansion?: boolean;
  readonly maxSymbols?: number;
}

export interface FiredCue {
  readonly patternId: string;
  readonly class: string;
  readonly token: string;
  readonly index: number;
  readonly length: number;
}
export interface RetrievalMeta {
  readonly direction: RetrievalDirection;
  readonly cue: FiredCue | null;
  readonly reason: 'cue' | 'default-blind' | 'default-no-cue';
  readonly depth: number;
  readonly ambiguityExpansion: boolean;
  readonly truncated: boolean;
  readonly droppedCount: number;
  readonly sameNameCount: number;
  readonly unresolvedDeclarations: number;
}
export interface RetrievalResult {
  readonly symbols: readonly string[];
  readonly meta: RetrievalMeta;
}

const PRONOUNS = ['it', 'its', 'them', 'they'];
const BINDING_RANK: Readonly<Record<string, number>> = { direct: 0, 'same-file': 1, 'namespace-routed': 2, 're-export-routed': 3, 'default-routed': 4 };

export class GoalRetriever {
  constructor(private readonly reader: ProjectIndexReader) {}

  /** Fire the frozen lexicon against a goal (deterministic; exposed for tests and audits). */
  fireCues(goal: string, seed: SymbolEntry, options: RetrievalOptions = {}): { fired: readonly FiredCue[]; direction: RetrievalDirection; winning: FiredCue | null; depth: number } {
    if (options.cuesEnabled === false) return { fired: [], direction: 'REFERRERS', winning: null, depth: CUE_LEXICON.defaults.depth };
    const disabled = new Set(options.disabledClasses ?? []);
    const fired: FiredCue[] = [];
    let depthModifier = false;
    for (const pattern of CUE_LEXICON.patterns) {
      const re = new RegExp(pattern.regex, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
      let m: RegExpExecArray | null;
      while ((m = re.exec(goal))) {
        if (m[0].length === 0) { re.lastIndex++; continue; }
        if (pattern.id === 'M1') { depthModifier = !disabled.has('DEPTH_MODIFIER'); continue; }
        let cls = pattern.class;
        if (pattern.id === 'AV') cls = resolveActiveVerbClass(goal, m, seed, disabled);
        if (disabled.has(cls)) continue;
        fired.push({ patternId: pattern.id, class: cls, token: m[0], index: m.index, length: m[0].length });
      }
    }
    const priority = CUE_LEXICON.priority;
    const directional = fired
      .filter(f => priority.includes(f.class))
      .sort((a, b) => {
        const pa = priority.indexOf(a.class);
        const pb = priority.indexOf(b.class);
        if (pa !== pb) return pa - pb;
        if (a.index !== b.index) return a.index - b.index;
        if (a.length !== b.length) return b.length - a.length;
        return a.patternId < b.patternId ? -1 : a.patternId > b.patternId ? 1 : 0;
      });
    const winning = directional[0] ?? null;
    const direction = (winning?.class as RetrievalDirection | undefined) ?? (CUE_LEXICON.defaults.direction as RetrievalDirection);
    const depth = depthModifier ? CUE_LEXICON.defaults.maxDepth : CUE_LEXICON.defaults.depth;
    return { fired, direction, winning, depth };
  }

  /** Pure deterministic retrieval over a built graph. No gold access, no filesystem. */
  retrieve(graph: SemanticGraph, seed: SymbolEntry, goal: string, options: RetrievalOptions = {}): RetrievalResult {
    const cuesEnabled = options.cuesEnabled !== false;
    const { direction, winning, depth } = this.fireCues(goal, seed, options);
    const expansion = options.disableAmbiguityExpansion !== true;
    const sameName = expansion ? this.reader.getSymbolsByName(seed.name).map(s => s.id) : [seed.id];

    const members = new Map<string, { hop: number; bindingRank: number }>();
    const add = (id: string, hop: number, bindingRank: number): void => {
      const existing = members.get(id);
      if (!existing || hop < existing.hop || (hop === existing.hop && bindingRank < existing.bindingRank)) members.set(id, { hop, bindingRank });
    };
    add(seed.id, 0, 0);
    for (const id of sameName) if (id !== seed.id) add(id, 1, 0);

    if (direction === 'REFERRERS' || direction === 'CHAIN') {
      for (const id of this.referrerSymbols(graph, seed.id)) add(id, 1, 1);
    }
    if (direction === 'DEPENDEES' || direction === 'CHAIN') {
      const seen = new Set<string>([seed.id]);
      let frontier: string[] = [seed.id];
      for (let level = 0; level < depth; level++) {
        const next: string[] = [];
        for (const sourceId of frontier) {
          for (const ref of graph.references) {
            if (ref.sourceEnclosingSymbolId !== sourceId) continue;
            const targets = ref.targetSymbolId
              ? [ref.targetSymbolId]
              : expansion ? ref.provenance.candidates.map(c => c.symbolId) : [];
            for (const target of targets) {
              if (seen.has(target)) continue;
              seen.add(target);
              add(target, level + 1, BINDING_RANK[ref.bindingKind ?? 'direct'] ?? 2);
              next.push(target);
            }
          }
        }
        frontier = next;
        if (!frontier.length) break;
      }
    }
    if (direction === 'HARD_SURFACE') {
      for (const ref of graph.references) {
        if (ref.bindingKind !== 're-export-routed' && ref.bindingKind !== 'default-routed' && ref.bindingKind !== 'namespace-routed') continue;
        if (ref.sourceEnclosingSymbolId) add(ref.sourceEnclosingSymbolId, 1, 1);
      }
      for (const hb of graph.hardBindings) {
        if (hb.sourceEnclosingSymbolId) add(hb.sourceEnclosingSymbolId, 1, 1);
      }
    }
    // SINGLETON: seed (+ same-name expansion above) only.

    const maxSymbols = options.maxSymbols ?? CUE_LEXICON.budgetBehavior.maxSymbols;
    const ordered = [...members.entries()]
      .sort((a, b) => a[1].hop - b[1].hop
        || a[1].bindingRank - b[1].bindingRank
        || compareCanonical(this.keyOf(a[0]), this.keyOf(b[0])));
    const kept = ordered.slice(0, maxSymbols);
    const meta: RetrievalMeta = {
      direction,
      cue: winning,
      reason: !cuesEnabled ? 'default-blind' : winning ? 'cue' : 'default-no-cue',
      depth,
      ambiguityExpansion: expansion,
      truncated: ordered.length > maxSymbols,
      droppedCount: Math.max(0, ordered.length - maxSymbols),
      sameNameCount: sameName.length,
      unresolvedDeclarations: graph.unresolved.length,
    };
    return { symbols: kept.map(([id]) => id), meta };
  }

  /** Enclosing symbols of references that target the seed (directly or as an ambiguous candidate). */
  private referrerSymbols(graph: SemanticGraph, seedId: string): string[] {
    const out: string[] = [];
    for (const ref of graph.references) {
      if (ref.targetSymbolId === seedId || ref.provenance.candidates.some(c => c.symbolId === seedId)) {
        if (ref.sourceEnclosingSymbolId) out.push(ref.sourceEnclosingSymbolId);
      }
    }
    return out;
  }

  private keyOf(symbolId: string): string {
    const symbol = this.reader.getSymbolById(symbolId);
    return symbol ? symbolKeyFor(this.reader, symbol) : symbolId;
  }
}

/** AV position rule: target-referring token before the verb (and none after) ⇒ DEPENDEES, else REFERRERS. */
function resolveActiveVerbClass(goal: string, match: RegExpExecArray, seed: SymbolEntry, disabled: Set<string>): string {
  const positions: number[] = [];
  const nameRe = new RegExp(`\\b${escapeRegExp(seed.name)}\\b`, 'giu');
  let nm: RegExpExecArray | null;
  while ((nm = nameRe.exec(goal))) positions.push(nm.index);
  for (const pronoun of PRONOUNS) {
    const pronounRe = new RegExp(`\\b${pronoun}\\b`, 'giu');
    while ((nm = pronounRe.exec(goal))) positions.push(nm.index);
  }
  positions.sort((a, b) => a - b);
  const before = positions.some(p => p < match.index);
  const after = positions.some(p => p > match.index);
  const resolved = before && !after ? 'DEPENDEES' : 'REFERRERS';
  return resolved === 'DEPENDEES' && disabled.has('DEPENDEES') ? 'REFERRERS' : resolved;
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'); }

/** Convenience: classify a reference set by resolution mode (reporting helper, §7 criterion 7). */
export function referenceModeCounts(references: readonly SymbolReference[]): { exact: number; ambiguous: number; heuristic: number; unresolved: number } {
  const counts = { exact: 0, ambiguous: 0, heuristic: 0, unresolved: 0 };
  for (const ref of references) counts[ref.provenance.confidence]++;
  return counts;
}
