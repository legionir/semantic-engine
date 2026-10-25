import * as path from 'path';
import * as fs from 'fs';
import { ReExportResolver } from './ReExportResolver';
import { TSPathResolver } from './TSPathResolver';
import { FileEntry, SymbolEntry } from '../../core/types/project-index.types';
import { makeConfidence } from '../../core/types/common.types';

const tmpDir = path.join(__dirname, '..', '..', '..', 'tmp-reexport-resolver-test');

describe('ReExportResolver', () => {
  beforeAll(() => {
    fs.mkdirSync(path.join(tmpDir, 'src', 'core'), { recursive: true });

    fs.writeFileSync(path.join(tmpDir, 'src', 'core', 'types.ts'), 'export interface User {}\nexport class UserModel {}');
    fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), `export { User } from './core/types';\nexport * from './core/types';`);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createFile(id: string, filePath: string): FileEntry {
    return {
      id,
      path: filePath,
      language: 'typescript',
      encoding: 'utf8',
      size: 100,
      lines: 10,
      hash: 'abc',
      modified: new Date().toISOString(),
      binary: false,
      testFile: false,
      generated: false,
      symbolIds: [],
      imports: [],
      exports: [],
      diagnostics: [],
      outline: [],
    };
  }

  function createSymbol(id: string, fileId: string, name: string, kind: any): SymbolEntry {
    return {
      id,
      fileId,
      parentId: null,
      kind,
      name,
      line: 1,
      endLine: 1,
      source: 'lsp',
      confidence: makeConfidence(85),
    } as SymbolEntry;
  }

  it('should resolve re-export source to fileId and symbolId', () => {
    const coreFile = createFile('f-core', 'src/core/types.ts');
    const indexFile = createFile('f-index', 'src/index.ts');

    const userSymbol = createSymbol('s-user', 'f-core', 'User', 'interface');
    const userModelSymbol = createSymbol('s-model', 'f-core', 'UserModel', 'class');

    const dependencies = [
      {
        fileId: 'f-index',
        exports: [
          { name: 'User', kind: 're-export' as const, reExportFrom: './core/types' },
          { name: '*', kind: 'namespace' as const, reExportFrom: './core/types' },
        ],
      },
    ];

    const pathResolver = new TSPathResolver(tmpDir);
    const resolver = new ReExportResolver(tmpDir, [coreFile, indexFile], [userSymbol, userModelSymbol], pathResolver);
    const resolved = resolver.resolve(dependencies);

    expect(resolved).toHaveLength(2);

    const userReExport = resolved.find(r => r.export.name === 'User');
    expect(userReExport).toBeDefined();
    expect(userReExport!.resolvedFileId).toBe('f-core');
    expect(userReExport!.resolvedSymbolId).toBe('s-user');

    const namespaceReExport = resolved.find(r => r.export.name === '*');
    expect(namespaceReExport).toBeDefined();
    expect(namespaceReExport!.resolvedFileId).toBe('f-core');
    expect(namespaceReExport!.resolvedSymbolId).toBeNull();
  });

  it('should link local export symbolIds', () => {
    const coreFile = createFile('f-core', 'src/core/types.ts');

    const userSymbol = createSymbol('s-user', 'f-core', 'User', 'interface');

    const files: FileEntry[] = [
      {
        ...coreFile,
        exports: [{ name: 'User', kind: 'named' as const }],
      },
    ];

    const pathResolver = new TSPathResolver(tmpDir);
    const resolver = new ReExportResolver(tmpDir, files, [userSymbol], pathResolver);
    const linked = resolver.linkLocalExportSymbolIds(files);

    const linkedFile = linked[0]!;
    expect(linkedFile.exports).toBeDefined();
    const exports = linkedFile.exports!;
    expect(exports.length).toBeGreaterThan(0);
    expect(exports[0]!.symbolId).toBe('s-user');
  });
});
