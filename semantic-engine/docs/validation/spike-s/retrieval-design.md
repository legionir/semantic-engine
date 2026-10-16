# Goal-Aware Retrieval — Design Freeze (Extended Step 2)

**Version:** 1.0.0 (design freeze)
**Date:** 2026-09-22
**Status:** SUBMITTED FOR OWNER APPROVAL. **Implementation is NOT authorized** until the
owner ratifies this document (D-0022). G-3.7/G-3.9 remain FAIL; Phase 3/4 remain BLOCKED.
**Decision refs:** D-0020 (Spike-S NO-GO), D-0021 (persisted store required; orthogonal,
continues independently), D-0022 (option A approved for design-freeze review only).

## Frozen artifacts (hashes locked at this freeze)

| Artifact | SHA-256 |
|---|---|
| `gold.json` (v1.0.0, 20 tasks) | `636316016d26cca052ac34090316e72213899a0053777b91d059bc2a4f17cebc` |
| `cue-lexicon.json` (v1.0.0, 18 patterns) | `128577b229dceecd84bf9c588c7ef706eb8733543a3496cd4515a2b6b253c981` |
| `fixture/index.json` (12 files, 16 symbols) | `27ac808e95ff69b323eb3a2c0e44c0013425460e5f3d14f16f588c11da4ea9df` |

The benchmark runner must verify these hashes before executing and must abort on mismatch.
Golds and fixture are NOT edited after this freeze. Any lexicon or design change requires a
version bump plus a dated `DECISIONS.md` entry, and re-freeze before any benchmark run.

---

## 0. Scope and order

This design extends Step 2 (resolution fixes for the five Spike-S blindnesses) with a
goal-aware retrieval-direction layer, per owner ruling D-0022 (option A, conditional,
gate-bound). It covers exactly:

1. Resolver fixes F1–F7 (goal-blind, always-on correctness work).
2. A cue lexicon + direction engine (the only goal-text consumer).
3. Anti-gaming protocol (freeze, ablation, blind/aware runs, unseen fixture).
4. Re-gate criteria and reporting format.

It does NOT cover: the persisted snapshot store / runtime handle lifecycle (D-0021 step 3,
independent, parallelizable), Phase 4, or any gate-threshold change (option B rejected).

---

## 1. Separation principle (binding contract)

```
goal text  →  selection of a retrieval direction/class (fixed enum) + depth modifier. Nothing else.
source graph  →  ALL candidate generation and resolution.
gold fixture  →  evaluation ONLY. Never a runtime input.
```

Enforcement:

- The retrieval function is a pure deterministic function
  `retrieve(index, seedSymbol, goalText) → {symbols, retrievalMeta, statuses}`.
  It has no access to `gold.json`, task ids, `relevant[]` sets, or fixture names.
- Goal text can only select from the enum
  `{REFERRERS, DEPENDEES, CHAIN, HARD_SURFACE, SINGLETON}` + depth `1|bounded`
  via the frozen lexicon. No pattern may name or special-case any symbol, file, or
  identifier.
- Resolution confidence is computed by the resolver only (exact/ambiguous/heuristic/
  unresolved). The cue layer NEVER raises, caps only (budget truncation caps at heuristic).
- The benchmark harness evaluates in a separate phase from retrieval.

---

## 2. Cue definitions (owner item 1)

Full machine-readable definition: `cue-lexicon.json` v1.0.0 (frozen, hashed above).
Summary of the five directional classes and two additive behaviors:

