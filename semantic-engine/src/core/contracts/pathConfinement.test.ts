import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { confinePathSync, isDeniedPath, isInside, resolveLexical } from './pathConfinement';
import { SourceSecurityGuard } from '../../services/source/SourceSecurityGuard';

describe('pathConfinement', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pc-root-')));
    outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pc-out-')));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'x');
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('isInside treats root as inside and siblings as outside', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true);
    expect(isInside('/a/b', '/a/b/c')).toBe(true);
    expect(isInside('/a/b', '/a/bc')).toBe(false);
    expect(isInside('/a/b', '/a')).toBe(false);
  });

  it('resolveLexical rejects empty, NUL and escaping paths without I/O', () => {
    expect(resolveLexical(root, '').ok).toBe(false);
    expect(resolveLexical(root, 'a\0b')).toMatchObject({ ok: false, failure: 'nul' });
    expect(resolveLexical(root, '../x')).toMatchObject({ ok: false, failure: 'escape' });
    expect(resolveLexical(root, 'src/a.ts')).toMatchObject({ ok: true });
  });

  it('confinePathSync allows a not-yet-created file unless mustExist', () => {
    expect(confinePathSync(root, 'src/new/b.ts').ok).toBe(true);
    expect(confinePathSync(root, 'src/new/b.ts', { mustExist: true })).toMatchObject({ ok: false, failure: 'missing' });
    expect(confinePathSync(root, 'src/a.ts', { mustExist: true }).ok).toBe(true);
  });

  it('refuses a write below a symlinked ancestor that points outside', () => {
    fs.symlinkSync(outside, path.join(root, 'link'));
    expect(confinePathSync(root, 'link/new.ts')).toMatchObject({ ok: false, failure: 'symlink' });
  });

  it('applies the secret/.git denylist to the sync boundary too', () => {
    expect(isDeniedPath('config/.env')).toBe(true);
    expect(confinePathSync(root, '.env')).toMatchObject({ ok: false, failure: 'denied' });
    expect(confinePathSync(root, '.git/config')).toMatchObject({ ok: false, failure: 'denied' });
    expect(new SourceSecurityGuard().validateRelativePath(root, 'certs/server.pem').ok).toBe(false);
    expect(new SourceSecurityGuard().validateRelativePath(root, 'src/a.ts').ok).toBe(true);
  });
});
