// F-2b v2 probe: targeted cascade instrumentation (test-only preload).
// Observes console API traffic, 4xx responses, git subprocess timing,
// per-test API deltas. Optional controlled experiments via env:
//   F2B_LIMIT_OVERRIDE=N   -> force RateLimiter limit to N (server-side)
//   F2B_MODEL_DELAY_MS=N   -> delay every model stub response by N ms
//   F2B_GIT_DELAY_MS=N     -> delay every git-report callback by N ms
// Production modules are not replaced; only observed/wrapped in-process.
// Not part of npm test.
const path = require("path");
const cp = require("child_process");

const start = Date.now();
const counts = {
  api: 0,
  state: 0,
  events: 0,
  tasks: 0,
  clear: 0,
  sessions: 0,
  status429: 0,
  status409: 0,
  statusOther4xx: 0,
  modelCalls: 0,
  other: Object.create(null)
};
const tests = [];
let mark = { at: start, api: 0, state: 0, status429: 0 };
const gitStats = { launches: 0, completions: 0, totalMs: 0, maxMs: 0 };
const first429 = { at: null, testIndex: -1, api: -1 };
const limitOverride = process.env.F2B_LIMIT_OVERRIDE
  ? parseInt(process.env.F2B_LIMIT_OVERRIDE, 10)
  : null;
const modelDelayMs = process.env.F2B_MODEL_DELAY_MS
  ? parseInt(process.env.F2B_MODEL_DELAY_MS, 10)
  : 0;
const gitDelayMs = process.env.F2B_GIT_DELAY_MS
  ? parseInt(process.env.F2B_GIT_DELAY_MS, 10)
  : 0;

const trace = (msg) =>
  process.stderr.write(`[F2bV2 +${Date.now() - start}ms] ${msg}\n`);

trace(
  `armed limitOverride=${limitOverride ?? "none"} modelDelay=${modelDelayMs}ms gitDelay=${gitDelayMs}ms`
);

// --- Server-side RateLimiter observation + optional override ---
let limiterPatched = false;
let limiterSeen = { allowCalls: 0, denied: 0, maxCount: 0 };
try {
  // Resolve the same module file ServerImplementation uses.
  // Preload lives in /tmp for experiments, so try multiple candidate roots:
  // 1) cwd (structured-ai/ when running web.test.js)
  // 2) repo-root-relative fallbacks.
  const candidates = [
    path.resolve(process.cwd(), "web/server/Middleware.js"),
    path.resolve(__dirname, "web/server/Middleware.js"),
    "/home/user/semantic-engine-structured-ai/structured-ai/web/server/Middleware.js"
  ];
  let mwPath = null;
  const fs = require("fs");
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        mwPath = c;
        break;
      }
    } catch {}
  }
  if (mwPath) {
    const mw = require(mwPath);
    if (mw && mw.RateLimiter && mw.RateLimiter.prototype) {
      const origAllow = mw.RateLimiter.prototype.allow;
      mw.RateLimiter.prototype.allow = function (req) {
        limiterSeen.allowCalls++;
        // Apply override for controlled exhaustion experiments.
        const savedLimit = this.limit;
        if (Number.isInteger(limitOverride)) this.limit = limitOverride;
        let ok;
        try {
          ok = origAllow.call(this, req);
        } finally {
          this.limit = savedLimit;
        }
        try {
          const key = req.socket?.remoteAddress || "unknown";
          const cur = this.windows.get(key);
          if (cur) {
            if (cur.count > limiterSeen.maxCount)
              limiterSeen.maxCount = cur.count;
            if (!ok) {
              limiterSeen.denied++;
              if (first429.at === null) {
                first429.at = Date.now() - start;
                first429.testIndex = tests.length;
                first429.api = counts.api;
              }
              trace(
                `LIMITER-DENY count=${cur.count} limit=${limitOverride ?? savedLimit} resetIn=${cur.resetAt - Date.now()}ms totalApi=${counts.api} testsDone=${tests.length}`
              );
            }
          }
        } catch {}
        return ok;
      };
      limiterPatched = true;
      trace(`RateLimiter patched via ${mwPath}`);
    } else {
      trace(`WARN: RateLimiter not found in ${mwPath}`);
    }
  } else {
    trace("WARN: Middleware.js not found; server-side limiter logging disabled");
  }
} catch (e) {
  trace(`WARN: limiter patch failed: ${e.message}`);
}

// --- Git subprocess timing (+ optional delay) ---
const origExecFile = cp.execFile;
cp.execFile = function (file, args, ...rest) {
  const isGitReport =
    file === "git" &&
    JSON.stringify(args) === JSON.stringify(["status", "--short", "--branch"]);
  if (!isGitReport) return origExecFile.call(this, file, args, ...rest);
  const launchedAt = Date.now();
  gitStats.launches++;
  trace(`git launch #${gitStats.launches}`);
  const cb = rest.pop();
  rest.push(function (...vals) {
    const dur = Date.now() - launchedAt;
    gitStats.completions++;
    gitStats.totalMs += dur;
    if (dur > gitStats.maxMs) gitStats.maxMs = dur;
    const release = () => {
      trace(`git completion #${gitStats.completions} dur=${dur}ms (+delay ${gitDelayMs}ms)`);
      cb.apply(this, vals);
    };
    if (gitDelayMs > 0) setTimeout(release, gitDelayMs);
    else release();
  });
  return origExecFile.call(this, file, args, ...rest);
};

