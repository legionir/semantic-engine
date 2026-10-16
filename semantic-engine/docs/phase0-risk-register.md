# Phase 0 Risk Register — Initial

| ID | Risk | Current status | Mitigation / next evidence |
|---|---|---|---|
| R-01 | Spec/repository divergence or second source of truth | Open | Preserve existing package; complete traceability step 0.9 with source/symbol evidence |
| R-02 | Phase 0 becomes unbounded | Open | Apply five-working-day timebox and prioritize blocking steps 0.1–0.3, 0.5, 0.6, 0.8 |
| R-03 | Runtime claims made without execution | Active blocker | Obtain executable checkout/dependencies; capture commands/output/exit codes |
| R-04 | Full/incremental or stale-artifact discrepancy | Unknown | Run prescribed fixture matrix; classify any discrepancy as blocking |
| R-05 | Range unit mismatch | Unknown | Execute UTF-16/Unicode/EOL/BOM tests and direct source mapping |
| R-06 | Building capability already provided by an existing tool | Unknown | Run adopt-vs-build on shared fixtures; record decision before v1 scope |
| R-07 | Evidence collection cost | Open | One evidence bundle per phase with hashes and timestamps |
| R-08 | Threshold changed after measurement | Controlled | Lock thresholds in `GATES.md`; dated decision required for any change |
