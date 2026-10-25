/**
 * تست AiMetadataGenerator: بررسی تولید metadata هیوریستیک.
 */

import { AiMetadataGenerator } from './AiMetadataGenerator';
import { FileEntry, SymbolEntry, DependencyEdge } from '../core/types/project-index.types';
import { makeConfidence } from '../core/types/common.types';

function createFile(id: string, filePath: string, overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    id,
    path: filePath,
    language: 'typescript',
    encoding: 'utf8',
    size: 1000,
    lines: 50,
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
    ...overrides,
  };
}

function createSymbol(id: string, fileId: string, name: string, kind: any, line: number): SymbolEntry {
  return {
    id,
    fileId,
    parentId: null,
    kind,
    name,
    line,
    endLine: line + 2,
    source: 'lsp',
    confidence: makeConfidence(85),
  } as SymbolEntry;
}

describe('AiMetadataGenerator', () => {
  it('should detect frameworks from imports', () => {
    const file = createFile('f1', 'src/app.ts', {
      imports: [
        { from: 'express', type: 'package' },
        { from: 'react', type: 'package' },
      ],
    });

    const generator = new AiMetadataGenerator();
    const result = generator.generate({
      workspaceRoot: '/tmp',
      files: [file],
      symbols: [],
      dependencyGraph: [],
    });

    const meta = result.get('f1')!;
    expect(meta.frameworks).toContain('Express');
    expect(meta.frameworks).toContain('React');
  });

  it('should detect design patterns from path and symbols', () => {
    const file = createFile('f1', 'src/repositories/userRepository.ts', {
      exports: [{ name: 'UserRepository', kind: 'named' }],
    });
    const symbol = createSymbol('s1', 'f1', 'UserRepository', 'class', 1);

    const generator = new AiMetadataGenerator();
    const result = generator.generate({
      workspaceRoot: '/tmp',
      files: [file],
      symbols: [symbol],
      dependencyGraph: [],
    });

    const meta = result.get('f1')!;
    expect(meta.designPatterns).toContain('Repository');
  });

  it('should detect business domains from path and exports', () => {
    const file = createFile('f1', 'src/services/orderService.ts', {
      exports: [{ name: 'createOrder', kind: 'named' }],
    });

    const generator = new AiMetadataGenerator();
    const result = generator.generate({
      workspaceRoot: '/tmp',
      files: [file],
      symbols: [],
      dependencyGraph: [],
    });

    const meta = result.get('f1')!;
    expect(meta.businessDomains).toContain('Order & Commerce');
  });

  it('should compute aiScore with entry point bonus', () => {
    const entryFile = createFile('f1', 'src/index.ts', {
      exports: [{ name: 'main', kind: 'named' }],
    });
    const normalFile = createFile('f2', 'src/utils.ts');

    const generator = new AiMetadataGenerator();
    const result = generator.generate({
      workspaceRoot: '/tmp',
      files: [entryFile, normalFile],
      symbols: [],
      dependencyGraph: [],
    });

    const entryMeta = result.get('f1')!;
    const normalMeta = result.get('f2')!;
    expect(entryMeta.aiScore!.importance).toBeGreaterThan(normalMeta.aiScore!.importance);
  });

  it('should relate files via dependencyGraph', () => {
    const fileA = createFile('fa', 'src/a.ts', {
      imports: [{ from: './b', type: 'local', resolvedFileId: 'fb' }],
    });
    const fileB = createFile('fb', 'src/b.ts');

    const dependencyGraph: DependencyEdge[] = [
      { from: 'fa', to: 'fb', kind: 'import', provenance: { extractor: 'heuristic', confidence: 95, basis: 'ast' } },
    ];

    const generator = new AiMetadataGenerator();
    const result = generator.generate({
      workspaceRoot: '/tmp',
      files: [fileA, fileB],
      symbols: [],
      dependencyGraph,
    });

    expect(result.get('fa')!.relatedFileIds).toContain('fb');
    expect(result.get('fb')!.relatedFileIds).toContain('fa');
  });

  it('should include estimatedTokenCost based on file size', () => {
    const file = createFile('f1', 'src/a.ts', { lines: 10, size: 400 });

    const generator = new AiMetadataGenerator();
    const result = generator.generate({
      workspaceRoot: '/tmp',
      files: [file],
      symbols: [],
      dependencyGraph: [],
    });

    expect(result.get('f1')!.estimatedTokenCost).toBeGreaterThan(0);
  });
});

