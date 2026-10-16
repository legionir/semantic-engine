/**
 * Plan phase 3 / step 2 — measured resolution matrix (nothing here is assumed).
 *
 * supported   : behaviour the resolver really has, asserted.
 * limitation  : behaviour it does NOT have; the import stays unresolved
 *               (`null`, so `resolvedFileId: null`) — the documented raw-only
 *               contract. If someone adds support, the test must be flipped on purpose.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TSPathResolver } from './TSPathResolver';

let root: string;

function write(relative: string, content = 'export const x = 1;\n'): void {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

const rel = (p: string | null): string | null => (p === null ? null : p.split(path.sep).join('/')); // resolver returns workspace-relative paths

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'se-matrix-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('TSPathResolver matrix', () => {
  it('supported: two tsconfigs in one workspace, each importer uses its nearest one', () => {
    write('a/tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['lib-a/*'] } } }));
    write('b/tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['lib-b/*'] } } }));
    write('a/lib-a/util.ts');
    write('b/lib-b/util.ts');
    write('a/src/main.ts', '');
    write('b/src/main.ts', '');

    const resolver = new TSPathResolver(root);
    expect(rel(resolver.resolve('@lib/util', 'a/src/main.ts'))).toBe('a/lib-a/util.ts');
    expect(rel(resolver.resolve('@lib/util', 'b/src/main.ts'))).toBe('b/lib-b/util.ts');
  });

  it('supported: an alias never leaks across sibling projects', () => {
    write('a/tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@only-a/*': ['x/*'] } } }));
    write('a/x/thing.ts');
    write('b/tsconfig.json', JSON.stringify({ compilerOptions: {} }));
    write('b/src/main.ts', '');
    expect(new TSPathResolver(root).resolve('@only-a/thing', 'b/src/main.ts')).toBeNull();
  });

  it('limitation: project references are not followed (paths of a referenced project are not applied)', () => {
    write('core/tsconfig.json', JSON.stringify({ compilerOptions: { composite: true, baseUrl: '.', paths: { '@core/*': ['src/*'] } } }));
    write('core/src/index.ts');
    write('app/tsconfig.json', JSON.stringify({ references: [{ path: '../core' }], compilerOptions: {} }));
    write('app/src/main.ts', '');
    expect(new TSPathResolver(root).resolve('@core/index', 'app/src/main.ts')).toBeNull();
  });

  it('limitation: a workspace package name (monorepo cross-project import) is not resolved', () => {
    write('packages/lib/package.json', JSON.stringify({ name: '@acme/lib', main: 'src/index.ts' }));
    write('packages/lib/src/index.ts');
    write('packages/app/tsconfig.json', JSON.stringify({ compilerOptions: {} }));
    write('packages/app/src/main.ts', '');
    expect(new TSPathResolver(root).resolve('@acme/lib', 'packages/app/src/main.ts')).toBeNull();
  });
});
