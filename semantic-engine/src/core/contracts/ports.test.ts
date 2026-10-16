/**
 * `ports.ts` — the input boundary of CodeIntel.
 *
 * The `FileProvider` contract is checked twice:
 *
 *   1. structurally, so the port cannot quietly grow a write method: the
 *      literal `readOnly: true` and the absence of mutating members are
 *      asserted at runtime against the reference implementation;
 *   2. behaviourally, through `ConfinedFileProvider` on a real workspace, for
 *      the rules the port's doc comment promises — deterministic, duplicate-free
 *      ordering, metadata preservation, rejection of anything outside the
 *      workspace, and error propagation instead of a silent empty answer.
 *
 * A fake provider is also exercised, because "replaceable" is a property of the
 * port: a caller holding only the interface must be able to swap the
 * implementation, including in a unit test.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfinedFileProvider, FileProviderError } from './fileProvider';
import { FileMetadata, FileProvider, WhitespaceTokenCounter, deterministicPaths } from './ports';

let workspace: string;

function write(relative: string, content: string): void {
  const absolute = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'se-ports-'));
  write('src/a.ts', 'export const a = 1;\n');
  write('src/b.ts', 'export const b = 2;\n');
  write('src/nested/c.ts', 'export const c = 3;\n');
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('FileProvider — the read boundary is read-only', () => {
  test('the literal type carries the guarantee at runtime', () => {
    const provider = new ConfinedFileProvider({ workspaceRoot: workspace });
    expect(provider.readOnly).toBe(true);
    expect(Object.isFrozen(provider)).toBe(false);
    /* `readOnly` cannot be flipped: it is a getter-less literal typed property,
       and nothing in the implementation writes to it. */
    expect(provider.readOnly).toBe(true);
  });

  test('no write, delete or rename operation is part of the boundary', () => {
    const provider: FileProvider = new ConfinedFileProvider({ workspaceRoot: workspace });
    const prototype = Object.getPrototypeOf(provider) as object;
    /* The port's three methods are reachable, and no mutating member exists on
       the instance or on the prototype. Private helpers do live on the
       prototype — TypeScript's `private` is a compile-time modifier — so the
       check is by name, over the full set of write-ish verbs. */
    expect([provider.list, provider.read, provider.exists].every(m => typeof m === 'function')).toBe(true);
    const mutating = ['write', 'writeFile', 'writeFileAtomic', 'append', 'appendFile', 'remove', 'delete', 'unlink', 'rename', 'move', 'mkdir', 'mkdirp', 'chmod', 'truncate'];
    for (const member of mutating) {
      expect(member in provider).toBe(false);
      expect(member in prototype).toBe(false);
    }
  });

  test('a caller holding only the port can swap implementations', async () => {
    const stub: FileProvider = {
      readOnly: true,
      list: async () => [
        { relativePath: 'stub.ts', sizeBytes: 1, mtimeMs: 0, isSymlink: false, isBinary: false },
      ],
      read: async () => new Uint8Array([1]),
      exists: async () => false,
    };
    await expect(stub.list('')).resolves.toHaveLength(1);
    await expect(stub.exists('missing.ts')).resolves.toBe(false);
    await expect(new ConfinedFileProvider({ workspaceRoot: workspace }).list('src')).resolves.toHaveLength(2);
  });
});