| Class | Intent | Trigger patterns (ids) |
|---|---|---|
| `REFERRERS` (default) | incoming: who uses the seed | `usages?` (R1); passive `is/are/was/were … used/applied/called/referenced/imported/consumed` (R2); noun compounds `call site(s)`, `use points` … (R3); `consumers/users/callers… of/for` (R4); possessive `its/their consumers…` (R5); active verb with target-referring token AFTER the verb, or no target found (AV) |
| `DEPENDEES` | outgoing: what the seed needs | `sources/inputs/dependencies/deps/origins of/for/behind` (D1); possessive `its/their sources…` (D2); `what does X use/call/…` (D3); `built/based/derived/constructed on` (D4); active verb with target-referring token BEFORE the verb (AV) |
| `CHAIN` | bidirectional one-hop walk (both directions of the chain) | `chain(s)` (C1); `trace … chain/through/across` (C2) |
| `HARD_SURFACE` | scan of binding-hard references | `cannot/can't/fails to/unable to bind/resolve` (H1); `unresolved/unresolvable/unboundable/binding failure` (H2) |
| `SINGLETON` | seed alone (or its definition origin) | `definition/declaration/origin of` (S1); `where is … defined` (S2); `itself/alone/exactly that` (S3) |
| `AMBIGUITY_EXPANSION` (additive, always on) | same-name symbols all surface | resolution-level: seed name maps to N index symbols ⇒ all N included; refs to that name are `ambiguous` |
| `DEPTH` modifier (additive) | transitive walks | `transitively/transitive/recursively/all the way/full closure/closure` (M1) ⇒ depth 1 → 6 (budget-bounded) |

Deliberate exclusions (anti-misfire, verified on all 20 fixture-1 goals):

- `shadowed`, `re-exported`, `default-imported`, `re-export` are NOT lexicon words
  (T7's "shadowed parameter" and T6's "re-export chain" must not misfire the
  hard-surface scan or direction).
- Past participles (`used`, `called`, …) match ONLY through the passive auxiliary
  requirement (R2); the active-verb pattern (AV) never matches them.

Identifier-collision audit (executed at freeze): running every pattern against every
fixture identifier produces exactly one overlap — `use` (file `use.ts`) matched by AV
(`uses?`), a generic English verb that also occurs in fixture goal texts as ordinary
vocabulary ("everything that uses addition"). Allowlisted with this justification.
Rule for fixture-2: identifiers must avoid generic English retrieval-intent words.

### 2.1 Fired-cue simulation on fixture-1 (executed 2026-09-22, pre-freeze evidence)

| Task | Fired patterns | Direction |
|---|---|---|
| T1 | R1, R4 | REFERRERS |
| T2 | R2 | REFERRERS |
| T3 | R2 | REFERRERS |
| T4 | AV (target `it` after verb) | REFERRERS |
| T5 | C1, C2, D2, AV | CHAIN (priority over DEPENDEES) |
| T6 | C1 | CHAIN |
| T7 | — | default REFERRERS |
| T8 | — | default REFERRERS (+ ambiguity expansion) |
| T9 | R5 | REFERRERS |
| T10 | H1, AV | HARD_SURFACE (priority) |
| T11 | AV (seed `o` before verb) | DEPENDEES |
| T12–T15 | — | default REFERRERS |
| T16 | R2 | REFERRERS |
| T17 | R3, AV | REFERRERS |
| T18 | — | default REFERRERS |
| T19 | AV (no target found → fallback) | REFERRERS |
| T20 | AV (no target found → fallback) | REFERRERS |

---

## 3. Cue → behavior mapping, priorities, tie-breakers, budget (owner item 2)

### 3.1 Behaviors

- **REFERRERS**: `{seed}` ∪ enclosing index symbols of all resolved references to the
  seed (same-file and cross-file; routed bindings count; local-shadow bindings do not).
- **DEPENDEES**: `{seed}` ∪ symbols the seed references (outgoing resolved references),
  depth 1 by default, depth 6 with M1.
- **CHAIN**: `{seed}` ∪ referrers-of-seed ∪ dependees-of-seed (one hop each direction;
  M1 extends both).
- **HARD_SURFACE**: `{seed}` ∪ enclosing index symbols of every binding-hard reference
  (`bindingKind ∈ {local-shadow, re-export-routed, default-routed, namespace-routed,
  unresolved-use}`). Unresolved import declarations with no use site contribute no
  enclosing symbol; they are reported in the audit (fs, ghost).
- **SINGLETON**: `{seed}`; if the seed is reached via a re-export route, the route's
  origin symbol.
- **AMBIGUITY_EXPANSION** (additive): all same-name candidates included; references to
  the name carry `confidence=ambiguous` with the candidate list.

