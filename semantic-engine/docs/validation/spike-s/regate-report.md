# Spike-S Re-Gate Report — Resolution Fixes F1–F7 + Goal-Aware Retrieval

**Date:** 2026-09-22
**Execution authority:** D-0023 (owner delegation; standard measurement discipline kept).
**Design:** `retrieval-design.md` v1.0.0 + `cue-lexicon.json` v1.0.0 (frozen at commit `996fdd3`).
**Engine commits:** `e4fdda9` (F1–F7 + retrieval + harness + tests), `7bf3f4d` (fixture-2 freeze + star-conflict fix).
**Artifacts:** `regate.js`, `results-regate.json` (fixture-1), `results-regate-fixture2.json` (unseen), `gen-fixture2.js`, `gold-2.json` (frozen before first run).

---

## 1. Verdict

| Gate (docs/GATES.md, Phase 3) | Bar | Measured (aware, fixture-1) | Result | Evidence |
|---|---|---|---|---|
| Exact-class precision on gold fixture | ≥ 0.95 | macro P = **1.000**; wrong-exact = **0** | **PASS** | LOCALLY VERIFIED (regate.js, deterministic) |
| Recall vs baseline | ≥ B1 and > B0 | macro R = **1.000** vs B1 0.896, B0 0.787 | **PASS** | LOCALLY VERIFIED |
| Semantic incremental == full | 100% | JSON deep-equal, 3/3 deterministic builds | **PASS** | LOCALLY VERIFIED |
| Unresolved registration without silent deletion | 100% | unresolved 2/2 as preregistered; 0 unclassified occurrences; every occurrence audited | **PASS** | LOCALLY VERIFIED |

**G-3.7 / G-3.9: measured PASS on the frozen fixture-1 golds.**
Generalization: on the **unseen fixture-2** (frozen before first contact, disjoint vocabulary) the
aware run scored macro P = R = **1.000 (16/16)** on the first execution, with zero tuning.

**Phase 3 remains BLOCKED** only on G-3.1/G-3.5 (persisted snapshot store + runtime/MCP handle
lifecycle, D-0021) — the ten persistence criteria are still unexecuted. Phase 4 remains blocked
behind Phase 3. No gate threshold was changed (option B never exercised).

## 2. Freeze integrity

- `regate.js` verifies SHA-256 of `gold.json`, `fixture/index.json`, `cue-lexicon.json` (fixture-1)
  and `gold-2.json`, `fixture2/index.json` (fixture-2) before running; aborts on mismatch.
- Anti-drift: the engine's embedded lexicon (`dist/core/codeintel/cue-lexicon.json`) is deep-equal
  to the frozen `cue-lexicon.json` (byte-identical copy committed in `src/core/codeintel/`).
- Golds and fixture-1 were never edited after their freezes. Fixture-2 golds were authored and
  committed (`7bf3f4d`) **before** the first run on them.
- Anti-gaming identifier check executed as a unit test: no lexicon pattern matches any fixture-1
  or fixture-2 identifier except the allowlisted generic verb `use`.

## 3. Fixture-1 results (frozen golds, 20 tasks)

### 3.1 Modes (macro precision / macro recall)

| Configuration | Predicted (design §8.2) | Actual | Note |
|---|---|---|---|
| AWARE (full) | 1.000 / 1.000 | **1.000 / 1.000** | 20/20 task sets exactly equal to design §8.1 predictions |
| BLIND (all cues off) | 1.000 / 0.8875 | **0.975 / 0.875** | erratum 1 below; still fails R≥B1 — cue layer necessary |
| −CHAIN | 1.000 / 0.983 | 1.000 / 0.983 | T5 rescued by D2 dependees; T6 falls |
| −DEPENDEES | 1.000 / 0.967 | 1.000 / 0.967 | T11 falls |
| −HARD_SURFACE | 1.000 / 0.975 | **0.975 / 0.963** | erratum 2 below |
| −REFERRERS-explicit | 1.000 / 1.000 | 1.000 / 1.000 | default = referrers; redundant on fixture-1 |
| −SINGLETON / −DEPTH | 1.000 / 1.000 | 1.000 / 1.000 | no fixture-1 task fires them |
| −AMBIGUITY_EXPANSION | 1.000 / 0.950 | 1.000 / 0.950 | T8, T11 degrade |
| B0 keywords | 0.582 / 0.787 | 0.582 / 0.787 | exact reproduction (independence check) |
| B1 depth-1 closure | 0.603 / 0.896 | 0.603 / 0.896 | exact reproduction |

