/**
 * SE-UI-001 — structural lock for the dashboard's project-switch honesty.
 *
 * open.js is a browser script with no module boundary (same situation as the
 * HttpServer source checks in readyHonesty.test.ts), so the contract is locked
 * on the source: a failed or in-flight project switch must leave no live
 * state.projectId, and the visualizer link must not survive a non-ready
 * selection. The alternative — pretending a fake-DOM harness proves the
 * behavior — would test the harness, not the file.
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'open.js'), 'utf8');

describe('SE-UI-001 — project switch leaves no stale state', () => {
  it('a reset helper nulls projectId and clears the visualizer href', () => {
    expect(SRC).toMatch(/function clearProjectSelection\(\)[\s\S]*?state\.projectId = null;[\s\S]*?gotoVisualizerBtn[\s\S]*?removeAttribute\(["']href["']\)/);
  });

  it('selectProject resets BEFORE the request (no window where a stale id survives a slow switch)', () => {
    const body = SRC.slice(SRC.indexOf('async function selectProject'));
    const resetAt = body.indexOf('clearProjectSelection()');
    const postAt = body.indexOf('await api("POST"');
    expect(resetAt).toBeGreaterThan(-1);
    expect(resetAt).toBeLessThan(postAt);
  });

  it('the catch path resets and says so in the user-visible log', () => {
    expect(SRC).toMatch(/catch \(e\) \{\s*\n\s*clearProjectSelection\(\);[\s\S]{0,200}no project is selected/);
  });

  it('the visualizer link is only shown for a ready project', () => {
    const body = SRC.slice(SRC.indexOf('async function selectProject'), SRC.indexOf('// ── indexing'));
    const showAt = body.indexOf('gotoVisualizerBtn").hidden = false');
    const readyAt = body.indexOf('if (project.status === "ready")');
    expect(readyAt).toBeGreaterThan(-1);
    expect(showAt).toBeGreaterThan(readyAt);
  });
});