### 3.2 Priority and tie-breakers (deterministic)

- Exactly ONE directional class fires: the highest-priority class with ≥1 match.
  Priority: `HARD_SURFACE > CHAIN > SINGLETON > DEPENDEES > REFERRERS`.
  No cue at all ⇒ default direction REFERRERS.
- Within a class: earliest match span start → longer match → pattern id lexicographic.
- AV resolves to REFERRERS or DEPENDEES by position of the nearest target-referring
  token (seed name, case-insensitive word-boundary, or pronoun `it/its/them/they`):
  token after verb ⇒ REFERRERS; token before verb and none after ⇒ DEPENDEES; none
  found ⇒ REFERRERS (dominant-intent fallback).
- Additive behaviors (ambiguity expansion, depth) apply independently of the fired class.

### 3.3 Budget

- `maxSymbols = 64`, `maxDepth = 6` (transitive mode). Fixture-1's largest set is 6.
- Ranking under truncation: seed first → hop distance ascending → bindingKind rank
  (index-symbol > local-shadow > routed > unresolved) → symbolKey lexicographic.
- On truncation: `truncated=true`, `droppedCount` reported, overall confidence capped
  at heuristic. No silent truncation.

---

## 4. Goal classes (owner item 3) — coverage matrix

| Owner class | Handled by | Fixture-1 evidence | Fixture-2 must add |
|---|---|---|---|
| Direct reference | REFERRERS + F1/F2/F3/F5 binding | T1, T2, T3, T16–T20 | — |
| Same-file consumer | F3 same-file reference scan | T4 (`double`), T1 (`total`,`double`) | — |
| Transitive dependency | DEPENDEES + M1 depth | T5, T6 (one-hop) | ≥1 explicit transitive goal |
| Re-export / export-from | F5 routing + CHAIN | T6; calibration `via→mid` | `export * from`, 3-hop chain |
| Default binding | F5 | T9; calibration `Store` | default consumed at 2 sites |
| Ambiguous & unresolved | AMBIGUITY_EXPANSION + HARD_SURFACE + unresolved registration | T8, T10, T11; fs/ghost | cross-file same-name; namespace actually used in code |
| Scope-shadowed & same-name overloads | F1 scope-aware binding + F6 collision-free keys | T1 (shadow excluded), T7, T8, T11 | nested/arrow-function shadowing |

---

## 5. Resolver fixes F1–F7 (goal-blind, always-on)

| Fix | Content | Executed verification tests (unit level) |
|---|---|---|
| F1 occurrence classification & scope-aware binding | identifier occurrences classify as: reference, import-declaration, comment, string-literal, property-access, local-shadow (param/local whose span contains the occurrence wins over module bindings). Comments/strings/property-accesses/declarations are NOT references. | shadow.ts L3 `add+1` binds to param (not `s-add`); use.ts L4 comment is an occurrence, not a reference; usesfmt.ts `'x'` is a string occurrence |
| F2 multi-name import binding | every named specifier of every import statement binds (not just the first) | calc.ts `{add, sub}` → both bound; `{PI}` second statement bound |
| F3 same-file reference scan | uses in the defining file count as references | use.ts L2/L3 are references to `add` |
| F4 bidirectional reference graph | per-symbol outgoing references exposed (incoming already exists) | outgoing(grand) = {total, v, double}; outgoing(o) = {fmt(ambiguous)} |
| F5 default & re-export binding | default import ↔ `export default`; `export {x} from` / `export * from` create routing edges to the origin symbol (cycle-safe, depth-bounded); routed bindings tagged `bindingKind` | via.ts `add` resolves to `s-add` through mid; admin.ts `Store` resolves to `s-store`; mid→math edge exists |
| F6 collision-free symbol keys | keys disambiguated for same-name symbols (ordinal by source order); index schemaVersion bump 2.0.0 → 3.0.0 with migration entry (ties into D-0021 criterion 9) | keys of `s-fmt1` ≠ `s-fmt2`, both addressable; uniqueness check across index |
| F7 binding-kind tagging, no silent drops | every occurrence carries a class and status; binding-hard set = {local-shadow, re-export-routed, default-routed, namespace-routed, unresolved-use}; feeds HARD_SURFACE and audits | zero unclassified occurrences across all 12 files; binding-hard global count = 3 |

