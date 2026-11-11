/**
 * Phase 0 — read/write boundary of source ingestion (`SourceSecurityGuard`).
 *
 * `SourceSecurityGuard` is the confinement code the AI read tools ship with,
 * so this suite executes it against a real directory tree: traversal, an
 * escaping symlink, a symlink cycle, blocked extensions, and the per-file and
 * total byte caps.
 *
 * The same rules also exist in `core/contracts/fileProvider.ts` for the
 * CodeIntel read port. The duplication is deliberate and recorded as D-0007;
 * this suite pins the *behaviour* that must be unified, so a future refactor
 * cannot silently drop a rule from either copy.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_SECURITY_POLICY, SourceSecurityGuard } from '../services/source/SourceSecurityGuard';

let root: string;
let outside: string;

function guard(policy?: ConstructorParameters<typeof SourceSecurityGuard>[0]) {
  return new SourceSecurityGuard(policy ?? DEFAULT_SECURITY_POLICY);
}

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'se-readboundary-'));
  root = path.join(base, 'root');
  outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(outside, 'secret.ts'), 'export const leaked = true;\n');
});

afterEach(() => {
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
});

describe('SourceSecurityGuard — relative paths inside the root', () => {
  test('accepts a normalized relative path and returns the resolved target', () => {
    const result = guard().validateRelativePath(root, 'src/a.ts');
    expect(result.ok).toBe(true);
    expect(result.resolvedPath).toBe(path.join(root, 'src', 'a.ts'));
  });

  test('accepts a path whose parent does not exist yet', () => {
    expect(guard().validateRelativePath(root, 'src/deep/new/file.ts').ok).toBe(true);
  });

  test.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['null byte', 'src/a\0.ts'],
  ])('rejects %s', (_name, target) => {
    const result = guard().validateRelativePath(root, target);
    expect(result.ok).toBe(false);
    expect(result.reason).toBeDefined();
  });

  test.each([
    ['parent traversal', '../outside/secret.ts'],
    ['nested traversal', 'src/../../outside/secret.ts'],
    ['normalized-away traversal', 'a/b/../../..'],
    ['absolute path', '/etc/passwd'],
  ])('rejects %s', (_name, target) => {
    const result = guard().validateRelativePath(root, target);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/traversal|escape/iu);
  });

  test('rejects a root that does not exist', () => {
    const result = guard().validateRelativePath(path.join(root, 'nope'), 'a.ts');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/does not exist/iu);
  });
});

describe('SourceSecurityGuard — symlinks', () => {
  test('rejects a path that traverses an escaping symlinked directory', () => {
    fs.symlinkSync(outside, path.join(root, 'linked'), 'dir');
    const result = guard().validateRelativePath(root, 'linked/secret.ts');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/symlink/iu);
  });

  test('rejects a path that is itself an escaping symlink', () => {
    fs.symlinkSync(path.join(outside, 'secret.ts'), path.join(root, 'link.ts'));
    const result = guard().validateRelativePath(root, 'link.ts');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/symlink/iu);
  });

  test('allows a symlink that stays inside the root', () => {
    fs.symlinkSync(path.join(root, 'src', 'a.ts'), path.join(root, 'link-in.ts'));
    expect(guard().validateRelativePath(root, 'link-in.ts').ok).toBe(true);
  });

  test('detects a symlink cycle instead of recursing forever', () => {
    fs.symlinkSync(path.join(root, 'loop-b'), path.join(root, 'loop-a'), 'dir');
    fs.symlinkSync(path.join(root, 'loop-a'), path.join(root, 'loop-b'), 'dir');
    const result = guard().validateSymlink(path.join(root, 'loop-a'));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/cyclic|depth|error/iu);
  });

  test('refuses symlink chains deeper than the policy allows', () => {
    let previous = path.join(root, 'src', 'a.ts');
    for (let depth = 0; depth < 5; depth += 1) {
      const link = path.join(root, `chain-${depth}.ts`);
      fs.symlinkSync(previous, link);
      previous = link;
    }
    const result = guard({ maxSymlinkDepth: 2 }).validateSymlink(previous);
    expect(result.ok).toBe(false);
  });

  test('a plain file is not a symlink problem', () => {
    expect(guard().validateSymlink(path.join(root, 'src', 'a.ts')).ok).toBe(true);
    expect(guard().validateSymlink(path.join(root, 'missing.ts')).ok).toBe(true);
  });
});

describe('SourceSecurityGuard — extensions and size caps', () => {
  test.each(['.exe', '.dll', '.so', '.dylib', '.bin', '.iso', '.dmg'])(
    'blocks %s',
    extension => {
      const result = guard().validateRelativePath(root, `tools/payload${extension}`);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/extension/iu);
    }
  );

  test('blocked extensions are matched case-insensitively', () => {
    expect(guard().validateRelativePath(root, 'payload.EXE').ok).toBe(false);
  });

  test('an ordinary source extension passes', () => {
    expect(guard().validateRelativePath(root, 'src/a.ts').ok).toBe(true);
    expect(guard().validateRelativePath(root, 'asset.png').ok).toBe(true);
  });

  test('the per-file cap is inclusive at the limit and exclusive above it', () => {
    const limited = guard({ maxFileSizeBytes: 100 });
    expect(limited.validateFileSize(100).ok).toBe(true);
    expect(limited.validateFileSize(101).ok).toBe(false);
  });

  test('the per-bundle cap is enforced as well', () => {
    const limited = guard({ maxTotalSizeBytes: 10 });
    expect(limited.validateTotalSize(10).ok).toBe(true);
    const result = limited.validateTotalSize(11);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/exceeds limit/iu);
  });
});
