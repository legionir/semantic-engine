# VS Code panel — archived UI defects

The archived dashboard `docs/panel-archive.html` (removed in Phase 11, MIG-56)
was pulled out of `src/ui/SemanticEnginePanel.ts` and kept only as a reference;
it was never loaded on any execution path. Its header recorded two defects that
**any future dashboard must fix**, so those notes are preserved here.

## SE-UI-01 — command id mismatch

The panel's buttons invoked `aiCoder.semanticEngineQuickScan` and
`aiCoder.semanticEngineReindex`, while the package actually registered
`semanticEngine.scanWorkspace` and `semanticEngine.scanWithSymbols`. Both
primary buttons were therefore wired to non-existent commands and errored.

> Note: those `SE-UI-01`/`SE-UI-02` labels collide with unrelated findings in
> [`src/cli/commands/serve-command.ts`](../../src/cli/commands/serve-command.ts)
> and [`src/server/SecurityPipeline.ts`](../../src/server/SecurityPipeline.ts);
> this document is the surviving record of the *panel* defects.

## SE-UI-02 — unsafe webview scripting and config writes

The panel was created with `enableScripts: true` but **no Content-Security-Policy,
no nonce and no `localResourceRoots`**, and its `setConfig` message handler wrote
an arbitrary key to global settings with no allowlist.

A replacement dashboard must:

- register a `Content-Security-Policy` with a per-request nonce,
- restrict the webview with `localResourceRoots`,
- accept only an allowlisted set of config keys from `setConfig`, and
- call the commands the package really registers (`semanticEngine.scanWorkspace`,
  `semanticEngine.scanWithSymbols`).