---

## 6. Anti-gaming protocol (owner item 4)

1. **Lexicon frozen & hashed before benchmark**: `cue-lexicon.json` v1.0.0, SHA-256
   recorded above; ratified with this document; runner verifies the hash before running.
2. **No fixture-specific vocabulary**: no pattern contains or special-cases any
   identifier, file name, or symbol name from fixture-1 or fixture-2. Automated
   match-based check (`scripts/check-cue-lexicon.js`, implemented with the engine)
   runs before every benchmark; allowlist is exactly `{use, uses}` with recorded
   justification. Fixture-2 vocabulary rule: identifiers avoid generic English
   retrieval words.
3. **Golds unchanged after freeze**: `gold.json` and `fixture/index.json` hashes locked
   (table above); runner aborts on mismatch. Fixture-2 golds freeze before their own
   first run (same rule as fixture-1).
4. **Blind AND aware runs recorded**: blind = cues disabled (default REFERRERS only,
   all fixes on); aware = full lexicon. Both persisted in results with identical
   reporting. Difference = measured retrieval-layer contribution.
5. **Ablation per cue, individually and combined**: matrix =
   {FULL, ALL-OFF, −CHAIN, −DEPENDEES, −HARD_SURFACE, −REFERRERS-explicit,
   −SINGLETON, −DEPTH, −AMBIGUITY_EXPANSION}. Macro and micro P/R per cell.
6. **Unseen fixtures reported**: fixture-2 protocol (section 9), authored after this
   freeze, results reported alongside fixture-1 in the re-gate report.

---

## 7. Re-gate criteria and reporting (owner item 5)

All criteria evaluated on the frozen fixture-1 golds, aware run, macro-primary:

1. Macro precision ≥ 0.95 **and** exact-class precision = 1.0 (wrong-exact = 0).
2. Macro recall ≥ B1 macro recall (measured B1, not predicted).
3. Macro recall > B0 macro recall.
4. Micro metrics reported (secondary, preregistered).
5. No increase in hidden unresolved: unresolved declarations 2 (down from 4), unresolved
   uses 0, zero silently dropped occurrences; full before/after classification table.
6. Incremental == full preserved: JSON deep-equal, same audit (changedPaths [src/use.ts]).
7. Separate reporting by resolution mode: exact / ambiguous / heuristic / unresolved
   counts per task and macro; blind and aware runs both recorded.
8. Confidence policy: a goal-text cue NEVER raises confidence above exact; direction and
   cue recorded in separate `retrievalMeta`; confidence distribution for shared symbols
   identical between blind and aware runs.
9. Ablation matrix (section 6.5) executed and reported.
10. Fixture-2 (unseen) reported with soft bars: macro P ≥ 0.90 and macro R ≥
    B1(fixture-2) − 0.05; any breach is investigated before Phase 3 can go green
    (owner may harden these bars later).
11. B0/B1 reproduction: baseline values must reproduce exactly (independence check).
12. Post-fix calibration table must match the preregistration in section 8.3; any
    deviation is investigated and reported, never tuned away.

---

## 8. Preregistered predictions (binding; deviation = investigate, not tune)

### 8.1 Per-task prediction (aware run, all fixes on)

Predicted sets derived analytically from the frozen fixture sources + the fired-cue
simulation in section 2.1 (both executed before freeze):

