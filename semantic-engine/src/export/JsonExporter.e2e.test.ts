import { JsonExporter } from './JsonExporter';
import { FileEntry, SymbolEntry } from '../core/types/project-index.types';
import { ScanResult } from '../scanner/WorkspaceScanner';
import { makeConfidence } from '../core/types/common.types';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

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

function createSymbol(id: string, fileId: string, kind: any, name: string): SymbolEntry {
  return {
    id,
    fileId,
    parentId: null,
    kind,
    name,
    fullyQualifiedName: `${fileId}::${name}`,
    signature: name,
    visibility: 'public',
    line: 1,
    endLine: 1,
    documentation: null,
    source: 'lsp',
    confidence: makeConfidence(85),
  } as SymbolEntry;
}

describe('JsonExporter E2E', () => {
  it('should produce a valid project-index.json and pass the validator', async () => {
    const file = createFile('file1', 'src/extension.ts');
    const sym = createSymbol('s1', 'file1', 'function', 'activate');

    const scanResult: ScanResult = {
      files: [{ ...file, metrics: { loc: 55 } }],
      languages: ['typescript'],
      scanDuration: 100,
      skippedCount: 0,
      errorCount: 0,
      diagnostics: [],
    };

    const outDir = path.join(__dirname, '..', '..', 'tmp-test');
    fs.mkdirSync(outDir, { recursive: true });
    const outputPath = path.join(outDir, 'project-index.json');

    const exporter = new JsonExporter();
    await exporter.export(scanResult, [sym], {
      outputPath,
      workspaceRoot: '/home/user/project',
      pretty: true,
    });

    const validatorPath = path.join(__dirname, '..', '..', 'scripts', 'validate-project-index.js');
    const output = execSync(`node ${validatorPath} ${outputPath}`, { encoding: 'utf8' });

    expect(output).toContain('Validation passed');

    // Cleanup
    fs.rmSync(outDir, { recursive: true, force: true });
  });
});
