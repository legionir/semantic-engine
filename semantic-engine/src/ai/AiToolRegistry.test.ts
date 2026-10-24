import { AiToolRegistry } from './AiToolRegistry';
import { ProjectIndexReader } from './ProjectIndexReader';
import { ProjectIndex, SymbolEntry, FileEntry } from '../core/types/project-index.types';
import { makeConfidence } from '../core/types/common.types';

function createSymbol(id: string, fileId: string, name: string, kind: any, opts: Partial<SymbolEntry> = {}): SymbolEntry {
  return {
    id,
    fileId,
    parentId: null,
    kind,
    name,
    fullyQualifiedName: `${fileId}::${name}`,
    line: 1,
    endLine: 1,
    source: 'lsp',
    confidence: makeConfidence(85),
    ...opts,
  } as SymbolEntry;
}

function createFile(id: string, path: string, language: string | null, opts: Partial<FileEntry> = {}): FileEntry {
  return {
    id,
    path,
    language,
    encoding: 'utf8',
    size: 100,
    lines: 10,
    hash: 'abc',
    modified: new Date().toISOString(),
    binary: false,
    testFile: false,
    generated: false,
    ...opts,
  } as FileEntry;
}

function createProjectIndex(): ProjectIndex {
  const files: FileEntry[] = [
    createFile('f1', 'src/userService.ts', 'typescript', {
      imports: [{ from: './userRepository', type: 'local', resolvedFileId: 'f2' }],
      exports: [{ name: 'UserService', kind: 'named' }],
    }),
    createFile('f2', 'src/userRepository.ts', 'typescript', {
      exports: [{ name: 'UserRepository', kind: 'named' }],
    }),
    createFile('f3', 'src/userService.test.ts', 'typescript', { testFile: true }),
  ];

  const symbols: SymbolEntry[] = [
    createSymbol('s1', 'f1', 'UserService', 'class', { exported: true }),
    createSymbol('s2', 'f1', 'findUser', 'method', { parentId: 's1', signature: 'findUser(id: string)' }),
    createSymbol('s3', 'f2', 'UserRepository', 'class', { exported: true }),
  ];

  return {
    schemaVersion: '2.0.0',
    root: '/project',
    generatedAt: new Date().toISOString(),
    languages: ['typescript'],
    files,
    symbols,
    graphs: {
      callGraph: [],
      typeGraph: [],
      dependencyGraph: [
        { from: 'f1', to: 'f2', kind: 'import', provenance: { extractor: 'heuristic', confidence: 95, basis: 'ast' } },
      ],
      reverseDependencyGraph: [
        { from: 'f2', to: 'f1', kind: 'imported-by', provenance: { extractor: 'heuristic', confidence: 95, basis: 'ast' } },
      ],
    },
    diagnostics: [],
    metrics: {
      totalFiles: 3,
      totalLoc: 30,
      totalSymbols: 3,
      avgCyclomaticComplexity: 1,
      languageBreakdown: { typescript: 3 },
    },
  };
}

describe('AiToolRegistry', () => {
  const index = createProjectIndex();
  const reader = new ProjectIndexReader(index);
  const registry = new AiToolRegistry({ reader });

  it('should list all tools', () => {
    const tools = registry.list();
    expect(tools.map(t => t.name)).toContain('find_symbol');
    expect(tools.map(t => t.name)).toContain('get_dependencies');
    expect(tools.map(t => t.name)).toContain('semantic_search');
    expect(tools.map(t => t.name)).toContain('assemble_context');
    expect(tools.map(t => t.name)).toContain('impact_analysis');
    expect(tools.map(t => t.name)).toContain('find_tests');
    expect(tools.map(t => t.name)).toContain('get_file_summary');
    /* ابزار SQL خام حذف شده است؛ نباید ثبت شود. */
    expect(tools.map(t => t.name)).not.toContain('query_index');
    expect(tools.map(t => t.name)).toContain('get_recent_changes');
  });

  it('find_symbol should find by name', async () => {
    const result = await registry.execute('find_symbol', { name: 'UserService' });
    expect(result.success).toBe(true);
    expect(result.items.map(i => i.name)).toContain('UserService');
  });

  it('get_dependencies should return reverse deps', async () => {
    const result = await registry.execute('get_dependencies', { id: 'f2', direction: 'backward' });
    expect(result.success).toBe(true);
    expect(result.items.map(i => i.id)).toContain('f1');
  });

  it('get_file_summary should summarize file', async () => {
    const result = await registry.execute('get_file_summary', { path: 'src/userService.ts' });
    expect(result.success).toBe(true);
    expect(result.context).toContain('src/userService.ts');
  });

  it('semantic_search should find relevant symbols', async () => {
    const result = await registry.execute('semantic_search', { query: 'find user' });
    expect(result.success).toBe(true);
    expect(result.items.length).toBeGreaterThan(0);
  });

  it('impact_analysis should identify impacted files', async () => {
    const result = await registry.execute('impact_analysis', { id: 'f2' });
    expect(result.success).toBe(true);
    expect(result.items.map(i => i.id)).toContain('f1');
  });

  it('find_tests should find related test', async () => {
    const result = await registry.execute('find_tests', { path: 'src/userService.ts' });
    expect(result.success).toBe(true);
    expect(result.items.map(i => i.name)).toContain('src/userService.test.ts');
  });

  it('assemble_context should gather context', async () => {
    const result = await registry.execute('assemble_context', {
      task: 'Update user registration',
      targetFiles: ['src/userService.ts'],
    });
    expect(result.success).toBe(true);
    expect(result.context).toContain('src/userService.ts');
  });
});
