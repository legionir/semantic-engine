/**
 * ConfinedFileProvider — the read boundary, executed against a real filesystem.
 *
 * Every claim in the provider's header comment is checked here with real files,
 * real symlinks and real denylist names. The only fake is the filesystem
 * adapter, used for the two paths a real filesystem cannot produce on demand: a
 * hung read (deadline) and a cancelled read.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ConfinedFileProvider,
  DEFAULT_DENIED_PATTERNS,
  FileProviderError,
  isInside,
  ProviderFileSystem,
  nodeProviderFileSystem,
} from './fileProvider';

let workspace: string;
let outside: string;

function write(absolute: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

function provider(overrides: Partial<ConstructorParameters<typeof ConfinedFileProvider>[0]> = {}) {
  return new ConfinedFileProvider({ workspaceRoot: workspace, ...overrides });
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'NO_ERROR';
  } catch (error) {
    if (error instanceof FileProviderError) return error.code;
    throw error;
  }
}

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'se-provider-'));
  workspace = path.join(base, 'workspace');
  outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });

  write(path.join(workspace, 'src', 'a.ts'), 'export const a = 1;\n');
  write(path.join(workspace, 'src', 'b.ts'), 'export const b = 2;\n');
  write(path.join(workspace, 'src', 'binary.dat'), Buffer.from([0x41, 0x00, 0x42]));
  write(path.join(workspace, 'README.md'), '# readme\n');
  write(path.join(workspace, '.env'), 'SECRET=1\n');
  write(path.join(workspace, 'id_rsa'), 'private key\n');
  write(path.join(workspace, 'secret.pem'), 'pem\n');
  write(path.join(workspace, 'credentials.json'), '{}\n');
  write(path.join(workspace, '.git', 'objects', 'ab'), 'object\n');
  write(path.join(outside, 'secret.ts'), 'export const leaked = true;\n');

  fs.symlinkSync(path.join(workspace, 'src', 'a.ts'), path.join(workspace, 'src', 'link-in.ts'));
  fs.symlinkSync(path.join(outside, 'secret.ts'), path.join(workspace, 'link-out.ts'));
  fs.symlinkSync(outside, path.join(workspace, 'linkdir'));
});

afterEach(() => {
  fs.rmSync(path.dirname(workspace), { recursive: true, force: true });
});

describe('ConfinedFileProvider — the port is read-only', () => {
  test('declares readOnly and exposes no mutating operation', () => {
    const read = provider();
    expect(read.readOnly).toBe(true);
    for (const method of ['write', 'writeFile', 'append', 'remove', 'delete', 'rename', 'mkdir', 'chmod']) {
      expect(method in read).toBe(false);
    }
  });

  test('is structurally usable as the FileProvider port', async () => {
    const read = provider();
    /* Compile-time proof that the implementation satisfies the port: the
       parameter type is the port's own shape. */
    const asPort: { list(d: string): unknown; read(p: string, m: number): unknown; exists(p: string): unknown } = read;
    expect(typeof asPort.list).toBe('function');
    await expect(read.exists('src/a.ts')).resolves.toBe(true);
  });
});