Ablation conclusion holds: **every** single-cue ablation still passes R≥B1; only the all-off
(blind) configuration fails it — the retrieval layer is necessary and no single cue is load-bearing
on fixture-1.

### 3.2 Prediction errata (honest record, no re-tuning)

All three stem from hand-derivation arithmetic slips in **my** §8.2/§8.3 predictions, not from
engine behavior; the direction of every conclusion is unchanged and nothing was tuned to fix them:

1. **Blind T10:** predicted `{double, grand}` would score R=0.5. `grand` is **not** in T10's gold
   (`{double, f, v, s}`), so blind T10 is R=0.25, P=0.5 → blind macro 0.975/0.875 (design said
   1.000/0.8875). Blind fails R≥B1 by a *wider* margin than predicted.
2. **−HARD_SURFACE:** same root cause (T10 falls to default referrers `{double, grand}`) →
   0.975/0.963 (design said 1.000/0.975). Still passes R≥B1.
3. **touchedUnresolved (§8.3):** the frozen gold.json rule (files(gold+seed) OR names) gives
   {T4, T5, **T6**, T13} — T6's gold includes `grand` (app.ts), where the `fs` declaration lives;
   T10 has no app.ts file and touches nothing. Design §8.3 wrongly listed {T4, T5, T10, T13}.
   Actual matches the correctly-derived expectation; the harness rule is recorded in `regate.js`.
   (touchedBindingHard values matched §8.3 exactly with file-or-enclosing counting.)

### 3.3 Post-fix calibration (design §8.3 vs actual) — all green

unresolved = 2 (`fs` bare namespace, `ghost` missing file; Store-default and via→mid now
resolved) ✓ · hardBindings = 1 (shadow L3 local-shadow, enclosing s-f) ✓ · binding-hard
enclosings = {s-f, s-v, s-s} ✓ · ambiguous refs = 1 (fmt overloads, candidates {s-fmt1,s-fmt2}) ✓
· wrong-exact = 0 ✓ · fileDeps = 13 with the mid→math export-from edge visible ✓ · via→mid
resolved **and yields s-add** (bindingKind re-export-routed) ✓ · unclassified occurrences = 0 ✓ ·
incremental == full JSON-equal ✓ · invalid changed-path rejected ✓ · 3/3 deterministic builds ✓ ·
B0/B1 reproduced exactly ✓.

Resolution-mode distribution (graph): exact 14, ambiguous 1, heuristic 0, unresolved 0 (+ 1
hardBinding, 2 unresolved declarations). Per-task mode counts are in `results-regate.json`.

Confidence policy: the cue layer records direction/cue in `retrievalMeta` only; the same graph
object is shared by blind and aware runs, so reference confidences are identical by construction
(unit-tested: cue metadata never mutates provenance; budget truncation caps at heuristic and never
raises anything).

## 4. Fixture-2 (unseen) results — 16/16 on first contact

Authored after the lexicon freeze, frozen before first run, zero identifier overlap with fixture-1,
disjoint goal phrasings (see `gold-2.json` notes). First execution ever:

| Configuration | macro P / macro R |
|---|---|
| AWARE (full) | **1.000 / 1.000** (16/16; U1–U16 all exact) |
| BLIND (cues off) | 0.927 / 0.757 |
| B0 keywords | 0.544 / 0.884 |
| B1 depth-1 closure | 0.590 / 0.846 |

Soft bars (owner, D-0022): P≥0.90 ✓, R≥B1−0.05 ✓ (in fact the hard bars would also pass:
1.000 ≥ 0.95, 1.000 ≥ 0.846, 1.000 > 0.884). Calibration: unresolved 2/2 (`nodefs` namespace
actually used in code — unresolved-use with enclosing; `phantom` missing file), ambiguous refs 1
(the `export *` star conflict surfaces **both** rate candidates instead of silently picking one),
fileDeps 18/18, wrong-exact 0, unclassified 0, incremental equal, deterministic.

