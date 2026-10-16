# F-2b follow-up — deterministic git-report wait reproduction

Date: 2026-09-23 (Asia/Tehran). Agent-executed local evidence, not independent review or CI.
Scope: follow-up to the Phase 0–4 verification report; no new phase or threshold change.

## Finding and bounded fix

`structured-ai/web/server/ServerImplementation.js` sets `state.status` to `done` before its
`finally` block awaits `recordGitReport()`. That function awaits the real `git status`
subprocess before publishing the `git:report` event and conversation message. Therefore
`GET /api/state` can legitimately expose the current implementation's intermediate state:
`status=done`, without the report yet present.

The conversation persistence test in `structured-ai/test/web/web.test.js` waited only for
`done`, immediately fetched another snapshot and asserted that a git-report message existed.
A controlled 500ms delay in delivery of the real subprocess callback reproduces exactly
`a git report message was recorded`, without changing the subprocess result or API response.

Change: this test now waits for `done` AND the git-report message AND the git:report event.
The existing 8-second timeout and all message/event/disk/call assertions are retained.
No production lifecycle behavior is changed and no assertion is removed.

This fixes the test's synchronization assumption, not the production meaning of terminal
status. Whether terminal status should be withheld until finalization, and whether clear/new
session/new task operations can overlap finalization, remain **Requires Verification**.
That broader lifecycle decision must not be silently resolved by this test-only change.

## Executed evidence

Runtime: Node v22.22.3. Logs and test-only preload: `evidence-f2b-2026-09-23/`.

| Execution | Result |
|---|---|
| Original test, delayed real git callback | exit 1; 27/28; exact missing-report assertion (`before.log`) |
| Updated test, same delay | exit 0; 28/28 (`after.log`) |
| Updated test, no instrumentation | exit 0; 28/28 (`normal.log`) |
| `npm test` in `structured-ai` | exit 0 (`full-chain.log`); engine-backed gateway tests skipped because `semantic-engine/dist` is absent |

Before: subprocess launched +2007ms; completed +2020ms; snapshots +2038/+2047ms
reported `done` without the report; assertion failed; callback released +2520ms.
After: the instrumented snapshots likewise observe the intermediate state, but the test waits
until the actual report is present. The saved preload also fails on exit if it did not inject
the delay, observe the early-done state, and release the callback, so a missed hook cannot
silently pass the regression check. The original before log predates these coverage guards;
the recorded trace itself proves the same interleaving was exercised.

Reproduce from the repository root:

```sh
cd structured-ai
node test/web/web.test.js
NODE_OPTIONS=--require=../semantic-engine/docs/validation/evidence-f2b-2026-09-23/trace.cjs \
  node test/web/web.test.js
npm test
```

The preload arms after the preceding settings-stream test succeeds and delays only the next
matching git-status callback. It runs the real HTTP suite and real subprocess. It is a
standalone regression command, not automatically included in `npm test`.

## Status and limits

- Missing git-report assertion: deterministically reproduced and test synchronization fixed locally.
- Broader F-2b (the earlier 10/28 timeout cascade): **OPEN**; not proven to have the same cause.
- Node 18/20 and remote CI: not executed for this follow-up. No cross-version claim.
- Engine-backed integration: skipped, **not passed**. F-2c is not closed.
- No new full semantic-engine verification was needed or claimed for this test-only change.
- Session is closed for remote operations. Changes and evidence remain local; a new coding
  session is required for review/push/PR. No GitHub operation was attempted in this follow-up.

## Re-verification, 2026-09-23 (delivery session)

Host: Node v22.22.3, npm 10.9.8. Same commands as above, from `structured-ai/`,
against the extracted local fix. Original `before.log` / `after.log` / `normal.log` /
`full-chain.log` were not overwritten.

| Execution | Command | Result | Skip |
|---|---|---|---|
| Normal web suite | `node test/web/web.test.js` | exit 0; 28/28 (`reverify-normal.log`) | none |
| Instrumented delay | `NODE_OPTIONS=--require=…/trace.cjs node test/web/web.test.js` | exit 0; 28/28 (`reverify-instrumented.log`) | none |
| Full structured-ai chain | `npm test` | exit 0 (`reverify-full-chain.log`) | `skip semantic-engine is not built` → `0/0 passed (skipped)` — **not a pass**; F-2c unchanged |

Instrumented interleaving this session: subprocess launched +1895ms; completed +1906ms;
snapshots from +1925ms through +2401ms reported `state=done; gitReport=false`; callback
released +2407ms; the updated wait then passed. The preload exit-guards did not fire.

Post-merge CI of PR #18 on `dc5208a` (run `35786474578`) is separately recorded as all
four jobs green. That does not close F-2b.

## Remaining F-2b (10/28 timeout cascade) — OPEN

Not reproduced this session. One targeted probe, no retry loop, no timeout increase.

`timeout-probe.cjs` wrapped `fetch` / test `ok`/`FAIL` lines only. One run:
exit 0; 28/28; wall 3239ms; `api=101 state=35 events=10 429=0` (`timeout-probe.log`).
The console limiter is 120 requests / 60s (`RateLimiter` in `web/server/Middleware.js`).
A single `waitFor` that polls `/api/state` every 50ms for the default 8s is ~160 calls
and can exhaust that budget by itself; once 429s start, later `waitFor` predicates never
see `status`/`events` and fail with `timed out waiting for a condition`. That is a
plausible cascade shape for “10/28 then ~70s”, not a demonstrated cause.

Other tests still wait only for `status === "done"` (second-task, approval honour,
denied approval, reopen-and-continue). They do not assert git-report, so they were not
widened here.

## Terminal status vs finalization — Requires Verification

Code, not a production change:

- `startTask` assigns `state.status` to `done` / `failed` / `cancelled` in `try`/`catch`
  **before** `finally` awaits `recordGitReport()` (`git` timeout 8000ms) and then emits
  `run:status`.
- Busy guards on `POST /api/clear`, `POST /api/sessions`, `POST /api/sessions/:id`, and
  `POST /api/tasks` test only `state.status === "running"` (plus discussion-running for
  tasks). The post-`done` / in-`finally` window is therefore not busy.
- In that window a client can clear, open a new session, or start a new task while
  `recordGitReport` / `saveSession` / auto-continue still mutate `state.session`.

`docs/contracts/shared-invariants.md` and `structured-ai/test/contracts/api.contract.test.js`
do not define “`done` means finalization complete” or “`done` implies git-report present”.
SSE consumers waiting for `run:status` observe a later point than `GET /api/state`
consumers waiting for `status === "done"`. Withholding `done` until after git report
would be a lifecycle/contract decision, not a silent bugfix. Left RV; production untouched.