// --- Per-test boundaries (same console lines as v1) ---
const origLog = console.log;
console.log = function (...args) {
  const line = String(args[0] ?? "");
  const ok = /^  ok   (.+)$/.exec(line);
  const fail = /^  FAIL (.+)$/.exec(line);
  if (ok || fail) {
    const name = (ok || fail)[1];
    const now = Date.now();
    const entry = {
      name,
      result: ok ? "ok" : "FAIL",
      ms: now - mark.at,
      api: counts.api - mark.api,
      state: counts.state - mark.state,
      status429: counts.status429 - mark.status429
    };
    tests.push(entry);
    mark = { at: now, api: counts.api, state: counts.state, status429: counts.status429 };
    trace(
      `${entry.result} #${tests.length} ${entry.name} ${entry.ms}ms api=+${entry.api} state=+${entry.state} 429=+${entry.status429} totalApi=${counts.api} total429=${counts.status429}`
    );
  }
  return origLog.apply(this, args);
};

// --- Fetch wrapper: console API counting + model delay ---
const origFetch = global.fetch;
global.fetch = async function (...args) {
  const url = String(args[0] ?? "");
  // Model stub traffic (runtime -> stub): delay, don't count as console API.
  if (url.includes("/chat/completions")) {
    counts.modelCalls++;
    const resp = await origFetch.apply(this, args);
    if (modelDelayMs > 0)
      await new Promise((r) => setTimeout(r, modelDelayMs));
    return resp;
  }
  const pathOnly = url.replace(/^https?:\/\/[^/]+/, "");
  const isApi = pathOnly.startsWith("/api/");
  if (isApi) {
    counts.api++;
    if (pathOnly.startsWith("/api/state")) counts.state++;
    else if (pathOnly.startsWith("/api/events")) counts.events++;
    else if (pathOnly.startsWith("/api/tasks")) counts.tasks++;
    else if (pathOnly.startsWith("/api/clear")) counts.clear++;
    else if (pathOnly.startsWith("/api/sessions")) counts.sessions++;
    else {
      const k = pathOnly.split("?")[0];
      counts.other[k] = (counts.other[k] || 0) + 1;
    }
  }
  const response = await origFetch.apply(this, args);
  if (isApi) {
    if (response.status === 429) {
      counts.status429++;
      trace(`429 ${pathOnly} total429=${counts.status429} totalApi=${counts.api} testsDone=${tests.length}`);
    } else if (response.status === 409) {
      counts.status409++;
      trace(`409 ${pathOnly} total409=${counts.status409} totalApi=${counts.api} testsDone=${tests.length}`);
    } else if (response.status >= 400) {
      counts.statusOther4xx++;
      // Log 4xx except the intentional 401/400/404 checks to reduce noise?
      // Keep all for completeness but mark path.
      trace(`${response.status} ${pathOnly} totalApi=${counts.api}`);
    }
    // For /api/state polls, log what the predicate sees (status vs error).
    if (pathOnly.startsWith("/api/state") && response.status !== 101) {
      try {
        const body = await response.clone().json();
        if (body && body.error) {
          trace(`state-poll -> ERROR ${response.status} ${body.error}`);
        } else {
          // Only log transitions or errors to avoid spam? Log every 20th? No, log all for accuracy.
          // To keep log readable, log status + pending + gitReport presence.
          const st = body.status;
          const pend = Array.isArray(body.pending_approvals) ? body.pending_approvals.length : "?";
          const git = Array.isArray(body.messages)
            ? body.messages.some((m) => m.kind === "git-report")
            : "?";
          trace(`state-poll -> status=${st} pending=${pend} gitReport=${git}`);
        }
      } catch {}
    }
    // For task/discussion admission, log non-202.
    if (
      (pathOnly.startsWith("/api/tasks") ||
        pathOnly.startsWith("/api/discussion")) &&
      response.status !== 202 &&
      response.status !== 200
    ) {
      trace(`admission ${pathOnly} -> ${response.status}`);
    }
  }
  return response;
};

process.on("exit", () => {
  const wall = Date.now() - start;
  trace(
    `SUMMARY wall=${wall}ms api=${counts.api} state=${counts.state} events=${counts.events} ` +
      `tasks=${counts.tasks} clear=${counts.clear} sessions=${counts.sessions} ` +
      `429=${counts.status429} 409=${counts.status409} other4xx=${counts.statusOther4xx} ` +
      `modelCalls=${counts.modelCalls} tests=${tests.length} ` +
      `limiterPatched=${limiterPatched} limiterCalls=${limiterSeen.allowCalls} limiterDenied=${limiterSeen.denied} limiterMaxCount=${limiterSeen.maxCount} ` +
      `git launches=${gitStats.launches} completions=${gitStats.completions} avgMs=${gitStats.completions ? Math.round(gitStats.totalMs / gitStats.completions) : 0} maxMs=${gitStats.maxMs} ` +
      `first429=${first429.at === null ? "none" : `+${first429.at}ms testIdx=${first429.testIndex} api=${first429.api}`} ` +
      `other=${JSON.stringify(counts.other)}`
  );
});
