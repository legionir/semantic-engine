/**
 * F-03 — every API path the browser UI calls must exist on the backend.
 *
 * The UI in `public/` once carried a second, unrelated console (`app.js`) that
 * called eleven endpoints this server never had. Nothing noticed, because
 * nothing compared the two sides. This test does: it collects the `/api/…`,
 * `/health`, `/mcp` literals from the shipped scripts and requires each to
 * match a registered route pattern (server or gateway).
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function backendSource(): string {
  return [...walk(path.join(ROOT, 'src', 'server')), ...walk(path.join(ROOT, 'src', 'gateway'))]
    .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map(f => fs.readFileSync(f, 'utf8'))
    .join('\n');
}

function backendPatterns(): string[] {
  const patterns = new Set<string>();
  const files = [...walk(path.join(ROOT, 'src', 'server')), ...walk(path.join(ROOT, 'src', 'gateway'))].filter(
    f => f.endsWith('.ts') && !f.endsWith('.test.ts')
  );
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/pattern:\s*['"`]([^'"`]+)['"`]/g)) patterns.add(m[1]!);
    for (const m of text.matchAll(/['"`](\/(?:api\/[A-Za-z0-9_\-/:.]+|health|ready|metrics|mcp(?:\/:?[A-Za-z]*)?))['"`]/g)) {
      patterns.add(m[1]!);
    }
    /* regexes in the gateway router, e.g. /^\/api\/v1\/gateway\/projects\/([^/]+)\/health$/ */
    for (const m of text.matchAll(/\/\^((?:\\\/[A-Za-z0-9_\-()[\]^+?:|.\\*]+)+)/g)) {
      patterns.add(
        m[1]!.replace(/\\\//g, '/').replace(/\(\[\^\/\]\+\)/g, ':p').replace(/\(\?:[^)]*\)\??/g, '').replace(/\(\/\|\$\)/g, '')
      );
    }
  }
  return [...patterns];
}

function toRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z]+/g, '[^/]+');
  return new RegExp(`^${escaped}/?$`);
}

describe('public/*.js ↔ backend routes', () => {
  const patterns = backendPatterns();
  const source = backendSource();
  const regexes = patterns.map(toRegex);
  const scripts = fs
    .readdirSync(path.join(ROOT, 'public'))
    .filter(f => f.endsWith('.js'))
    .map(f => path.join(ROOT, 'public', f));

  it('finds a believable number of backend routes', () => {
    expect(patterns.length).toBeGreaterThan(50);
  });

  it('every API literal in the UI resolves to a backend route', () => {
    const unmatched: string[] = [];
    for (const file of scripts) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/["'`](\/(?:api\/[A-Za-z0-9_\-/:.${}()]*|health|ready|metrics|mcp\/?))["'`]/g)) {
        const literal = m[1]!;
        const normalized = literal.replace(/\$\{[^}]*\}/g, 'x');
        const isPrefix = normalized.endsWith('/') && normalized !== '/';
        /* a trailing-slash literal is a prefix the UI appends an id to; the router may spell it as a regex */
        const prefix = normalized.slice(0, -1);
        const ok = isPrefix
          ? source.includes(prefix) || source.includes(prefix.replace(/\//g, '\\/'))
          : regexes.some(r => r.test(normalized.split('?')[0]!));
        if (!ok) unmatched.push(`${path.basename(file)}: ${literal}`);
      }
    }
    expect(unmatched).toEqual([]);
  });

  it('ships no console that talks to endpoints this server does not have', () => {
    const present = fs.readdirSync(path.join(ROOT, 'public'));
    expect(present).not.toContain('app.js');
    expect(present).not.toContain('index.html');
  });
});
