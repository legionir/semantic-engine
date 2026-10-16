# Spike-S Report — Phase 3 pilot retrieval on the gold fixture

- Date: 2026-09-22. Branch: `arena/01a0c5f3-semantic-engine-structured-ai`.
- Pilot: `Phase3SemanticGraphPilot` (`src/core/codeintel/Phase3SemanticGraph.ts`, executed via tracked `dist/`, in sync at HEAD).
- Verdict: **NO-GO as-is** — the raw heuristic resolver does not clear any of the three locked bars. The failure is structural (five distinct blindnesses, all evidenced below), not fixture noise. A scoped path exists: **go-with-graph-and-scope-work** (see §6). This report is decision input for G-3.7/G-3.9; it closes no gate.

## 1. Result vs locked bars (measured, never changed)

| aggregation | M1 pilot P / R | B0 keywords P / R | B1 closure P / R |
|---|---|---|---|
| macro (PRIMARY, mean of per-task) | **0.925 / 0.742** | 0.582 / 0.787 | 0.603 / 0.896 |
| micro (global TP/FP/FN) | 0.873 / 0.716 | 0.322 / 0.731 | 0.533 / 0.851 |

Gates (`docs/GATES.md`): macro precision ≥ 0.95 → **0.925 FAIL**; macro recall ≥ B1 → **0.742 < 0.896 FAIL**; macro recall > B0 → **0.742 < 0.787 FAIL**. Micro aggregation agrees on all three comparisons. Full per-task data: `results.json` (deterministic across runs modulo `generatedAt`).

## 2. Per-task scores

| task | seed | M1 P/R | B0 P/R | B1 P/R | M1 set |
|---|---|---|---|---|---|
| T1 usages-of-add | add | .833/.833 | .667/1.0 | .625/.833 | add,total,double,r,r2,f(+FP) |
| T2 subtraction-applied | sub | 1.0/.500 | 1.0/0 | .250/1.0 | sub (miss r) |
| T3 PI-used | pi | 1.0/1.0 | .400/1.0 | .250/1.0 | pi,r2 |
| T4 total-consumers | total | 1.0/.667 | 1.0/1.0 | .500/1.0 | total,grand (miss double) |
| T5 grand-chain | grand | 1.0/.250 | .400/1.0 | 1.0/1.0 | grand (miss chain) |
| T6 v-reexport-chain | v | 1.0/.667 | .188/1.0 | 1.0/.667 | v,grand (miss add) |
| T7 f-shadow-param | f | 1.0/1.0 | .063/1.0 | .250/1.0 | f |
| T8 vague-format-helper | fmt1 | 1.0/.667 | 1.0/0 | 1.0/1.0 | fmt1,o (miss fmt2) |
| T9 Store-consumers | store | 1.0/.500 | 1.0/1.0 | 1.0/1.0 | store (miss s) |
| T10 unbindable-refs | double | .500/.250 | .273/.750 | .167/.250 | double,grand(+FP) |
| T11 fmt-overload | o | 1.0/.333 | .188/1.0 | 1.0/1.0 | o (miss overloads) |
| T12–T15 controls | r/lonely/s/r2 | 1.0/1.0 | R=1.0 | R=1.0 | seed only |
| T16–T20 add variants | add | .833/.833 | R∈{1,1,1,0,0} | .625/.833 | same as T1 |

B0 empty-return convention: precision of an empty set scores 1 with recall 0 (T2/T8/T19/T20). It does not affect any gate (gates use M1 precision and recall comparisons). Sensitivity: with a 0-for-empty convention B0 macro-P would be 0.382 instead of 0.582; no conclusion changes.

## 3. Why the pilot loses — five evidenced blindnesses

1. **Scope-blind exact (precision killer).** `shadow.ts` param/use refs are labeled `exact` (unique import→export mapping) but rebind the parameter, not `math/add`. 12 of the 13 wrong-exact refs (6 add-tasks × 2). Macro-P 0.925 misses 0.95 by exactly this FP.
2. **First-named-import-only (T2).** `import { add, sub }` tracks `add`, drops `sub`; `sub` gets zero refs anywhere → R=0.5 while B1=1.0.
3. **Cross-file-occurrences-only (T4).** Same-file consumer `double = add(total,total)` is invisible: the pilot scans occurrences only in files holding an import item for the name. B1 sees it via file neighborhood.
4. **No graph walk (T5/T6/T11).** Single-query `referencesFor` does not traverse `fileDeps` in either direction: chains (grand←total/double/v), re-export hops (v→mid→add), and seed's own imports (o→fmt overloads) are missed. The pilot *emits* the deps but the query does not walk them.
5. **Default / re-export / export-from gaps (T1/T9).** Default import yields zero candidates (index names the class `Store`, pilot wants `default`) → T9 R=0.5. `export { add } from` lines are invisible to the import-only regex (no mid edge at all); `via→mid` dep reads `resolved=true` while the import lands in `unresolved` — retained, but inconsistent.

Additional finding (not scored): `fmt1`/`fmt2` produce **identical symbol keys** (same path/name/kind), so `referencesFor` cannot address one overload; the ambiguous ref attaches key-first-only and the second overload is unreachable by key.

## 4. What the pilot gets right (calibration all green)

- Unresolved retention 4/4 with correct reasons: `fs` (namespace + bare specifier), `Store` (default), `ghost` (missing file), `add` from `./mid` (re-export, file resolves, no symbol). Nothing silently dropped.
- Ambiguity surfaced: exactly 1 ambiguous ref (fmt overloads, 2 candidates, reason `multiple matching exports`); name-only matching never labeled exact (no `name-only` via exists in the pilot).
- Touched-unresolved calibration 20/20; fileDeps 12/12 with unresolved specifiers exactly `[./ghost, fs]`; incremental==full JSON-identical plus invalid-path rejection — the conservative rebuild contract holds.

## 5. Threats, limits, and preregistration notes

- Golds (`gold.json`) were frozen before the first full run and are method-agnostic utility judgments; no gold was edited after any run. One pre-freeze smoke test executed `build()` + `referencesFor(s-add)` to validate harness wiring; it confirmed source-derived expectations and added no information all calibration values were already derivable from the pilot source. Disclosed here for the record.
- B0 is a deliberately generous recall baseline (union of substring matches); junk-token sweeps (e.g. `re` from `re-export`, single letters) inflate its recall. That is the honest price of a recall baseline, and the pilot still loses to it.
- B1 direction (both-direction depth-1) was preregistered; importers-only would score macro-R 0.825 instead of 0.896 — still above the pilot, so the gate outcome is robust to this choice.
- Fixture is small (12 files / 16 symbols), single-language, need-not-compile by design. The measured gaps are structural (visible in the algorithm), so scale-up would not rescue the bars; if anything a larger fixture adds more shadow/re-export surface.
- No adopted-tool comparison exists to run: `docs/phase0-adopt-vs-build.md` is dependency-only under an in-house rule. Stated explicitly per plan.

## 6. Size estimate for a real Phase 3 investment (rough, not a plan)

To clear the bars the pilot would need, at minimum: multi-name import tracking; same-file occurrence scan; `export-from` edges; default-export/default-import binding; re-export chain following; both-direction reference walk (or a chain query); scope-aware (or LSP-confirmed) `exact`; collision-free symbol keys. That is roughly a rewrite of the resolution core around a real binder — estimated **2–4 engineer-weeks** for the resolver plus gold-fixture extension and re-measurement, before any migration/persistence work (G-3.1/G-3.5, still owner decisions). Recommended next decision for the owner: **no-go on the current pilot; go only with the scoped work above, re-gated by this same frozen fixture.**
