// F-2b Exp8: targeted NEW-SESSION-vs-finalization overlap test (standalone, not part of npm test).
// Proves whether POST /api/sessions accepted in the done-but-git-pending window
// lets the old task's git:report pollute the new empty session.
// Run with git delay to widen the window deterministically:
//   F2B_GIT_DELAY_MS=2000 NODE_OPTIONS="--require=/tmp/f2b-v2.cjs" node /tmp/f2b-overlap-session.cjs
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const http = require("http");
const path = require("path");

const REPO_ROOT = "/home/user/semantic-engine-structured-ai/structured-ai";
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "agent-overlap-session-"));
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
  const log = (m) => console.log(`[OverlapSession +${Date.now() - t0}ms] ${m}`);

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

  const stub = await startModelStub(() => finalAction("session answer"));
  process.env.AGENT_BASE_URL = `http://127.0.0.1:${stub.port}/v1`;

  // 1. Task in first session.
  const accepted = await request("POST", "/api/tasks", { task: "first session turn" });
  log(`POST /api/tasks -> ${accepted.status}`);
  assert.equal(accepted.status, 202);
  const oldSession = (await request("GET", "/api/state")).body.session.id;
  log(`old session=${oldSession}`);

  // 2. Wait ONLY for done (not git-report).
  const doneSnap = await waitFor(async () => {
    const cur = await request("GET", "/api/state");
    return cur.body.status === "done" ? cur : null;
  });
  const doneAt = Date.now() - t0;
  log(`done at +${doneAt}ms; gitReport present? ${doneSnap.body.messages.some((m) => m.kind === "git-report")}`);

  // 3. Immediately create new session (guards only check running; done should allow).
  const created = await request("POST", "/api/sessions", {});
  log(`POST /api/sessions -> ${created.status} (expected 201 if overlap allowed)`);
  assert.equal(created.status, 201);
  const newSession = created.body.session.id;
  log(`new session=${newSession} (changed? ${newSession !== oldSession})`);
  assert.notEqual(newSession, oldSession);

  // 4. Snapshot immediately: new session must be empty.
  const afterCreate = await request("GET", "/api/state");
  log(
    `after create: session=${afterCreate.body.session.id} status=${afterCreate.body.status} messages=${afterCreate.body.messages.length} events=${afterCreate.body.events.length}`
  );
  assert.equal(afterCreate.body.session.id, newSession);
  assert.deepEqual(afterCreate.body.messages, []);

  // 5. Wait for delayed git to release.
  const gitDelay = parseInt(process.env.F2B_GIT_DELAY_MS || "0", 10);
  await new Promise((r) => setTimeout(r, gitDelay + 1500));

  // 6. Does old git-report pollute the NEW session?
  const afterGit = await request("GET", "/api/state");
  const gitMsgs = afterGit.body.messages.filter((m) => m.kind === "git-report");
  const gitEvents = afterGit.body.events.filter((e) => e.type === "git:report");
  log(
    `after git window: session=${afterGit.body.session.id} messages=${afterGit.body.messages.length} gitMsgs=${gitMsgs.length} events=${afterGit.body.events.length} gitEvents=${gitEvents.length}`
  );
  if (gitMsgs.length > 0) log(`POLLUTION: git-report in new session: "${gitMsgs[0].content}"`);
  const polluted = gitMsgs.length > 0 || gitEvents.length > 0;
  log(polluted ? "RESULT: OVERLAP HARMFUL (new session polluted by old finally)" : "RESULT: no pollution observed");

  await stub.close();
  await consoleServer.close();
  require(path.join(REPO_ROOT, "agent", "tools")).shutdown();
  fs.rmSync(WORKSPACE, { recursive: true, force: true });

  console.log(`OVERLAP_SESSION_VERDICT polluted=${polluted} doneAtMs=${doneAt} gitDelayMs=${gitDelay}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
