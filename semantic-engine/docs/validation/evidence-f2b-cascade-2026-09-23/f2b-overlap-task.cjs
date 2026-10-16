// F-2b Exp7: targeted NEW-TASK-vs-finalization overlap test (standalone, not part of npm test).
// Proves whether POST /api/tasks accepted in the done-but-git-pending window
// causes the old task's git:report to be misattributed (turn_id) and misordered.
// Run with git delay to widen the window deterministically:
//   F2B_GIT_DELAY_MS=2000 NODE_OPTIONS="--require=/tmp/f2b-v2.cjs" node /tmp/f2b-overlap-task.cjs
// Expected if RV holds: first git:report carries turn_id of the SECOND task
// (state.currentTurnId overwritten) and lands after second turn's messages.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const http = require("http");
const path = require("path");

const REPO_ROOT = "/home/user/semantic-engine-structured-ai/structured-ai";
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "agent-overlap-task-"));
fs.writeFileSync(path.join(WORKSPACE, "app.js"), "const value = 1;\n");

process.env.WORKSPACE_ROOT = WORKSPACE;
process.env.AGENT_APPROVAL = "prompt";
process.env.AGENT_VERBOSE = "0";
process.env.MAX_RUN_MS = "20000";
process.env.MAX_EMPTY_FINAL_NUDGES = "0";

function startModelStub(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: handler(parsed) }] }));
      });
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: server.address().port,
        close: () => new Promise((d) => server.close(d)),
      })
    );
  });
}

const finalAction = (text) => ({
  role: "assistant",
  content: JSON.stringify({
    version: "1.0",
    action: "final",
    tool_calls: null,
    delegations: null,
    response: { type: "text", content: text },
    data: null,
    error: null,
  }),
});

async function main() {
  const t0 = Date.now();
  const log = (m) => console.log(`[OverlapTask +${Date.now() - t0}ms] ${m}`);

  const runtime = require(path.join(REPO_ROOT, "agent", "agent.js"));
  const { createServer } = require(path.join(REPO_ROOT, "web", "server.js"));
  const consoleServer = createServer(runtime, {});
  const address = await consoleServer.listen(0, "127.0.0.1");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  async function request(method, url, body) {
    const r = await fetch(`${baseUrl}${url}`, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        authorization: `Bearer ${consoleServer.token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  }

  async function waitFor(pred, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = await pred();
      if (v) return v;
      if (Date.now() > deadline) throw new Error("timed out waiting for a condition");
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  const stub = await startModelStub(() => finalAction("task answer"));
  process.env.AGENT_BASE_URL = `http://127.0.0.1:${stub.port}/v1`;

  // 1. First task.
  const first = await request("POST", "/api/tasks", { task: "first turn" });
  log(`POST first task -> ${first.status}`);
  assert.equal(first.status, 202);

  // 2. Wait ONLY for done (not git-report), like second-task test.
  const doneSnap = await waitFor(async () => {
    const cur = await request("GET", "/api/state");
    return cur.body.status === "done" ? cur : null;
  });
  const doneAt = Date.now() - t0;
  const gitAtDone = doneSnap.body.messages.some((m) => m.kind === "git-report");
  log(`first done at +${doneAt}ms; gitReport present? ${gitAtDone}`);
  const firstUserTurn = doneSnap.body.messages.find((m) => m.role === "user")?.turn_id || null;
  log(`first user turn_id=${firstUserTurn}`);

  // 3. Immediately start second task (guards only check running; done should allow).
  const second = await request("POST", "/api/tasks", { task: "second turn" });
  log(`POST second task -> ${second.status} (expected 202 if overlap allowed)`);
  assert.equal(second.status, 202);

  // 4. Wait for second done (poll status; second git also delayed, so wait for done only).
  // Note: status goes running (second) then done. Wait for done AND two user messages.
  const bothDone = await waitFor(async () => {
    const cur = await request("GET", "/api/state");
    const users = cur.body.messages.filter((m) => m.role === "user").length;
    return cur.body.status === "done" && users === 2 ? cur : null;
  }, 15000);
  const secondUserTurn =
    bothDone.body.messages.filter((m) => m.role === "user")[1]?.turn_id || null;
  log(`second done; second user turn_id=${secondUserTurn}`);

  // 5. Wait for both delayed gits to release.
  const gitDelay = parseInt(process.env.F2B_GIT_DELAY_MS || "0", 10);
  await new Promise((r) => setTimeout(r, gitDelay + 1500));

  // 6. Inspect final session: turn_ids and ordering.
  const fin = await request("GET", "/api/state");
  const msgs = fin.body.messages;
  const gitEvents = fin.body.events.filter((e) => e.type === "git:report");
  log(`final messages=${msgs.length}: ${msgs.map((m) => `${m.kind || m.role}${m.turn_id ? `@${m.turn_id.slice(-6)}` : ""}`).join(", ")}`);
  log(`final git:report events=${gitEvents.length}: turn_ids=[${gitEvents.map((e) => e.turn_id).join(", ")}]`);

  const firstGitTurn = gitEvents[0]?.turn_id || null;
  const mismatch = firstGitTurn !== null && firstUserTurn !== null && firstGitTurn !== firstUserTurn;
  const matchesSecond = firstGitTurn !== null && firstGitTurn === secondUserTurn;
  // Ordering: index of first git-report message vs second user message.
  const idxGit1 = msgs.findIndex((m) => m.kind === "git-report");
  const userIdx = msgs.map((m, i) => (m.role === "user" ? i : -1)).filter((i) => i >= 0);
  const misordered = idxGit1 >= 0 && userIdx.length === 2 && idxGit1 > userIdx[1];
  log(`first git turn_id=${firstGitTurn} vs first user=${firstUserTurn} second user=${secondUserTurn}`);
  log(mismatch ? `MISMATCH: first git attributed to ${matchesSecond ? "SECOND" : "unknown"} turn` : "turn_id OK");
  log(misordered ? `MISORDERED: first git-report at msg idx ${idxGit1} after second user at idx ${userIdx[1]}` : "ordering OK");

  const harmful = mismatch || misordered;
  log(harmful ? "RESULT: OVERLAP HARMFUL (misattribution/misordering)" : "RESULT: no harm observed");

  await stub.close();
  await consoleServer.close();
  require(path.join(REPO_ROOT, "agent", "tools")).shutdown();
  fs.rmSync(WORKSPACE, { recursive: true, force: true });

  console.log(
    `OVERLAP_TASK_VERDICT harmful=${harmful} mismatch=${mismatch} matchesSecond=${matchesSecond} misordered=${misordered} doneAtMs=${doneAt} gitDelayMs=${gitDelay}`
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