describe('FileProvider — real listing behaviour', () => {
  test('orders deterministically and drops duplicates', async () => {
    const provider = new ConfinedFileProvider({ workspaceRoot: workspace });
    const listed = await provider.list('src');
    const paths = listed.map(entry => entry.relativePath);
    expect(paths).toEqual([...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(new Set(paths).size).toBe(paths.length);
    expect(await provider.list('src')).toEqual(listed);
  });

  test('preserves file metadata', async () => {
    const provider = new ConfinedFileProvider({ workspaceRoot: workspace });
    const [entry] = await provider.list('src');
    const stats = fs.statSync(path.join(workspace, entry.relativePath));
    expect(entry).toMatchObject({
      relativePath: 'src/a.ts',
      sizeBytes: stats.size,
      mtimeMs: stats.mtimeMs,
      isSymlink: false,
      isBinary: false,
    });
  });

  test('metadata for a nested directory is reported relative to the workspace', async () => {
    const provider = new ConfinedFileProvider({ workspaceRoot: workspace });
    const listed = await provider.list('src/nested');
    expect(listed.map(entry => entry.relativePath)).toEqual(['src/nested/c.ts']);
  });

  test('a provider error is propagated, never turned into an empty listing', async () => {
    const provider = new ConfinedFileProvider({
      workspaceRoot: workspace,
      fileSystem: {
        readdir: async () => {
          throw new Error('I/O exploded');
        },
        lstat: async () => {
          throw new Error('unused');
        },
        stat: async () => {
          throw new Error('unused');
        },
        readFile: async () => Buffer.alloc(0),
        readPrefix: async () => Buffer.alloc(0),
        realpath: async value => value,
        exists: async () => true,
      },
    });
    await expect(provider.list('src')).rejects.toThrow(/I\/O exploded/u);
    await expect(provider.list('src')).rejects.toBeInstanceOf(FileProviderError);
  });
});

describe('FileProvider — paths outside the workspace', () => {
  test.each([
    ['parent traversal', '../secrets.ts'],
    ['absolute path', '/etc/hosts'],
    ['sibling escape via src', 'src/../../secrets.ts'],
  ])('%s is refused', async (_name, target) => {
    const provider = new ConfinedFileProvider({ workspaceRoot: workspace });
    await expect(provider.read(target, 1024)).rejects.toBeInstanceOf(FileProviderError);
    await expect(provider.exists(target)).rejects.toMatchObject({ code: 'DENIED' });
  });

  test('a path inside the workspace but not a file answers false rather than throwing', async () => {
    const provider = new ConfinedFileProvider({ workspaceRoot: workspace });
    await expect(provider.exists('src')).resolves.toBe(false);
    await expect(provider.exists('src/missing.ts')).resolves.toBe(false);
  });

  test('an unauthorized file name is refused even when it is inside the workspace', async () => {
    write('.env', 'SECRET=1\n');
    const provider = new ConfinedFileProvider({ workspaceRoot: workspace });
    await expect(provider.read('.env', 1024)).rejects.toMatchObject({ code: 'DENIED' });
  });
});

describe('TokenCounter — replaceable by construction', () => {
  test('the reference counter satisfies the port and counts a range through LineIndex', () => {
    const counter: { count(t: string): number; countRange(t: string, r: unknown): number } =
      new WhitespaceTokenCounter();
    expect(typeof counter.count).toBe('function');
    expect(typeof counter.countRange).toBe('function');

    const reference = new WhitespaceTokenCounter();
    expect(reference.count('  ')).toBe(0);
    expect(reference.count('one two  three')).toBe(3);
    expect(
      reference.countRange('one two\nthree four', {
        start: { line: 0, character: 0 },
        end: { line: 1, character: 5 },
      })
    ).toBe(3);
    expect(
      reference.countRange('one two\nthree four', {
        start: { line: 0, character: 0 },
        end: { line: 1, character: 10 },
      })
    ).toBe(4);
    expect(
      reference.countRange('one two\nthree four', {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 3 },
      })
    ).toBe(1);
  });

  test('two implementations can disagree without touching the read path', () => {
    class CharacterCounter extends WhitespaceTokenCounter {
      override count(text: string): number {
        return text.length;
      }
    }
    const text = 'one two three';
    expect(new WhitespaceTokenCounter().count(text)).toBe(3);
    expect(new CharacterCounter().count(text)).toBe(13);
  });
});

describe('deterministicPaths', () => {
  test('removes duplicates and sorts by code unit', () => {
    expect(deterministicPaths(['b.ts', 'a.ts', 'b.ts'])).toEqual(['a.ts', 'b.ts']);
    expect(deterministicPaths(['src/β.ts', 'src/a.ts'])).toEqual(['src/a.ts', 'src/β.ts']);
    expect(deterministicPaths(['B.ts', 'a.ts'])).toEqual(['B.ts', 'a.ts']);
  });

  test('is stable across calls and does not mutate its input', () => {
    const input = ['b.ts', 'a.ts', 'b.ts'];
    const snapshot = [...input];
    const first = deterministicPaths(input);
    expect(deterministicPaths(input)).toEqual(first);
    expect(input).toEqual(snapshot);
  });

  test('an empty input is an empty (not undefined) result', () => {
    expect(deterministicPaths([])).toEqual([]);
  });
});

describe('FileMetadata — the boundary reports what it cannot read', () => {
  test('binary and symlink flags are part of the metadata a caller receives', async () => {
    write('src/binary.dat', 'A\u0000B');
    fs.symlinkSync(path.join(workspace, 'src', 'a.ts'), path.join(workspace, 'src', 'link.ts'));
    const provider = new ConfinedFileProvider({ workspaceRoot: workspace });
    const byName = new Map<string, FileMetadata>(
      (await provider.list('src')).map(entry => [entry.relativePath, entry])
    );
    expect(byName.get('src/binary.dat')?.isBinary).toBe(true);
    expect(byName.get('src/link.ts')?.isSymlink).toBe(true);
    expect(byName.get('src/a.ts')?.isSymlink).toBe(false);
  });
});
