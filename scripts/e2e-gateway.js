#!/usr/bin/env node
'use strict';

/*
| Gateway console end-to-end check (real gateway, real workers, real browser)
| --------------------------------------------------------------------------
|   node scripts/e2e-gateway.js
|
| Starts `semantic-engine gateway` with one project, then drives /gateway with Playwright:
| the instance table (state, PID, index), health detail, creating a new instance from the form
| with scan / diagnostics / cache options (the options must reach the worker and change what it
| indexes), editing, stop / start, opening the project dashboard, and removing an instance.
|
| Same skip rules as scripts/e2e-panel.js: without Playwright or Chromium it prints "skipped"
| and exits 0; E2E_REQUIRED=1 (CI) makes that a failure.
*/

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'semantic-engine.js');
const FIXTURE = path.join(ROOT, 'test-fixture');
const TOKEN = 'e2e-gateway-token';
const required = process.env.E2E_REQUIRED === '1';

function skip(reason) {
  const message = `e2e-gateway: skipped (${reason})`;
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
    try { return load(); } catch { /* next */ }
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

async function waitFor(url, options = {}, ms = 90_000) {
  const until = Date.now() + ms;
  for (;;) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
    } catch { /* not up yet */ }
    if (Date.now() > until) throw new Error(`timed out waiting for ${url}`);
    await new Promise(resolve => setTimeout(resolve, 300));
  }
}

