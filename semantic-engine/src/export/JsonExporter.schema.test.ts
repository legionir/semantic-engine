import { JsonExporter } from './JsonExporter';
import { FileEntry, SymbolEntry } from '../core/types/project-index.types';
import { ScanResult } from '../scanner/WorkspaceScanner';
import { makeConfidence } from '../core/types/common.types';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

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

function createSymbol(id: string, fileId: string, kind: any, name: string, testIds?: string[]): SymbolEntry {
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
    testIds,
  } as SymbolEntry;
}

describe('JsonExporter schema validation', () => {
  it('should produce a project-index.json that validates against project-index.schema.json', async () => {
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

    const outDir = path.join(__dirname, '..', '..', 'tmp-schema-test');
    fs.mkdirSync(outDir, { recursive: true });
    const outputPath = path.join(outDir, 'project-index.json');

    const exporter = new JsonExporter();
    await exporter.export(scanResult, [sym], {
      outputPath,
      workspaceRoot: '/home/user/project',
      pretty: true,
    });

    const validatorPath = path.join(__dirname, '..', '..', 'scripts', 'validate-schema.js');
    const output = execSync(
      `node ${validatorPath} project-index ${outputPath}`,
      { encoding: 'utf8' }
    );

    expect(output).toContain('validation passed');

    // Cleanup
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it('should validate project-index.json with Phase C fields', async () => {
    const file: FileEntry = {
      ...createFile('file1', 'src/config.ts'),
      gitMetrics: {
        commitCount: 10,
        lastCommitDate: new Date().toISOString(),
        lastCommitHash: 'abc123',
        topContributors: [{ author: 'Alice', email: 'Alice'.toLowerCase() + '@example.com', commitCount: 7 }],
        hotspotScore: 42,
        churnRank: 1,
      },
      configUsages: [
        { kind: 'env', key: 'PORT', line: 1, context: 'const port = process.env.PORT;' },
      ],
    };
    const sym = createSymbol('s1', 'file1', 'function', 'activate', ['test1']);

    const scanResult: ScanResult = {
      files: [file],
      languages: ['typescript'],
      scanDuration: 100,
      skippedCount: 0,
      errorCount: 0,
      diagnostics: [],
    };

    const outDir = path.join(__dirname, '..', '..', 'tmp-schema-test-phase-c');
    fs.mkdirSync(outDir, { recursive: true });
    const outputPath = path.join(outDir, 'project-index.json');

    const exporter = new JsonExporter();
    await exporter.export(scanResult, [sym], {
      outputPath,
      workspaceRoot: '/home/user/project',
      pretty: true,
    });

    const validatorPath = path.join(__dirname, '..', '..', 'scripts', 'validate-schema.js');
    const output = execSync(
      `node ${validatorPath} project-index ${outputPath}`,
      { encoding: 'utf8' }
    );

    expect(output).toContain('validation passed');

    fs.rmSync(outDir, { recursive: true, force: true });
  });
});