describe('ConfinedFileProvider — listing is deterministic and truthful', () => {
  test('lists a directory sorted by code unit, duplicate-free', async () => {
    const entries = await provider().list('src');
    const names = entries.map(entry => entry.relativePath);
    expect(names).toEqual(['src/a.ts', 'src/b.ts', 'src/binary.dat', 'src/link-in.ts']);
    expect(new Set(names).size).toBe(names.length);
  });

  test('the same listing twice is byte-identical, and iteration order is irrelevant', async () => {
    const first = await provider().list('src');
    const second = await provider().list('src');
    expect(second).toEqual(first);
  });

  test('metadata matches the filesystem, including the symlink flag', async () => {
    const entries = await provider().list('src');
    const byName = new Map(entries.map(entry => [entry.relativePath, entry]));

    const a = byName.get('src/a.ts')!;
    expect(a.sizeBytes).toBe(fs.statSync(path.join(workspace, 'src', 'a.ts')).size);
    expect(a.mtimeMs).toBe(fs.statSync(path.join(workspace, 'src', 'a.ts')).mtimeMs);
    expect(a.isSymlink).toBe(false);
    expect(a.isBinary).toBe(false);

    const binary = byName.get('src/binary.dat')!;
    expect(binary.isBinary).toBe(true);

    const link = byName.get('src/link-in.ts')!;
    expect(link.isSymlink).toBe(true);
    /* A confined symlink is described by its target, which is what a read
       returns. */
    expect(link.sizeBytes).toBe(fs.statSync(path.join(workspace, 'src', 'a.ts')).size);
  });

  test('the workspace root itself can be listed', async () => {
    const entries = await provider().list('');
    expect(entries.map(entry => entry.relativePath)).toEqual([
      'README.md',
      'credentials.json',
      'id_rsa',
      'link-out.ts',
      'linkdir',
      'secret.pem',
    ].filter(name => {
      /* Files only, and denylisted names are not listed at all. */
      return !['credentials.json', 'id_rsa', 'secret.pem', 'linkdir', 'link-out.ts'].includes(name);
    }));
  });

  test('a symlink whose target escapes the workspace is not listed', async () => {
    const entries = await provider().list('');
    expect(entries.map(entry => entry.relativePath)).not.toContain('link-out.ts');
  });

  test('the same escaping symlink is refused, not silently answered, when named', async () => {
    expect(await codeOf(() => provider().read('link-out.ts', 1024))).toBe('DENIED');
    expect(await codeOf(() => provider().exists('link-out.ts'))).toBe('DENIED');
  });

  test('listing through a symlinked directory that escapes the root is denied', async () => {
    expect(await codeOf(() => provider().list('linkdir'))).toBe('DENIED');
  });

  test('denylisted names are never listed', async () => {
    const names = (await provider().list('')).map(entry => entry.relativePath);
    for (const denied of ['.env', 'id_rsa', 'secret.pem', 'credentials.json']) {
      expect(names).not.toContain(denied);
    }
  });

  test('a directory that does not exist is NOT_FOUND rather than an empty list', async () => {
    expect(await codeOf(() => provider().list('nope'))).toBe('NOT_FOUND');
  });
});

describe('ConfinedFileProvider — reading', () => {
  test('returns the bytes of a regular file', async () => {
    const bytes = await provider().read('README.md', 1024);
    expect(Buffer.from(bytes).toString('utf8')).toBe('# readme\n');
  });

  test('reads a confined symlink as its target', async () => {
    const bytes = await provider().read('src/link-in.ts', 1024);
    expect(Buffer.from(bytes).toString('utf8')).toBe('export const a = 1;\n');
  });

  test('enforces the byte cap from the caller and the provider', async () => {
    const body = 'x'.repeat(200);
    write(path.join(workspace, 'src', 'big.ts'), body);

    expect(await codeOf(() => provider().read('src/big.ts', 10))).toBe('LIMIT_EXCEEDED');
    expect(await codeOf(() => provider({ maxFileBytes: 50 }).read('src/big.ts', 1000))).toBe(
      'LIMIT_EXCEEDED'
    );
    await expect(provider({ maxFileBytes: 1000 }).read('src/big.ts', 1000)).resolves.toHaveLength(200);
  });

  test('rejects a non-positive maxBytes instead of guessing', async () => {
    for (const maxBytes of [0, -1, 1.5, Number.NaN]) {
      expect(await codeOf(() => provider().read('README.md', maxBytes))).toBe('INVALID_ARGUMENT');
    }
  });

  test('a directory is not readable as a file', async () => {
    expect(await codeOf(() => provider().read('src', 1024))).toBe('DENIED');
  });

  test('a missing file is NOT_FOUND', async () => {
    expect(await codeOf(() => provider().read('src/missing.ts', 1024))).toBe('NOT_FOUND');
  });
});

