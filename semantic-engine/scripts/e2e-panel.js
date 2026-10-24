#!/usr/bin/env node
'use strict';

/*
| Panel end-to-end check (real server, real browser)
| ---------------------------------------------------
|   node scripts/e2e-panel.js
|
| Starts `semantic-engine start` on a copy of the test fixture (isolated data dir, free
| ports, model hub pointed at a closed port) and drives open.html / visualizer.html with
| Playwright. Covers: token entry, project + index detection, settings save/reload,
| a failing model download (must report, not hang), indexing from the UI, the visualizer
| loading its graph, and `ui --port` being honoured.
|
| Needs `playwright` (resolved from the package, NODE_PATH or the global install) and a
| Chromium (PLAYWRIGHT_CHROMIUM_EXECUTABLE, or Playwright's own). Without them the script
| prints "skipped" and exits 0; E2E_REQUIRED=1 (CI) turns that into a failure.
*/

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'semantic-engine.js');
const FIXTURE = path.join(ROOT, 'test-fixture');
const TOKEN = 'e2e-token';
const required = process.env.E2E_REQUIRED === '1';

function skip(reason) {
  const message = `e2e-panel: skipped (${reason})`;
  if (required) {
    console.error(message.replace('skipped', 'FAILED, but E2E_REQUIRED=1'));
    process.exit(1);
  }
  console.log(message);
  process.exit(0);
}