| Task | Seed | Direction | Predicted set | = Gold? | P | R |
|---|---|---|---|---|---|---|
| T1 | add | REFERRERS | add, total, double, r, r2, v | yes | 1.0 | 1.0 |
| T2 | sub | REFERRERS | sub, r | yes | 1.0 | 1.0 |
| T3 | PI | REFERRERS | pi, r2 | yes | 1.0 | 1.0 |
| T4 | total | REFERRERS | total, double, grand | yes | 1.0 | 1.0 |
| T5 | grand | CHAIN | grand, total, double, v | yes | 1.0 | 1.0 |
| T6 | v | CHAIN | v, grand, add | yes | 1.0 | 1.0 |
| T7 | f | default | f | yes | 1.0 | 1.0 |
| T8 | fmt1 | default+ambig | fmt1, fmt2, o | yes | 1.0 | 1.0 |
| T9 | Store | REFERRERS | store, s | yes | 1.0 | 1.0 |
| T10 | double | HARD_SURFACE | double, f, v, s | yes | 1.0 | 1.0 |
| T11 | o | DEPENDEES | o, fmt1, fmt2 | yes | 1.0 | 1.0 |
| T12 | r | default | r | yes | 1.0 | 1.0 |
| T13 | lonely | default | lonely | yes | 1.0 | 1.0 |
| T14 | s | default | s | yes | 1.0 | 1.0 |
| T15 | r2 | default | r2 | yes | 1.0 | 1.0 |
| T16–T20 | add | REFERRERS/default | add, total, double, r, r2, v | yes | 1.0 | 1.0 |

**Predicted aware: macro P = 1.000, macro R = 1.000 (micro 1.000/1.000).**
This assumes F1–F7 fully achieve their specified behavior; that assumption is exactly
what the executed tests and the re-gate check.

### 8.2 Blind run and ablation predictions (macro P / macro R)

Blind = fixes on, cues off. Falls short on T5 ({grand} R=0.25), T6 ({v,grand} R=0.667),
T10 ({double,grand} R=0.5), T11 ({o} R=0.333):

| Configuration | macro P | macro R | Passes R≥B1 (0.896)? |
|---|---|---|---|
| FULL (aware) | 1.000 | 1.000 | yes |
| ALL-OFF (blind) | 1.000 | 0.8875 | **no — fails by 0.85pp** |
| −CHAIN | 1.000 | 0.983 | yes (T5 rescued by D2 dependees; T6 falls) |
| −DEPENDEES | 1.000 | 0.967 | yes (T11 falls) |
| −HARD_SURFACE | 1.000 | 0.975 | yes (T10 falls to default) |
| −REFERRERS-explicit | 1.000 | 1.000 | yes (default = referrers; redundant on fixture-1, value measured on fixture-2) |
| −SINGLETON / −DEPTH | 1.000 | 1.000 | yes (no fixture-1 task fires them) |
| −AMBIGUITY_EXPANSION | 1.000 | 0.933 | yes (T8, T11 degrade) |

Honest notes: (a) the blind macro failure is narrow (0.8875 vs 0.896) and blind micro
recall (0.940) would pass B1-micro (0.851) — the gate metric is macro (preregistered),
so blind fails; the cue layer is necessary, and its necessity margin grows with fixture
richness (fixture-2 tests this). (b) This 0.8875 refines the earlier 0.875 ceiling
estimate from the D-0020 report (that estimate predated accounting for same-file and
multi-name refs in the blind baseline); direction of the conclusion is unchanged.

### 8.3 Post-fix calibration preregistration

- Unresolved import declarations: **2** — `fs` (bare namespace specifier, unused),
  `./ghost` (missing file). Down from 4: `Store` (default) and `via→mid` (re-export)
  become resolved.
- Unresolved uses: **0** (fs and ghost are never used in code).
- Binding-hard references (global): **3** — shadow.ts L3 (local-shadow, enclosing `s-f`),
  via.ts L2 (re-export-routed, enclosing `s-v`), admin.ts L2 (default-routed, `s-s`).
- Ambiguous refs: **1** (usesfmt.ts L2 `fmt`, candidates {s-fmt1, s-fmt2}).
- Wrong-exact: **0**.
- fileDeps: **13** edges (12 prior + mid→math export-from now visible);
  unresolvedSpecifiers exactly [`fs`, `./ghost`]; `via→mid` resolved **with 1 symbol**
  (s-add), closing the old "resolved=true, zero symbols" inconsistency.