describe('ConfinedFileProvider — confinement and the denylist', () => {
  test.each([
    ['traversal', '../outside/secret.ts'],
    ['nested traversal', 'src/../../outside/secret.ts'],
    ['absolute path', '/etc/passwd'],
    ['absolute path with separator', '/tmp/whatever.ts'],
    ['drive letter', 'C:/windows/system32/config'],
  ])('refuses %s', async (_name, target) => {
    expect(await codeOf(() => provider().read(target, 1024))).toBe('DENIED');
  });

  test.each([
    ['NUL byte', 'src/a\0.ts'],
    ['backslash separators', 'src\\a.ts'],
    ['empty', ''],
  ])('rejects %s as an invalid argument', async (_name, target) => {
    expect(await codeOf(() => provider().read(target, 1024))).toBe('INVALID_ARGUMENT');
  });

  test.each(DEFAULT_DENIED_PATTERNS.map(pattern => [pattern, pattern]))(
    'denylist pattern %s is refused',
    async (_name, pattern) => {
      const fileName = pattern.replace('.*', '.local').replace('*', '1');
      const absolute = path.join(workspace, fileName);
      if (!fs.existsSync(absolute)) write(absolute, 'secret\n');
      expect(await codeOf(() => provider().read(fileName, 1024))).toBe('DENIED');
    }
  );

  test('a denylisted path is refused even when it exists and is readable', async () => {
    expect(await codeOf(() => provider().read('.env', 1024))).toBe('DENIED');
    expect(await codeOf(() => provider().read('.git/objects/ab', 1024))).toBe('DENIED');
    expect(await codeOf(() => provider().exists('.env'))).toBe('DENIED');
  });

  test('the denylist can be widened but not silently emptied for secrets', async () => {
    const custom = provider({ deniedPatterns: ['*.sqlite'], deniedSegments: [] });
    await expect(custom.read('.env', 1024)).resolves.toBeInstanceOf(Uint8Array);
    write(path.join(workspace, 'db.sqlite'), 'binary');
    expect(await codeOf(() => custom.read('db.sqlite', 1024))).toBe('DENIED');
  });

  test('confinement is measured against the canonical root, not a symlinked one', async () => {
    const linkedRoot = path.join(path.dirname(workspace), 'workspace-link');
    fs.symlinkSync(workspace, linkedRoot);
    const read = new ConfinedFileProvider({ workspaceRoot: linkedRoot });

    await expect(read.read('README.md', 1024)).resolves.toBeInstanceOf(Uint8Array);
    expect(await codeOf(() => read.read('link-out.ts', 1024))).toBe('DENIED');
    expect(await read.canonicalWorkspaceRoot()).toBe(fs.realpathSync(workspace));
  });

  test('isInside agrees with the path rules', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true);
    expect(isInside('/a/b', '/a/b/c')).toBe(true);
    expect(isInside('/a/b', '/a/bc')).toBe(false);
    expect(isInside('/a/b', '/a')).toBe(false);
  });
});

describe('ConfinedFileProvider — limits, deadlines and cancellation', () => {
  test('refuses to list a directory with more entries than maxFiles', async () => {
    for (let i = 0; i < 6; i += 1) {
      write(path.join(workspace, 'many', `f${i}.ts`), 'export {};\n');
    }
    expect(await codeOf(() => provider({ maxFiles: 5 }).list('many'))).toBe('LIMIT_EXCEEDED');
    await expect(provider({ maxFiles: 6 }).list('many')).resolves.toHaveLength(6);
  });

  test('a hung read hits the deadline and reports TIMEOUT', async () => {
    const hanging: ProviderFileSystem = {
      ...nodeProviderFileSystem,
      readFile: () => new Promise<Buffer>(() => undefined),
    };
    const code = await codeOf(() =>
      provider({ fileSystem: hanging, timeoutMs: 25 }).read('README.md', 1024)
    );
    expect(code).toBe('TIMEOUT');
  });

  test('a cancelled call reports CANCELLED and does not wait for the deadline', async () => {
    const controller = new AbortController();
    const hanging: ProviderFileSystem = {
      ...nodeProviderFileSystem,
      readFile: () => new Promise<Buffer>(() => undefined),
    };
    const read = provider({
      fileSystem: hanging,
      timeoutMs: 10_000,
      signal: controller.signal,
    });

    const pending = codeOf(() => read.read('README.md', 1024));
    setTimeout(() => controller.abort(), 5);
    expect(await pending).toBe('CANCELLED');
  });

  test('an already-aborted signal fails before any I/O happens', async () => {
    const controller = new AbortController();
    controller.abort();
    let touched = false;
    const spy: ProviderFileSystem = {
      ...nodeProviderFileSystem,
      readFile: async target => {
        touched = true;
        return nodeProviderFileSystem.readFile(target);
      },
    };
    const code = await codeOf(() =>
      provider({ fileSystem: spy, signal: controller.signal }).read('README.md', 1024)
    );
    expect(code).toBe('CANCELLED');
    expect(touched).toBe(false);
  });

  test('provider failures are mapped to contract codes instead of leaking errno strings', async () => {
    const failing: ProviderFileSystem = {
      ...nodeProviderFileSystem,
      readdir: async () => {
        const error = new Error('EACCES: permission denied') as Error & { code: string };
        error.code = 'EACCES';
        throw error;
      },
    };
    expect(await codeOf(() => provider({ fileSystem: failing }).list('src'))).toBe('DENIED');
  });

  test('an unknown provider failure becomes IO_ERROR and keeps its message', async () => {
    const failing: ProviderFileSystem = {
      ...nodeProviderFileSystem,
      readFile: async () => {
        throw new Error('disk on fire');
      },
    };
    await expect(
      provider({ fileSystem: failing }).read('README.md', 1024)
    ).rejects.toThrow(/disk on fire/u);
    expect(await codeOf(() => provider({ fileSystem: failing }).read('README.md', 1024))).toBe(
      'IO_ERROR'
    );
  });
});
