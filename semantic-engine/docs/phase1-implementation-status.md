# Phase 1 — v1 Index و Platform

## دامنه‌ی این تحویل

این تحویل implementation additive فاز ۱ را روی `ProjectIndex` موجود تکمیل می‌کند و source of truth جدیدی ایجاد نمی‌کند:

- `src/core/codeintel/Phase1Platform.ts`
  - adapter status با `ok | degraded | unavailable`
  - parse diagnostics محافظه‌کارانه با `ERROR/MISSING` و `partial`
  - outline ساختاریافته با canonical `SymbolKey` و `signatureHash`
  - canonical ordering و `snapshotId` مبتنی بر `(path, contentHash)`
  - generation ownership با compare-and-swap برای جلوگیری از writer stale
- `src/ai/tools/Phase1ReadTools.ts`
  - `code_outline`
  - `symbol_find`
  - ابزارهای read-only قبلی فاز ۱
- `src/ai/AiToolRegistry.ts`
  - ثبت additive ابزارهای جدید؛ مسیر MCP از همان registry استفاده می‌کند.

## تست‌های فاز ۱

- `src/core/codeintel/Phase1Platform.test.ts`
  - adapter status
  - broken syntax و CRLF
  - ثبات key در تغییر body
  - determinism و snapshot identity
  - conflict در generation ownership
- `src/ai/tools/Phase1ReadTools.test.ts`
  - read/fold/security/stale handle
  - outline و symbol find
  - diagnostics/search/inspect/gains
- `src/ai/mcp/SemanticEngineMcpServer.test.ts`
  - tools/list و tools/call برای سطح MCP

## وضعیت شواهد

| مورد | وضعیت |
|---|---|
| implementation source | IMPLEMENTED |
| focused tests written | TESTS WRITTEN |
| build بعد از این تغییر | NOT VERIFIED در این محیط |
| focused tests بعد از این تغییر | NOT VERIFIED در این محیط؛ اجرای npm به timeout محیط خورد |
| MCP/Gateway runtime | MCP test نوشته شده، اجرای واقعی این revision NOT VERIFIED؛ Gateway NOT VERIFIED |
| full/incremental semantic parity | قرارداد و تست‌های پایه‌ی موجودند؛ producer کامل این فاز نیازمند اجرای محیط repository و evidence مستقل است |
| performance / peak RSS | NOT MEASURED |

این سند completion یا release approval نیست. Gate فاز ۱ فقط پس از اجرای commandهای واقعی، ثبت revision/environment/output/exit code و رفع blockerهای acceptance قابل تعیین است.

## Gate closure 2026-09-21 — 🟢 ACCEPTED

Validation on `c2c7396` (+ gate-closure fixes on this branch): build/lint/full
suite (233/3090)/test:gate green; MCP `tools/list`+`tools/call` executed for
all 10 Phase 1 tools; fold L2 63.14% ≥ 60% on the real 402-line file; unfold
402/402 lines byte-exact; determinism and read-security evidenced; Gateway
suites green. Non-blocking gaps recorded: G-1.2 (no grammar pin/conformance
snapshots), G-1.7 (GenerationOwnership unwired), G-1.14 (cold/warm unmeasured).
Full report: `docs/validation/gate-closure-2026-09-21.md`.