/*
| SE-AI-08 — `relatedFileIds` نام پکیج‌های خارجی را در خود داشت.
|
| کامنت کد می‌گفت «فقط dependencyهای local» ولی هیچ فیلتری روی
| `edge.kind` نبود، و چون یال‌های package مقدار `to = "react"` دارند،
| `relatedFileIds` با رشته‌هایی مثل `react` و `fs` پر می‌شد که هیچ
| فایلی با آن شناسه وجود ندارد.
|
| فاز ۱۹ این را به‌عنوان SE-AI-12 رفع کرد. اندازه‌گیری روی ایندکس
| واقعی امروز: از ۱٬۸۶۴ ورودیِ `relatedFileIds`، صفر تا شناسهٔ نامعتبر.
| این آزمون قفلش می‌کند تا رگرسیون بی‌صدا نباشد — معیار پذیرش فاز ۴۵
| هم صریحاً همین است.
*/
describe('AiMetadataGenerator — relatedFileIds فقط fileId معتبر (SE-AI-08)', () => {
  it('معیار پذیرش: نام پکیج وارد relatedFileIds نمی‌شود', () => {
    const files = [
      { id: 'f1', path: 'src/a.ts', language: 'typescript', size: 10, lines: 5, hash: 'h',
        binary: false, testFile: false, symbolIds: [], imports: [], exports: [],
        diagnostics: [], outline: [] },
      { id: 'f2', path: 'src/b.ts', language: 'typescript', size: 10, lines: 5, hash: 'h',
        binary: false, testFile: false, symbolIds: [], imports: [], exports: [],
        diagnostics: [], outline: [] },
    ] as unknown as FileEntry[];

    const dependencyGraph = [
      { from: 'f1', to: 'f2', kind: 'import' },
      { from: 'f1', to: 'react', kind: 'package' },
      { from: 'f1', to: 'fs', kind: 'package' },
      { from: 'f1', to: 'node:path', kind: 'package' },
    ] as unknown as DependencyEdge[];

    const generated = new AiMetadataGenerator().generate({
      workspaceRoot: '/tmp/fixture',
      files,
      symbols: [],
      dependencyGraph,
    });

    const related = generated.get('f1')!.relatedFileIds ?? [];
    const validIds = new Set(files.map(f => f.id));

    expect(related).toEqual(['f2']);
    for (const id of related) {
      expect(validIds.has(id)).toBe(true);
    }
  });

  it('یال معکوس هم فیلتر می‌شود', () => {
    const files = [
      { id: 'f1', path: 'src/a.ts', language: 'typescript', size: 10, lines: 5, hash: 'h',
        binary: false, testFile: false, symbolIds: [], imports: [], exports: [],
        diagnostics: [], outline: [] },
    ] as unknown as FileEntry[];

    const generated = new AiMetadataGenerator().generate({
      workspaceRoot: '/tmp/fixture',
      files,
      symbols: [],
      dependencyGraph: [{ from: 'lodash', to: 'f1', kind: 'package' }] as unknown as DependencyEdge[],
    });

    expect(generated.get('f1')!.relatedFileIds ?? []).toEqual([]);
  });

  it('tokens that name Object.prototype members (constructor, valueOf) do not crash keyword extraction', () => {
    const files = [
      createFile('f1', 'src/isConstructorNode.ts', {
        exports: [
          { name: 'isConstructorNode', kind: 'function' },
          { name: 'toString', kind: 'function' },
          { name: 'valueOf', kind: 'function' },
        ] as unknown as FileEntry['exports'],
      }),
    ];

    const generated = new AiMetadataGenerator().generate({
      workspaceRoot: '/tmp/fixture',
      files,
      symbols: [],
      dependencyGraph: [],
    });

    const metadata = generated.get('f1')!;
    expect(metadata.businessDomains ?? []).toEqual([]);
    expect(metadata.keywords).toEqual(expect.arrayContaining(['constructor', 'value']));
  });
});
