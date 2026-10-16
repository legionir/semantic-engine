import * as path from 'path';
import * as fs from 'fs';
import { TSPathResolver } from './TSPathResolver';

describe('TSPathResolver', () => {
  const tmpDir = path.join(__dirname, '..', '..', '..', 'tmp-resolver-test');

  beforeAll(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src', 'core'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src', 'services'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src', 'utils'), { recursive: true });

    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        baseUrl: '.',
        paths: {
          '@app/*': ['src/*'],
        },
      },
    }));

    fs.writeFileSync(path.join(tmpDir, 'src', 'core', 'types.ts'), 'export interface User {}');
    fs.writeFileSync(path.join(tmpDir, 'src', 'services', 'api.ts'), 'export class ApiClient {}');
    fs.writeFileSync(path.join(tmpDir, 'src', 'utils', 'index.ts'), 'export const x = 1');
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should resolve relative local imports', () => {
    const resolver = new TSPathResolver(tmpDir);
    const resolved = resolver.resolve('../core/types', 'src/services/user.ts');
    expect(resolved).toBe('src/core/types.ts');
  });

  it('should resolve tsconfig path aliases', () => {
    const resolver = new TSPathResolver(tmpDir);
    const resolved = resolver.resolve('@app/core/types', 'src/services/api.ts');
    expect(resolved).toBe('src/core/types.ts');
  });

  it('should resolve index files', () => {
    const resolver = new TSPathResolver(tmpDir);
    const resolved = resolver.resolve('../utils', 'src/services/api.ts');
    expect(resolved).toBe('src/utils/index.ts');
  });

  it('should return null for unresolved paths', () => {
    const resolver = new TSPathResolver(tmpDir);
    const resolved = resolver.resolve('./missing-file', 'src/services/api.ts');
    expect(resolved).toBeNull();
  });
});
