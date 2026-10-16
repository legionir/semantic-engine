// Test-only preload: delays the real git callback for the conversation test.
// No git result, API response, or production module is replaced.
const cp = require('child_process');
const originalExecFile = cp.execFile;
const originalLog = console.log;
let armed = false;
let observing = false;
let injected = false;
let sawEarlyDone = false;
const start = Date.now();
const trace = message => process.stderr.write(`[F-2b +${Date.now() - start}ms] ${message}\n`);
console.log = function (...args) {
  if (String(args[0]).includes('ok   a settings change is streamed to every console')) armed = true;
  return originalLog.apply(this, args);
};
cp.execFile = function (file, args, ...rest) {
  if (armed && file === 'git' && JSON.stringify(args) === JSON.stringify(['status', '--short', '--branch'])) {
    armed = false;
    observing = true;
    injected = true;
    trace('git report subprocess launched');
    const callback = rest.pop();
    rest.push(function (...values) {
      trace('git subprocess completed; holding callback for 500ms');
      setTimeout(() => {
        trace('releasing git report callback');
        callback.apply(this, values);
        observing = false;
      }, 500);
    });
  }
  return originalExecFile.call(this, file, args, ...rest);
};
const originalFetch = global.fetch;
global.fetch = async function (...args) {
  const response = await originalFetch.apply(this, args);
  if (observing && String(args[0]).endsWith('/api/state')) {
    const state = await response.clone().json();
    if (state.status === 'done' && !state.messages.some(m => m.kind === 'git-report')) sawEarlyDone = true;
    trace(`state=${state.status}; gitReport=${state.messages.some(m => m.kind === 'git-report')}`);
  }
  return response;
};

process.on('exit', () => {
  if (!injected || !sawEarlyDone || observing) {
    trace('FAIL: the intended interleaving was not fully exercised');
    process.exitCode = 1;
  }
});
