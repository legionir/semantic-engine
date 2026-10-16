import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SourceSecurityGuard } from './SourceSecurityGuard';
import { SourceSyncService } from './SourceSyncService';

describe('Source sync security and atomic bundle writes', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-source-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('rejects a bundle path that traverses an external symlink', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-outside-'));
    const link = path.join(root, 'linked');
    try {
      fs.symlinkSync(outside, link, 'dir');
      const result = new SourceSecurityGuard().validateRelativePath(root, 'linked/secret.txt');
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/symlink/i);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('validates and writes a bundle as a complete staged update', async () => {
    const service = new SourceSyncService();
    const result = await service.importBundle('p1', root, {
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
    });

    expect(result.filesSynced).toBe(2);
    expect(fs.readFileSync(path.join(root, 'src/a.ts'), 'utf8')).toContain('a = 1');
    expect(fs.readFileSync(path.join(root, 'src/b.ts'), 'utf8')).toContain('b = 2');
    expect(fs.readdirSync(root).some(name => name.startsWith('.source-sync-'))).toBe(false);
  });
});