function loadPlaywright() {
  const candidates = [() => require('playwright')];
  try {
    const globalRoot = require('child_process').execSync('npm root -g', { encoding: 'utf8' }).trim();
    candidates.push(() => require(path.join(globalRoot, 'playwright')));
  } catch { /* no global npm */ }
  for (const load of candidates) {
    try { return load(); } catch { /* try the next */ }
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(url, ms = 60_000) {
  const until = Date.now() + ms;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > until) throw new Error(`timed out waiting for ${url}`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

function startServer(args, env, log) {
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env, SEMANTIC_ENGINE_LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => log.push(String(chunk)));
  child.stderr.on('data', chunk => log.push(String(chunk)));
  return child;
}

const failures = [];
function check(name, condition, detail = '') {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${condition || !detail ? '' : ` — ${detail}`}`);
  if (!condition) failures.push(name);
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'dist', 'cli', 'main.js'))) skip('dist/ is not built');
  if (!fs.existsSync(FIXTURE)) skip('test-fixture is missing (run npm run fixture)');
  const playwright = loadPlaywright();
  if (!playwright) skip('playwright is not installed');

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'se-e2e-'));
  const project = path.join(work, 'project');
  const dataDir = path.join(work, 'data');
  fs.cpSync(FIXTURE, project, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  const [uiPort, mcpPort, altPort] = [await freePort(), await freePort(), await freePort()];
  const log = [];
  const env = { SEMANTIC_ENGINE_MODEL_HUB_URL: 'http://127.0.0.1:9' };
  const children = [];
  let browser;

  try {
    children.push(startServer([
      'start', '--root', project, '--ui-port', String(uiPort), '--mcp-port', String(mcpPort),
      '--data-dir', dataDir, '--token', TOKEN, '--no-lsp-diagnostics',
    ], env, log));
    await waitFor(`http://127.0.0.1:${uiPort}/health`);

    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
    try {
      browser = await playwright.chromium.launch(executablePath ? { executablePath } : {});
    } catch (error) {
      skip(`no usable Chromium: ${String(error.message).split('\n')[0]}`);
    }
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    const page = await context.newPage();
    const base = `http://127.0.0.1:${uiPort}`;
    const apiErrors = [];
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('response', response => {
      if (response.status() >= 400 && response.url().includes('/api/')) apiErrors.push(`${response.status()} ${response.url()}`);
    });

    // 1. token + project detection
    await page.goto(`${base}/open.html`);
    await page.fill('#tokenInput', TOKEN);
    await page.click('#saveTokenBtn');
    await page.waitForFunction(() => document.querySelector('#statusText')?.textContent === 'connected', null, { timeout: 15_000 });
    apiErrors.length = 0; // the first load happens before the token exists and legitimately gets 401s
    check('panel connects with the token', true);
    await page.waitForFunction(() => {
      const badge = document.querySelector('#projStatusBadge')?.textContent?.trim();
      return badge && badge !== '—' && (document.querySelector('#selectedPathCode')?.textContent ?? '').length > 0;
    }, null, { timeout: 15_000 });
    check('project folder is the served root', (await page.textContent('#selectedPathCode')).trim() === project);
    check('project is reported as indexed', (await page.textContent('#projStatusBadge')).trim() === 'indexed');
    check('models directory lives under the data dir', (await page.textContent('#modelsDirCode')).startsWith(dataDir));

    // 2. settings save + reload
    await page.fill('#maxDepth', '7');
    await page.fill('#extraIgnore', '**/*.snap, vendor/**');
    await page.uncheck('#skipHidden');
    await page.click('#saveDefaultsBtn');
    const configPath = path.join(dataDir, 'config.json');
    const until = Date.now() + 10_000;
    let saved = {};
    while (Date.now() < until) {
      try { saved = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { saved = {}; }
      if (saved.scan?.maxDepth === 7) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    check('settings are written to config.json', saved.scan?.maxDepth === 7 && saved.scan?.skipHiddenDirectories === false,
      JSON.stringify(saved.scan));
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#statusText')?.textContent === 'connected', null, { timeout: 15_000 });
    check('settings survive a reload', (await page.inputValue('#maxDepth')) === '7'
      && (await page.inputValue('#extraIgnore')) === '**/*.snap, vendor/**'
      && !(await page.isChecked('#skipHidden')));

    // 3. a model download that cannot succeed must say so
    const row = page.locator('#localModelList li', { hasText: 'all-MiniLM-L6-v2' });
    await row.locator('button').first().click();
    await page.waitForFunction(() => {
      const li = [...document.querySelectorAll('#localModelList li')].find(e => e.textContent.includes('all-MiniLM-L6-v2'));
      return li && /failed/i.test(li.textContent);
    }, null, { timeout: 30_000 });
    const rowText = (await row.innerText()).replace(/\s+/g, ' ');
    check('failed download is reported with a reason and a retry', /Retry download/.test(rowText) && /cannot reach/.test(rowText), rowText);

    // 4. indexing from the UI
    await page.click('#startIndexBtn');
    await page.waitForFunction(() => /done/i.test(document.querySelector('#statusText')?.textContent ?? ''), null, { timeout: 90_000 });
    check('indexing from the UI completes', true);
    check('project stays indexed after re-indexing', (await page.textContent('#projStatusBadge')).trim() === 'indexed');

    // 5. visualizer
    const viz = await context.newPage();
    const vizErrors = [];
    viz.on('pageerror', error => vizErrors.push(error.message));
    viz.on('response', response => {
      if (response.status() >= 400 && response.url().includes('/api/')) vizErrors.push(`${response.status()} ${response.url()}`);
    });
    await viz.goto(`${base}/visualizer.html?token=${TOKEN}`);
    await viz.waitForFunction(() => /Nodes:\s*[1-9]/.test(document.body.innerText), null, { timeout: 30_000 });
    check('visualizer renders a non-empty graph', true);
    const overlaps = await viz.evaluate(() => {
      const boxes = [...document.querySelectorAll('.graph-node')].map(node => node.getBoundingClientRect());
      let count = 0;
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i];
          const b = boxes[j];
          if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) count++;
        }
      }
      return count;
    });
    check('no two graph nodes overlap', overlaps === 0, `${overlaps} overlapping pairs`);
    check('visualizer loads without API or script errors', vizErrors.length === 0, vizErrors.join('; '));
    check('panel made no failing API calls after connecting', apiErrors.length === 0, apiErrors.join('; '));
    check('panel raised no script errors', pageErrors.length === 0, pageErrors.join('; '));

    // 6. `ui --port` is honoured
    children.push(startServer([
      'ui', '--root', project, '--port', String(altPort), '--data-dir', dataDir, '--token', TOKEN,
    ], env, log));
    let altUp = true;
    try { await waitFor(`http://127.0.0.1:${altPort}/health`, 30_000); } catch { altUp = false; }
    check('ui --port binds the requested port', altUp);
  } catch (error) {
    failures.push(`unexpected: ${error.message}`);
    console.error(error);
    console.error('--- server log ---\n' + log.join('').slice(-4000));
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    for (const child of children) child.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 500));
    fs.rmSync(work, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error(`\ne2e-panel: ${failures.length} failure(s): ${failures.join('; ')}`);
    process.exit(1);
  }
  console.log('\ne2e-panel: all checks passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
