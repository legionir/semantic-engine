// F-2b Exp6: targeted clear-vs-finalization overlap test (standalone, not part of npm test).
// Proves whether POST /api/clear accepted in the done-but-git-pending window
// lets the old task's git:report pollute the new empty session.
// Run with git delay to widen the window deterministically:
//   F2B_GIT_DELAY_MS=2000 NODE_OPTIONS="--require=/tmp/f2b-v2.cjs" node /tmp/f2b-overlap.cjs
// Expected if RV holds (overlap harmful): after clear, new session gains a git-report
// message/event from the old task once the delayed git callback releases.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const http = require("http");
const path = require("path");

const REPO_ROOT = "/home/user/semantic-engine-structured-ai/structured-ai";
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "agent-overlap-"));
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
  const log = (m) => console.log(`[Overlap +${Date.now() - t0}ms] ${m}`);

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

  const stub = await startModelStub(() => finalAction("overlap answer"));
  process.env.AGENT_BASE_URL = `http://127.0.0.1:${stub.port}/v1`;

  // 1. Start task.
  const accepted = await request("POST", "/api/tasks", { task: "overlap probe" });
  log(`POST /api/tasks -> ${accepted.status}`);
  assert.equal(accepted.status, 202);

  // 2. Wait ONLY for done (like second-task test), not git-report.
  const doneSnap = await waitFor(async () => {
    const cur = await request("GET", "/api/state");
    return cur.body.status === "done" ? cur : null;
  });
  const doneAt = Date.now() - t0;
  const gitPresentAtDone = doneSnap.body.messages.some((m) => m.kind === "git-report");
  log(`status=done at +${doneAt}ms; gitReport present? ${gitPresentAtDone}`);

  // 3. Immediately clear (guards only check running; done should allow).
  const cleared = await request("POST", "/api/clear", {});
  log(`POST /api/clear -> ${cleared.status} (expected 200 if overlap allowed)`);
  assert.equal(cleared.status, 200);

  // 4. Snapshot immediately after clear: new session must be empty.
  const afterClear = await request("GET", "/api/state");
  log(
    `after clear: status=${afterClear.body.status} messages=${afterClear.body.messages.length} events=${afterClear.body.events.length}`
  );
  assert.equal(afterClear.body.status, "idle");
  assert.deepEqual(afterClear.body.messages, []);

  // 5. Wait for delayed git to release (2000ms delay + subprocess + buffer).
  const gitDelay = parseInt(process.env.F2B_GIT_DELAY_MS || "0", 10);
  await new Promise((r) => setTimeout(r, gitDelay + 1500));

  // 6. Snapshot after git window: does old git-report pollute new session?
  const afterGit = await request("GET", "/api/state");
  const gitMsgs = afterGit.body.messages.filter((m) => m.kind === "git-report");
  const gitEvents = afterGit.body.events.filter((e) => e.type === "git:report");
  log(
    `after git window: messages=${afterGit.body.messages.length} gitMsgs=${gitMsgs.length} events=${afterGit.body.events.length} gitEvents=${gitEvents.length}`
  );
  if (gitMsgs.length > 0) {
    log(`POLLUTION: git-report message content="${gitMsgs[0].content}" branch=${gitMsgs[0].branch}`);
  }
  if (gitEvents.length > 0) {
    log(`POLLUTION: git:report event text="${gitEvents[0].text}"`);
  }

  const polluted = gitMsgs.length > 0 || gitEvents.length > 0;
  log(polluted ? "RESULT: OVERLAP HARMFUL (new session polluted by old finally)" : "RESULT: no pollution observed");

  await stub.close();
  await consoleServer.close();
  require(path.join(REPO_ROOT, "agent", "tools")).shutdown();
  fs.rmSync(WORKSPACE, { recursive: true, force: true });

  // Exit 0 in both cases; this is evidence gathering, not pass/fail gate.
  // Print machine-readable verdict for the report.
  console.log(`OVERLAP_VERDICT polluted=${polluted} doneAtMs=${doneAt} gitDelayMs=${gitDelay}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