const failures = [];
function check(name, condition, detail = '') {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${condition || !detail ? '' : ` — ${detail}`}`);
  if (!condition) failures.push(name);
}

function listFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'dist', 'cli', 'main.js'))) skip('dist/ is not built');
  if (!fs.existsSync(FIXTURE)) skip('test-fixture is missing (run npm run fixture)');
  const playwright = loadPlaywright();
  if (!playwright) skip('playwright is not installed');

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'se-e2e-gw-'));
  const dataDir = path.join(work, 'data');
  const projectOne = path.join(work, 'one');
  const projectTwo = path.join(work, 'two');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.cpSync(FIXTURE, projectOne, { recursive: true });
  fs.cpSync(FIXTURE, projectTwo, { recursive: true });
  const markdownBefore = listFiles(projectTwo).filter(file => file.endsWith('.md')).length;

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const log = [];
  const gateway = spawn(process.execPath, [
    BIN, 'gateway', '--port', String(port), '--token', TOKEN, '--data-dir', dataDir,
    '--project', projectOne, '--project-id', 'fix-one', '--name', 'Fixture One',
  ], { cwd: ROOT, env: { ...process.env, SEMANTIC_ENGINE_LOG_LEVEL: 'warn' }, stdio: ['ignore', 'pipe', 'pipe'] });
  gateway.stdout.on('data', chunk => log.push(String(chunk)));
  gateway.stderr.on('data', chunk => log.push(String(chunk)));

  let browser;
  try {
    const auth = { headers: { Authorization: `Bearer ${TOKEN}` } };
    await waitFor(`${base}/api/v1/gateway/health`, auth);

    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
    try {
      browser = await playwright.chromium.launch(executablePath ? { executablePath } : {});
    } catch (error) {
      skip(`no usable Chromium: ${String(error.message).split('\n')[0]}`);
    }
    const context = await browser.newContext({ viewport: { width: 1400, height: 1100 } });
    const page = await context.newPage();
    const failing = [];
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('response', response => {
      if (response.status() >= 400 && response.url().includes('/api/')) failing.push(`${response.status()} ${response.url()}`);
    });
    const row = id => page.locator(`#worker-rows tr[data-project="${id}"]`);
    const rowText = async id => ((await row(id).innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
    const waitRowState = (id, state) => page.waitForFunction(([project, wanted]) => {
      const tr = document.querySelector(`#worker-rows tr[data-project="${project}"]`);
      return tr && tr.querySelector('td[data-key="state"]')?.textContent === wanted;
    }, [id, state], { timeout: 90_000 });

    // 1. the instance table
    await page.goto(`${base}/gateway?token=${TOKEN}`);
    await waitRowState('fix-one', 'ready');
    const first = await rowText('fix-one');
    check('instance row shows the project, its id and its root', first.includes('Fixture One') && first.includes('fix-one') && first.includes(projectOne), first);
    check('instance row shows a PID and a fresh index', /\b\d{3,}\b/.test(first) && first.includes('fresh'), first);
    check('summary cards count the ready instance', (await page.locator('#cards .card[data-key="ready"] .card-value').innerText()) === '1');
    check('every action is reachable (no clipped buttons)', await page.evaluate(() => {
      const td = document.querySelector('#worker-rows tr td.actions');
      return td.scrollWidth <= td.clientWidth + 1;
    }));

    // 2. health detail
    await row('fix-one').locator('button[data-action=health]').click();
    await page.waitForFunction(() => !document.querySelector('#health-panel').hidden);
    const health = (await page.textContent('#health-panel')).replace(/\s+/g, ' ');
    check('health detail shows counters', /files: \d+/.test(health) && /symbols: \d+/.test(health), health.slice(0, 200));

    // 3. a new instance from the form, with scan / diagnostics / cache options
    await page.click('#new-worker');
    await page.fill('#field-projectId', 'fix-two');
    await page.fill('#field-name', 'Fixture Two');
    await page.fill('#field-rootPath', projectTwo);
    await page.fill('#field-maxDepth', '6');
    await page.fill('#field-maxFileSizeMb', '2');
    await page.fill('#field-ignore', '**/*.md');
    await page.uncheck('#field-useGitignore');
    await page.uncheck('#field-skipHiddenDirectories');
    await page.selectOption('#field-cacheMode', 'full');
    await page.selectOption('#field-artifactLocation', 'external');
    await page.fill('#field-debounceMs', '700');
    const preview = await page.textContent('#command-preview');
    for (const flag of ['--max-depth 6', '--max-file-size-mb 2', "--ignore '**/*.md'", '--no-gitignore', '--no-skip-hidden', '--full', '--artifact-location external', '--debounce 700']) {
      check(`command preview contains ${flag}`, preview.includes(flag), preview);
    }
    await page.click('#save-start');
    await waitRowState('fix-two', 'ready');
    check('the new instance becomes ready', (await rowText('fix-two')).includes('fix-two'));
    check('form reported no error', ((await page.textContent('#form-errors')) || '').trim() === '');

    // the options must have reached the worker and changed what it indexed
    const indexPath = listFiles(path.join(dataDir, 'projects', 'fix-two')).find(file => file.endsWith('project-index.json'));
    const index = indexPath ? JSON.parse(fs.readFileSync(indexPath, 'utf8')) : { files: [] };
    const markdownIndexed = index.files.filter(file => file.path.endsWith('.md')).length;
    check('--ignore reached the indexer (no markdown indexed)', markdownBefore > 0 && markdownIndexed === 0, `fixture markdown ${markdownBefore}, indexed ${markdownIndexed}`);
    const stored = await (await fetch(`${base}/api/v1/gateway/projects/fix-two`, auth)).json();
    const config = stored.config ?? {};
    check('stored config keeps the new options', config.scan?.maxDepth === 6 && config.scan?.useGitignore === false
      && config.cache?.mode === 'full' && config.artifactLocation === 'external', JSON.stringify(config.scan));

    // 4. edit
    await row('fix-two').locator('button[data-action=edit]').click();
    await page.waitForFunction(() => !document.querySelector('#worker-form').hidden);
    check('the edit form is filled from the stored config', (await page.inputValue('#field-maxDepth')) === '6'
      && (await page.inputValue('#field-ignore')) === '**/*.md' && !(await page.isChecked('#field-useGitignore')));
    await page.fill('#field-debounceMs', '900');
    await page.click('#save-only');
    await page.waitForFunction(() => document.querySelector('#worker-form').hidden, null, { timeout: 30_000 });
    const edited = await (await fetch(`${base}/api/v1/gateway/projects/fix-two`, auth)).json();
    check('an edit is persisted', edited.config?.watchOptions?.debounceMs === 900, JSON.stringify(edited.config?.watchOptions));

    // 5. stop / start
    await row('fix-two').locator('button[data-action=stop]').click();
    await waitRowState('fix-two', 'stopped');
    check('stop puts the instance in the stopped state', true);
    await row('fix-two').locator('button[data-action=start]').click();
    await waitRowState('fix-two', 'ready');
    check('start brings it back', true);

    // 6. dashboard
    await row('fix-two').locator('button[data-action=open]').click();
    await page.waitForURL(/\/visualizer\?project=fix-two/, { timeout: 15_000 });
    await page.waitForFunction(() => /Nodes:\s*[1-9]/.test(document.body.innerText), null, { timeout: 30_000 });
    check('Open dashboard lands on that project\'s visualizer, authenticated and non-empty', true);

    // 7. remove
    await page.goto(`${base}/gateway?token=${TOKEN}`);
    await waitRowState('fix-two', 'ready');
    page.once('dialog', dialog => dialog.accept());
    await row('fix-two').locator('button[data-action=remove]').click();
    await page.waitForFunction(() => !document.querySelector('#worker-rows tr[data-project="fix-two"]'), null, { timeout: 30_000 });
    check('remove deletes the instance', true);

    check('no failing API calls from the console', failing.length === 0, failing.join('; '));
    check('no script errors', pageErrors.length === 0, pageErrors.join('; '));
  } catch (error) {
    failures.push(`unexpected: ${error.message}`);
    console.error(error);
    console.error('--- gateway log ---\n' + log.join('').slice(-4000));
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    gateway.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 1500));
    fs.rmSync(work, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error(`\ne2e-gateway: ${failures.length} failure(s): ${failures.join('; ')}`);
    process.exit(1);
  }
  console.log('\ne2e-gateway: all checks passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
