#!/usr/bin/env node
/**
 * Gate: nobody re-derives an artifact path by hand — فاز ۳, گام ۷.
 *
 * `resolveProjectPaths` is the only place allowed to decide where generated
 * data lives. A `path.join(root, '.semantic-engine')` written anywhere else is
 * how a writer and a reader end up looking at different directories, so this
 * script fails the build instead of letting it slip through review.
 *
 * Allowlist entries are pre-existing, deliberate uses:
 *
 *   - core/config/ProjectPaths.ts   — the resolver itself
 *   - core/config/defaultIgnorePatterns.ts — `.semantic-engine` as a scan-ignore entry
 *   - services/source/SourceSyncService.ts — skip-list while mirroring a tree
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
/*
| دقیقاً نام پوشهٔ artifact، نه هر رشته‌ای که با آن شروع شود:
| `doctor-command.ts` یک فایل موقت به نام `.semantic-engine-doctor-<pid>`
| می‌سازد تا نوشتن‌پذیری root را بسنجد و پاکش کند — آن مسیر artifact نیست.
*/
const LITERAL = /['"`]\.semantic-engine['"`]/;
const ALLOWLIST = new Set([
  path.join('core', 'config', 'ProjectPaths.ts'),
  path.join('core', 'config', 'defaultIgnorePatterns.ts'),
  path.join('services', 'source', 'SourceSyncService.ts'),
]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

const offenders = [];
for (const file of walk(SRC)) {
  const relative = path.relative(SRC, file);
  if (ALLOWLIST.has(relative)) continue;

  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    /* Comments and doc blocks may mention the directory name; only code that
       builds a path from it is a problem. */
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
    if (!LITERAL.test(line)) return;
    if (!/path\.(join|resolve)\(/.test(line)) return;
    offenders.push(`${relative}:${index + 1}: ${trimmed}`);
  });
}

if (offenders.length > 0) {
  process.stderr.write(
    'artifact paths must come from resolveProjectPaths():\n' +
      offenders.map(line => `  ${line}`).join('\n') +
      '\n'
  );
  process.exit(1);
}

process.stdout.write('artifact location gate: ok\n');
