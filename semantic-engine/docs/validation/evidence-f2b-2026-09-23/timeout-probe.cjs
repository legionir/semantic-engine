// Test-only preload: counts console API traffic and timestamps each web test.
// Production modules are not replaced. Not part of npm test.
const start = Date.now();
const counts = {
  api: 0,
  state: 0,
  events: 0,
  tasks: 0,
  clear: 0,
  sessions: 0,
  status429: 0,
  other: Object.create(null)
};
const tests = [];
let mark = {
  at: start,
  api: 0,
  state: 0,
  status429: 0
};

const trace = message =>
  process.stderr.write(`[F-2b-timeout +${Date.now() - start}ms] ${message}\n`);

const originalLog = console.log;
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
      `${entry.result} ${entry.name} ${entry.ms}ms api=+${entry.api} state=+${entry.state} 429=+${entry.status429} totalApi=${counts.api} total429=${counts.status429}`
    );
  }
  return originalLog.apply(this, args);
};

const originalFetch = global.fetch;
global.fetch = async function (...args) {
  const url = String(args[0] ?? "");
  const path = url.replace(/^https?:\/\/[^/]+/, "");
  if (path.startsWith("/api/")) {
    counts.api++;
    if (path.startsWith("/api/state")) counts.state++;
    else if (path.startsWith("/api/events")) counts.events++;
    else if (path.startsWith("/api/tasks")) counts.tasks++;
    else if (path.startsWith("/api/clear")) counts.clear++;
    else if (path.startsWith("/api/sessions")) counts.sessions++;
    else {
      const key = path.split("?")[0];
      counts.other[key] = (counts.other[key] || 0) + 1;
    }
  }
  const response = await originalFetch.apply(this, args);
  if (response.status === 429) {
    counts.status429++;
    trace(`429 ${path} total429=${counts.status429} totalApi=${counts.api}`);
  }
  return response;
};

process.on("exit", () => {
  trace(
    `summary api=${counts.api} state=${counts.state} events=${counts.events} ` +
      `tasks=${counts.tasks} clear=${counts.clear} sessions=${counts.sessions} ` +
      `429=${counts.status429} other=${JSON.stringify(counts.other)} tests=${tests.length}`
  );
});
