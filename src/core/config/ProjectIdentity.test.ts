import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  PROJECT_ID_PATTERN,
  assertProjectId,
  assertProjectRoot,
  canonicalizeRoot,
  isValidProjectId,
  normalizeDriveLetter,
  projectIdFor,
  projectHash,
  slugify,
} from './ProjectIdentity';

function makeTree(base: string, ...parts: string[]): string {
  const root = path.join(base, ...parts);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  return root;
}

describe('ProjectIdentity — ids that cannot collide', () => {
  let base: string;

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-identity-')));
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('gives two projects named `app` different ids', () => {
    /* This is the regression the plan audit measured: both used to become
       `prj-app`, and the second registration replaced the first. */
    const clientA = makeTree(base, 'client-a', 'app');
    const clientB = makeTree(base, 'client-b', 'app');

    const idA = projectIdFor('app', assertProjectRoot(clientA));
    const idB = projectIdFor('app', assertProjectRoot(clientB));

    expect(idA).not.toBe(idB);
    expect(idA).toMatch(PROJECT_ID_PATTERN);
    expect(idB).toMatch(PROJECT_ID_PATTERN);
  });

  it('is deterministic and matches the documented scheme', () => {
    const root = assertProjectRoot(makeTree(base, 'engine-core'));
    const expectedHash = crypto.createHash('sha256').update(root).digest('hex').slice(0, 8);

    expect(projectHash(root)).toBe(expectedHash);
    expect(projectIdFor('Engine Core', root)).toBe(`prj-engine-core-${expectedHash}`);
    expect(projectIdFor('Engine Core', root)).toBe(projectIdFor('Engine Core', root));
  });

  it('slugs display names the way structured-ai does', () => {
    expect(slugify('Engine Core')).toBe('engine-core');
    expect(slugify('  Weird   NAME--42 ')).toBe('weird-name-42');
    expect(slugify('')).toBe('project');
    expect(slugify('___')).toBe('project');
    /* Nothing usable in a non-Latin name must not produce an empty slug. */
    expect(slugify('پروژهٔ من')).toBe('project');
    expect(slugify('a'.repeat(60))).toBe('a'.repeat(24));
  });

  it('accepts generated ids and external registry ids, rejects everything else', () => {
    expect(isValidProjectId('prj-engine-core-3fa9c1d2')).toBe(true);
    expect(isValidProjectId('prj-a1')).toBe(true);

    for (const bad of [
      '',
      'project',
      'prj-',
      'prj-../evil',
      'prj-a/../b',
      'PRJ-ENGINE-3fa9c1d2',
      'prj-Engine-3fa9c1d2',
      'prj-engine-3fa9c1d2/../../etc',
      `prj-${'a'.repeat(100)}`,
    ]) {
      expect(isValidProjectId(bad)).toBe(false);
      expect(() => assertProjectId(bad)).toThrow(/Invalid project id/);
    }

    expect(assertProjectId('prj-engine-core-3fa9c1d2')).toBe('prj-engine-core-3fa9c1d2');
    expect(isValidProjectId(undefined)).toBe(false);
    expect(isValidProjectId(42)).toBe(false);
  });

  it('canonicalizes through symlinks so both registries hash the same path', () => {
    const real = makeTree(base, 'real-root');
    const link = path.join(base, 'link-root');
    fs.symlinkSync(real, link, 'dir');

    expect(assertProjectRoot(link)).toBe(real);
    expect(canonicalizeRoot(link)).toBe(real);
    expect(projectIdFor('app', assertProjectRoot(link))).toBe(projectIdFor('app', real));
  });

  it('falls back to the textual path when the root is not mounted', () => {
    const missing = path.join(base, 'not-here');
    expect(canonicalizeRoot(missing)).toBe(missing);
  });

  it('refuses a root that does not exist or is not a directory', () => {
    expect(() => assertProjectRoot('')).toThrow(/non-empty string/);
    expect(() => assertProjectRoot(path.join(base, 'missing'))).toThrow(/does not exist/);

    const file = path.join(base, 'a-file');
    fs.writeFileSync(file, 'x');
    expect(() => assertProjectRoot(file)).toThrow(/not a directory/);
  });
});

/*
| SE-IDENT-01 — املای درایو نباید شناسهٔ پروژه را عوض کند.
|
| اندازه‌گیری‌شده: یک مخزن با `I:\...` یک شناسه و با `i:\...` شناسهٔ
| دیگری می‌گرفت، یعنی دو پوشهٔ داده برای یک کد — و ابزار روی یکی
| ایندکسِ کهنه را بی‌خطا می‌خواند.
 */
describe('SE-IDENT-01 — normalizeDriveLetter', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-drive-case-')));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('حرفِ درایوِ کوچکِ ویندوز را بزرگ می‌کند', () => {
    expect(normalizeDriveLetter('i:\\repo\\app')).toBe('I:\\repo\\app');
    expect(normalizeDriveLetter('i:/repo/app')).toBe('I:/repo/app');
    expect(normalizeDriveLetter('c:\\')).toBe('C:\\');
  });

  it('شکلِ درست را دست نمی‌زند', () => {
    expect(normalizeDriveLetter('I:\\repo\\app')).toBe('I:\\repo\\app');
  });

  it('روی مسیرهای POSIX بزرگی/کوچکی را تغییر نمی‌دهد', () => {
    expect(normalizeDriveLetter('/srv/App')).toBe('/srv/App');
    expect(normalizeDriveLetter('./rel')).toBe('./rel');
    expect(normalizeDriveLetter('')).toBe('');
  });

  it('دو املای یک ریشهٔ موجود، یک شناسه می‌دهند', () => {
    const real = makeTree(tmp, 'drive-case');
    // روی ویندوز tmp با حرفِ بزرگ شروع می‌شود؛ نسخهٔ کوچکِ همان مسیر را می‌سازیم
    const lower = real.charAt(0).toLowerCase() + real.slice(1);

    expect(canonicalizeRoot(lower)).toBe(canonicalizeRoot(real));
    expect(projectIdFor('app', canonicalizeRoot(lower))).toBe(projectIdFor('app', canonicalizeRoot(real)));
    expect(assertProjectRoot(lower)).toBe(assertProjectRoot(real));
  });
});