The blind gap is wider on fixture-2 (0.757 vs fixture-1's 0.875): the cue layer's necessity grows
with fixture richness, exactly as the design's risk section predicted.

Covered classes (design §4 matrix): transitive closure (U2, M1 fires), definition-of (U4, S2),
explicit singleton (U5, S3), active dependees (U3, D3), chain (U6), hard-surface scan with
shadow/re-export/default/namespace/star-conflict sites (U7), cross-file same-name ambiguity (U8,
U9, U16), default export at two sites (U7), nested + arrow shadowing (U7), namespace actually used
(U7), `export * from` conflict (U16), string/property-key/property-access/comment probes (U13,
U14 vs decoy), missing import (U12).

## 5. Implementation notes (deviations recorded, none silent)

- **Star conflicts:** design §10 said "conflict ⇒ ambiguous"; the first implementation took the
  first star. Fixed **before** the fixture-2 run (commit `7bf3f4d`): star exports now merge
  candidates and surface as ambiguous. Fixture-1 re-verified green after the change (no stars in
  fixture-1; no behavioral change there).
- **F6 keys:** implemented at the pilot level (`symbolKeyFor`: path::name::kind`#ordinal` by
  source order, same scheme as Phase1Platform.outline). No project-index schema bump was needed —
  the collision was in graph-derived keys, not index schema (index symbols already have unique
  ids). This corrects design §5's "index schemaVersion 2.0.0 → 3.0.0" note; schema migration
  obligations transfer to the future persisted store (D-0021 criterion 9).
- **F1 approximations:** scope analysis is syntactic (indexed-symbol spans, param lists of indexed
  functions, nested `function` params, arrow params, const/let/var block approximation). On
  unscannable files (unbalanced quotes/braces) references degrade to `heuristic`, never a wrong
  `exact`. Both fixtures scanned cleanly (0 unclassified, 0 heuristic).

## 6. Tests

- `Phase3Retrieval.test.ts`: 18 executed tests covering every F1–F7 row of design §5 plus cue
  firing, directions, ambiguity expansion, budget truncation, ablation switches, and the
  anti-gaming identifier invariant (fixture-1 + fixture-2 identifiers).
- Pre-existing `Phase3SemanticGraph.test.ts` (3 tests) unchanged and green.
- Full repository suite: **235 suites / 3132 tests green**, `npm run build` and `npx eslint src`
  exit 0 (one new lint warning fixed; pre-existing warnings untouched).

## 8. Persisted-path re-run (added 2026-09-22, D-0025)

The harness now also executes the D-0021 ordered step "re-run the frozen goldens
through the persisted path": the fixture graph is published to a real
`GraphSnapshotStore`, a FRESH store instance is reopened (simulated restart), and every
gold task is re-run against the persisted graph. Both fixtures:
`graphEqual=true handleResolves=true taskParity=true` — fixture-1 20/20 and fixture-2
16/16 results byte-identical to the in-memory goal-aware run. Store-level lifecycle
criteria (restart, durable handles, fail-closed stale/mismatch, crash recovery,
migration, cleanup, MCP/Gateway parity) are executed in `GraphSnapshotStore.test.ts`,
`GraphSnapshotMcp.test.ts` and `GraphSnapshotGateway.e2e.test.ts` (D-0025).

## 7. What Phase 3 still needs (unchanged order, D-0021/D-0023)

1. ~~Fix resolution per the five Spike-S blindnesses~~ **DONE** (this report, D-0024).
2. ~~Persisted snapshot store + runtime/MCP handle lifecycle~~ **DONE** (D-0025: all ten
   executed-test criteria green, incl. MCP and Gateway levels).
3. ~~Re-run the frozen goldens through the persisted path~~ **DONE** (§8 above).
4. Phase 3 executive gate-closure presented for owner review → on acceptance, Phase 4
   unblocked.