- touchedUnresolved per task (files(gold+seed) rule): T4 ≥1 (fs), T5 ≥1 (fs),
  T10 ≥1 (fs), T13 ≥1 (ghost); all others 0.
- touchedBindingHard per task: T1, T5, T6, T7, T9, T14, T16–T20 = 1 each; T10 = 3;
  others 0.
- Incremental == full: equality holds (JSON deep-equal), changedPaths [src/use.ts].
- Determinism: 3 consecutive runs byte-identical modulo generatedAt.
- B0/B1 reproduction: B0 macro P=0.582 R=0.787; B1 macro P=0.603 R=0.896 (must match
  Spike-S exactly).

---

## 9. Unseen fixture protocol (fixture-2)

- Authored AFTER this freeze, BEFORE the re-gate run; different domain and vocabulary;
  zero identifier/file/symbol overlap with fixture-1; identifiers avoid generic English
  retrieval-intent words (the `use` lesson).
- ~12 files / 12–16 tasks; golds (gold-2.json) frozen before their first run, authored
  by the same frozen method (utility judgments from goal text, method-agnostic).
- Must exercise every owner class, especially what fixture-1 cannot: explicit transitive
  goal (M1), definition-through-re-export (S1/S2), explicit singleton (S3), active
  dependees "what does X use" (D3), namespace actually used in code (unresolved use with
  an enclosing symbol), `export * from`, 3-hop chain, cross-file same-name ambiguity,
  string-literal and property-access probes, comment-mention probe, nested/arrow
  shadowing, default export consumed at two sites.
- Reporting: same metrics, blind+aware, ablations; soft bars per section 7.10. Not
  auto-blocking; owner may harden after review.

---

## 10. Risks and failure modes

| Risk | Exposure | Mitigation |
|---|---|---|
| F1 syntactic approximations (nested scopes, arrows, template literals, multi-line strings) | medium | conservative classification (never exact without certainty); fixture-2 probes; failure ⇒ downgrade to heuristic, never wrong-exact |
| F5 edge cases (`export *` conflicts, circular re-exports) | medium | cycle-safe bounded routing; conflict ⇒ ambiguous, not silent pick; unit tests |
| Single-letter seed names in AV position detection (T11 `o`) | low | word-boundary matching verified; fixture-2 uses multi-char names; documented limitation |
| Narrow blind-gap (0.8875 vs 0.896) makes cue necessity look small on fixture-1 | low | honest reporting (8.2); fixture-2 widens the test surface |
| Predictions assume fixes fully succeed | certain (they are predictions) | deviations are investigated and reported against this table; no tuning, no lexicon edits without re-freeze |
| Lexicon overfit to fixture-1 phrasing | medium | freeze + hash + ablation + fixture-2 generalization report; the only true cure is fixture-2 evidence |

---

## 11. Size estimate and implementation order (post-approval only)

- F6, F2, F3 (mechanical): ~0.5 wk
- F1 + F7 (classification): ~0.5–1 wk
- F5 (routing): ~1–1.5 wk
- F4 (graph) + retrieval engine + lexicon loader + ablation harness: ~0.5–1 wk
- Fixture-2 authoring: ~0.5 wk
- Blind/aware/ablation runs + report + re-gate: ~0.5 wk

**Total: ~3.5–5 engineer-weeks** (supersedes D-0020's 2–4 wk, which excluded the
retrieval layer and fixture-2). Persisted store (D-0021) is separate and parallelizable.

Order: fixes (with their unit tests) → blind run (checkpoint: must match section 8.2
blind prediction) → retrieval engine → aware run → ablations → fixture-2 → report →
re-gate. Any blind-run divergence from 8.2 halts implementation for investigation.

---

## 12. Change policy

- This document + `cue-lexicon.json` v1.0.0 are the freeze. Ratification is recorded as
  a D-0022 status update in `DECISIONS.md`.
- Any change to cues, behaviors, priorities, budget, criteria, or predictions: new
  version, dated `DECISIONS.md` entry, re-hash, re-freeze — BEFORE any benchmark run.
- Gate thresholds in `docs/GATES.md` are untouched (option B rejected).
