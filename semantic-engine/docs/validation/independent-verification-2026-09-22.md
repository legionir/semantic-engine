# Independent Verification Report — Phase 0–4 Gate Closures (D-0026 / D-0027)

**Date:** 2026-09-22 (second pass, post-merge)
**Verifier:** agent, fresh sandbox, re-execution from the committed tree (not from prior logs)
**Verified host commit:** `a00575c94ee067f56aff606f32eebce02729a4df` (main tip; merge of PR #17)
**Tree equality check:** `git diff --stat c83ffae64e84d575d37da549c37a2a78e79422c6 a00575c…` → **empty** (main tip tree is byte-identical to PR #17 head)
**Environment:** Node v22.22.3, npm 10.9.8; deps installed from lockfile (`npm ci`, 489 packages)

خلاصهٔ فارسی: این گزارش، راستی‌آزمایی **مستقل و بازاجراشده**ٔ ادعاهای فاز ۳ و ۴ روی درخت commitشدهٔ main است.
هر دو دروازه از صفر بازتولید شدند (فاز ۳: P=R=1.000؛ فاز ۴: recall@2000=1.000)، مصنوعات فریز هش‌تأیید شدند،
و فایل‌های نتیجه با فایل‌های commitشده **جزء `generatedAt` بایت‌برابر** بودند. دو یافتهٔ فرایندی مهم ثبت شد:
(۱) PRهای #15/#16 **بدون هیچ check CI** ادغام شده بودند؛ (۲) CI شاخهٔ main فقط در جاب `structured-ai` قرمز است
(از ۵ روز پیش، بی‌ارتباط با فازها) و جاب‌های `semantic-engine` روی Node 20/22 سبزند.

---

## 1. Method

Everything below was re-executed in this sandbox against the committed tree. No prior log was trusted as
evidence; prior logs were used only as the claims under test. Raw logs are attached under
`docs/validation/evidence-a00575c/`.

| # | Command | Purpose |
|---|---|---|
| 1 | `npm ci` then `npm run build` | environment + build reproducibility |
| 2 | `node docs/validation/spike-s/regate.js` | Phase 3 gate (fixture-1, freeze-hash verified) |
| 3 | `node docs/validation/spike-s/regate.js --fixture2` | Phase 3 generalization (unseen fixture) |
| 4 | `node docs/validation/spike-s/phase4-regate.js` | Phase 4 gate (recall@budget) |
| 5 | `npm test` | full suite (with `pretest` fixture generation) |
| 6 | `npm run lint` | static checks |
| 7 | `sha256sum gold.json cue-lexicon.json fixture/index.json` | independent freeze-hash check |
| 8 | `npx jest …GraphSnapshotStore.test.ts …Phase4Controlled.test.ts …Phase4ControlledTools.test.ts` | gate unit tests |
| 9 | GitHub API: `commits/<sha>/check-runs`, `actions/runs?head_sha=…` | CI coverage at merge time |
| 10 | `npm i node-linux-x64@18.20.8` (nodejs.org is blocked here; the npm mirror is not) | obtain a real Node 18 to replay the red CI leg |
| 11 | `sh -c "$(node -e 'print package.json scripts.test')"` under Node 18, with and without `semantic-engine/dist`, with and without the CI-mode equivalents | reproduce the CI failure and isolate its trigger |
| 12 | `NODE_OPTIONS=--require <instrument.js> node test/projects/project-api.test.js` | identify the offending map entries without editing the repo |

## 2. Frozen-artifact integrity (independent check)

The hashes below were computed here and match the `FROZEN_HASHES` constants compiled into the harnesses
(`regate.js`, `phase4-regate.js`); both harnesses refuse to run on mismatch, and both reported
`freezeVerified: true`.

| Artifact | sha256 | Match |
|---|---|---|
| `gold.json` | `636316016d26cca052ac34090316e72213899a0053777b91d059bc2a4f17cebc` | ✅ |
| `cue-lexicon.json` | `128577b229dceecd84bf9c588c7ef706eb8733543a3496cd4515a2b6b253c981` | ✅ |
| `fixture/index.json` | `27ac808e95ff69b323eb3a2c0e44c0013425460e5f3d14f16f588c11da4ea9df` | ✅ |

## 3. Phase 3 gate — reproduced from scratch

| Claim (GATES.md / D-0026) | Re-executed result | Verdict |
|---|---|---|
| Exact-class precision ≥ 0.95 | macro P = **1.000**, `exact_class_precision_1 = true`, wrong-exact 0/0 | ✅ reproduced |
| Recall ≥ B1 and > B0 | macro R = **1.000**; B1 = 0.603/**0.896**, B0 = 0.582/**0.787** (`b0b1Repro = true`) | ✅ reproduced |
| Retrieval layer necessary | blind (cues off) P = 0.975 / R = **0.875** < B1 0.896 | ✅ reproduced |
| 8-point ablation matrix | all eight rows reproduced identically (worst: −HARD_SURFACE R 0.9625) | ✅ reproduced |
| Semantic incremental == full | `INCR equal=true`, `deterministic=true` | ✅ reproduced |
| Persisted store leg (G-3.1) | `STORE graphEqual=true handleResolves=true taskParity=true` | ✅ reproduced |
| Unresolved handling / calibration | unresolved 2/2, hard 1/1, ambiguous 1/1, deps 13/13, unclassified 0/0, `touched*Pass=true` | ✅ reproduced |
| Generalization (unseen fixture-2) | soft gate PASS; B0 R 0.884 / B1 R 0.846 reproduced; INCR + STORE legs true | ✅ reproduced |
| Gate unit tests | `GraphSnapshotStore` + `Phase4Controlled` + `Phase4ControlledTools` → **3 suites / 19 tests pass** | ✅ |

## 4. Phase 4 gate — reproduced from scratch

| Claim (GATES.md / D-0027) | Re-executed result | Verdict |
|---|---|---|
| recall@2000 ≥ B1 and > B0 | goal-aware macro recall@2000 = **1.000** (B1 0.896, B0 0.787) | ✅ reproduced |
| No budget overrun | budget-adherent **20/20** tasks | ✅ reproduced |
| Determinism | `deterministic=true` (byte-equal builds) | ✅ reproduced |
| Name-only ablation is below baseline | name-only recall = **0.500** < B0 0.787 | ✅ reproduced |

**Reproducibility note (strong evidence, not a defect):** re-running all three harnesses rewrote
`results-regate.json`, `results-regate-fixture2.json`, `results-phase4-regate.json` with **only
`generatedAt` changed** (`git diff` = 1 line per file). All measured values were byte-identical to the
committed results. The working tree was then restored to the committed versions
(sha256 `c74f940a…`, `8ec10860…`, `9fa1eff5…`).

## 5. Full suite, build, lint

| Check | Result |
|---|---|
| `npm run build` (tsc) | exit 0 ✅ |
| `npm run lint` (eslint) | exit 0 — 0 errors, 4 pre-existing warnings in `src/cli/commands/watch-command.ts` ✅ |
| `npm test` | **241 suites: 240 pass, 1 fail; 3178 tests: 3177 pass, 1 fail** ⚠️ |

The single failing test is `src/export/SQLiteExporter.phase24.test.ts` →
*“the sqlite3 fallback runs the whole exporter and produces the same rows”*. It exercises the
**optional native dependency `sqlite3`**, which `npm ci` does not provide here (no prebuilt for this
sandbox; `node-gyp` source build fails). The built-in `node:sqlite` path is present and its tests pass.
CI's `semantic-engine` job — where `sqlite3` is installed — is **green on Node 20 and Node 22** for this
same commit. Conclusion: **environment-bound, not a code regression**.

**Auditor caveat (finding F-4):** running bare `npx jest` (without the `pretest` fixture generation)
produced 9 failed suites / 52 failed tests. The documented entry points (`npm test`, `npm run test:gate`)
run `scripts/gen-fixture.js` first. Any future audit must use the npm scripts, not raw jest.

## 6. Findings

### F-1 (process) — PR #15 and PR #16 were merged with **zero CI checks**
Verified via API, not inference:

| PR | head sha | `check-runs` | workflow runs (`head_sha`) | `gh pr checks` |
|---|---|---|---|---|
| #15 | `af7a2a8` | — | `total_count = 0` | (merged earlier) |
| #16 | `92441744` | `[]` | `total_count = 0` | “no checks reported” |

Only one `pull_request` workflow run exists in the repository's entire history (PR #17,
branch `docs/audit-file-status`). So the phase 3/4 closure merges carried **no PR-time CI evidence**;
GitHub's “CLEAN / mergeable” state was not a check result. ✅ *Mitigation already in place:* the
post-merge push run for `a00575c` (run `35777210257`) shows **semantic-engine Node 20 ✅ and Node 22 ✅**,
i.e. the merged phase code *is* CI-verified — just after the merge rather than before it.
**Constraint found while preparing the recommendation (F-1b):** the repository is private on the GitHub
Free plan, so **branch protection / rulesets are not available** (`GET /branches/main/protection` → 403;
`GET /rulesets` → *“Upgrade to GitHub Pro or make this repository public”*). A required-check rule cannot
enforce anything here yet. The exact reason the `pull_request` workflow never fired for PRs #15/#16 is not
observable from this token's API surface (bot-actor/permission hypotheses remain untested — only PR #17,
whose head branch was pushed outside the agent flow, produced a run).
**Practical mitigations available today (no plan change needed):**
1. before merging any gate PR run `gh pr checks <n>` — and treat *“no checks reported”* as **not verified**;
2. run the local equivalent of CI (`npm ci && npm run build && npm run lint && npm run test:gate && npm test`)
   on the merge candidate and record the log in the PR description;
3. consider making the repository public (or upgrading the plan) if enforced required checks are wanted.

**Live counter-example to any “arena branches don't get CI” generalisation:** this audit's own PR (#18,
same `arena/…` branch pattern) **did** trigger the workflow — `pull_request` run `35779358265` with all
four jobs scheduled. So the missing checks on PR #15/#16 are a case-specific anomaly, not a systematic
exemption, and the method of checking (`gh pr checks <n>` on the actual PR) is demonstrably reliable.

### F-2 (CI, unrelated to phases) — main's CI badge is red because of the `structured-ai` job
Run `35777210257` (commit `a00575c`): `structured-ai (Node 18)` ❌ and `structured-ai (Node 20)` ❌, while
both `semantic-engine` jobs passed. Evidence that this is pre-existing and unrelated to Phase 0–4 work:

- `structured-ai/` tree is **identical** between PR #17 head and main tip (`git diff` empty);
- `structured-ai` has **zero third-party dependencies** (`dependencies: {}`);
- the oldest workflow run in the repo (5 days old, `35266308108`) already had `structured-ai (Node 18)` ❌;
- running the whole `structured-ai` chain locally on Node 22 **passes** (all groups, exit 0);
- Node 20 flips between ✅ and ❌ on identical trees ⇒ **flaky**; Node 18 failed in every observed run.

**F-2a — the deterministic Node 18 failure: root-caused and fixed in this PR.** CI logs are unreadable
from this sandbox, so Node 18 was obtained another way (npm package `node-linux-x64@18.20.8`) and the
job's exact commands were replayed. Result: the failure reproduces **deterministically in 17 s**, matching
CI's 16-second step time, and is a *teardown* crash:

```
TypeError: client.close is not a function
    at McpManager.shutdown (agent/mcp/McpManager.js:705)
    ... <- ToolRuntime.shutdown <- ServerImplementation.close <- WebServer.close
    ... <- main (test/projects/project-api.test.js:521)
```

Mechanism (instrumented, both runtimes): `test/projects/project-api.test.js` injects *test doubles*
(`manager.clients.set("alpha", { config })`, same for `"glob"`) that have no `close()`, and
`McpManager.shutdown()` assumed every map entry is an `McpClient`. **Node 22 reaches the same bad entries
and swallows the rejected promise; Node 18 reports it as an unhandled rejection and exits 1** — hence a
deterministic red job on one runtime only. Fix applied (one function, defensive, no behaviour change for
real clients): only entries exposing `close` are closed.

| Verification after the fix | Result |
|---|---|
| `node test/projects/project-api.test.js` on Node 18 | 17/17 ✅ (was: crash) |
| full `structured-ai` chain on Node 22 | exit 0, all groups ✅ |
| `node --check agent/mcp/McpManager.js` | ✅ |
| **CI re-run on the real runner** (run `35782745484`, commit `7b56cc6`) | `structured-ai (Node 18)` ✅ **4m3s** — was ❌ (16–33 s) on every previous run; `structured-ai (Node 20)` ✅ 1m22s |

That CI result is the decisive check: the previously deterministic red leg now runs the *whole* chain on
the runner. The two `semantic-engine` jobs of that run were still executing when this sandbox lost its
GitHub credentials, so their conclusion is not recorded here (the same jobs were green on both Node 20
and Node 22 for the parent commit).

**F-2b — the intermittent failure: reproduced, still open.** `test/web/web.test.js` (position 49/52 of
the chain) is flaky: 1 of 6 consecutive direct runs failed with **10/28 passed**, while neighbouring runs
passed 28/28 — and the same file's runtime swings between ~3.4 s and ~70 s per run, which points at a
wait/timeout path rather than a logic error. The same file also produced the "27/28 — *a git report
message was recorded*" failure seen while replaying the chain on Node 18 after the fix (log attached),
so the signature is not Node-18-specific. Root cause not identified in this pass; **not modified**
(no reliable reproduction). Recommended follow-up: instrument that wait/retry path with timing output and
run the file in a loop (the local recipe is in the evidence log).

**Local follow-up, 2026-09-23:** the missing git-report assertion now has a deterministic
real-callback-delay reproduction and a test-only synchronization fix. See
[f2b-follow-up-2026-09-23.md](f2b-follow-up-2026-09-23.md) for before/after logs and limits.
The broader timeout cascade remains open; this follow-up is not CI-confirmed.

**F-2c — `structured-ai (Node 18)` also runs the engine, which declares `engines: node >= 20`.** When
`semantic-engine/dist` happens to exist (not in CI, since only the `semantic-engine` jobs build), the
gateway test spawns the engine under Node 18 and gets
`ReferenceError: crypto is not defined` (the Web Crypto global is Node ≥ 19). In CI this test **skips**,
so it does not affect the badge; the matrix inconsistency remains and is worth deciding explicitly:
either drop Node 18 from the `structured-ai` matrix or skip the engine-backed test on < 20.

### F-3 (documentation) — suite/test counts refer to different tree states
| Tree | `*.test.ts` under `src/` | Documented |
|---|---|---|
| phase-3 commit `7fabf5e` | 230 | — |
| phase-4 commit `92441744` | 238 | “238 suites / 3146 tests” (commit message) ✅ consistent |
| main tip `a00575c` | 241 | GATES.md says “238 suites / 3144–3146” |

The three additional suites (added through the `docs/audit-file-status` branch, i.e. PR #17) are
`src/core/contracts/sharedContracts.test.ts`, `src/gateway/GatewayHydration.test.ts`,
`src/server/configRoutes.test.ts` (241 − 238 = 3 suites, 3178 − 3146 = 32 tests). None touches the gate
paths, and the additional code passes in the full-suite run above. **Recommendation:** optional footnote
in GATES.md stating the counts are “as measured at the gate commit”.

### F-4 — see §5 (raw-jest caveat; already mitigated by npm scripts).

### F-5 (editorial) — GATES.md Phase 4 row typo
The row reads “vs B1 0.896 / B0 0.896→0.787”; B0 is **0.787** (0.896 is B1). Cosmetic only; the measured
values and thresholds are correct. Flagged rather than silently edited, because GATES.md is a gate record.

### F-6 (epistemic) — honesty clause of this audit
This verification is **still agent-executed** in the same machine lineage as the work it verifies; it is
not third-party validation. Its value rests on: (a) re-execution from the committed tree, not log reading;
(b) freeze-hash verification inside the harnesses; (c) byte-equal reproducibility of all result files;
(d) raw logs committed alongside. Any owner review may reopen the gate statuses (D-0026 clause) — this
audit found **no contradicting evidence** to the Phase 3/Phase 4 closures.

## 7. Verdict

| Statement under test | Result |
|---|---|
| Phase 3 gate claims (P, R, B0/B1, ablations, incremental, store, calibration) | ✅ **reproduced exactly** |
| Phase 4 gate claims (recall@2000, budget adherence, determinism, ablation) | ✅ **reproduced exactly** |
| Frozen fixtures untouched | ✅ hashes match |
| Build + lint | ✅ clean (warnings only) |
| Full suite | ⚠️ 3177/3178 locally; single failure is the optional native `sqlite3` env-bound test (CI green on Node 20/22) |
| CI evidence at gate-merge time | ❌ absent (F-1) — mitigated by post-merge green `semantic-engine` jobs |
| CI overall on main | ❌ red — `structured-ai` job only: Node 18 leg **root-caused and fixed here** (F-2a); Node 20 leg is a pre-existing flake in `test/web/web.test.js` (F-2b, open) |

**No gate metric failed re-verification.** Thresholds were not touched by this audit; no gate file was
modified except by the owner's own merges.

## 8. Evidence index (all committed in this PR)

| File | Proves |
|---|---|
| `evidence-a00575c/full-suite.log` | `npm test` = 241 suites / 3178 tests, 1 env-bound failure |
| `evidence-a00575c/build.log`, `evidence-a00575c/lint.log` | build clean; lint 0 errors |
| `evidence-a00575c/phase3-regate.log` | Phase 3 gate re-run (fixture-1) |
| `evidence-a00575c/phase3-regate-fixture2.log` | Phase 3 generalisation re-run (unseen) |
| `evidence-a00575c/phase4-regate.log` | Phase 4 gate re-run |
| `evidence-a00575c/gate-unit-tests.log` | 3 gate suites / 19 tests pass |
| `evidence-a00575c/structured-ai-node18-BEFORE-fix.log` | deterministic Node 18 teardown crash (17 s, matches CI's 16 s) |
| `evidence-a00575c/structured-ai-node18-ci-mode-AFTER-fix.log` | after the fix: chain reaches position 49/52 (`web.test.js`), where the *flake* shows its signature |
| `evidence-a00575c/structured-ai-node22-chain-AFTER-fix.log` | after the fix: full `structured-ai` chain green on Node 22 |

**Note on scope:** the only non-docs change in this PR is the one-function defensive guard in
`structured-ai/agent/mcp/McpManager.js` (F-2a) — a pre-existing CI crash, verified before/after, with no
behaviour change for real `McpClient` instances. No gate file, threshold, or phase artifact was touched;
the other unguarded `client.close()` call sites in the same file were deliberately left alone to keep the
change minimal and verifiable, and are listed here as latent risk for the owner to schedule.
