import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { WorkspaceScanner } from '../scanner/WorkspaceScanner';
import { TSDependencyExtractor } from '../dependencies/typescript/TSDependencyExtractor';
import { TSPathResolver } from '../dependencies/typescript/TSPathResolver';
import { DependencyExtractorManager } from '../dependencies/DependencyExtractorManager';
import { JsonExporter, DependencyResult, GraphResult } from '../export/JsonExporter';
import { ImportEntry, FileEntry } from '../core/types/project-index.types';
import { CallGraphBuilder, TypeGraphBuilder, DependencyGraphBuilder } from '../graphs';

const fixtureRoot = path.join(__dirname, '..', '..', 'test-fixture');
const outDir = path.join(__dirname, '..', '..', 'tmp-phase4-test');
const outputPath = path.join(outDir, 'project-index.json');

describe('Phase 4 — Dependency + Graph end-to-end', () => {
  let index: any;

  beforeAll(async () => {
    fs.mkdirSync(outDir, { recursive: true });

    const scanner = new WorkspaceScanner(fixtureRoot, {
      skipHiddenDirectories: false,
    });
    const scanResult = await scanner.scan();
    if (!scanResult.ok) throw new Error(scanResult.error.message);

    const depManager = new DependencyExtractorManager();
    depManager.register(new TSDependencyExtractor());

    const dependencies: DependencyResult[] = [];
    const pathResolver = new TSPathResolver(fixtureRoot);
    const { files } = scanResult.value;

    for (const file of files) {
      if (file.binary || !file.language) continue;
      if (!await depManager.hasExtractorFor(file.language)) continue;

      const content = fs.readFileSync(path.join(fixtureRoot, file.path), 'utf8');
      const result = await depManager.extract(file.id, file.path, content, file.language);
      if (!result.ok) continue;

      const resolvedImports = result.value.imports.map((imp: ImportEntry) => {
        if (imp.type !== 'local') return imp;
        const resolvedPath = pathResolver.resolve(imp.from, file.path);
        if (!resolvedPath) return imp;
        const target = files.find(f => f.path === resolvedPath || f.path === resolvedPath.replace(/^\.\//, ''));
        return target ? { ...imp, resolvedFileId: target.id } : imp;
      });

      dependencies.push({
        fileId: file.id,
        imports: resolvedImports,
        exports: result.value.exports,
      });
    }

    const filesWithDeps = files.map(file => {
      const dep = dependencies.find(d => d.fileId === file.id);
      return dep ? { ...file, imports: dep.imports, exports: dep.exports } : file;
    });

    const graphs: GraphResult = {
      callGraph: new CallGraphBuilder({ workspaceRoot: fixtureRoot, files: filesWithDeps, symbols: [] }).build(),
      typeGraph: new TypeGraphBuilder([]).build(),
      dependencyGraph: new DependencyGraphBuilder(filesWithDeps).build(),
    };

    const exporter = new JsonExporter();
    await exporter.export(scanResult.value, [], {
      outputPath,
      workspaceRoot: fixtureRoot,
      pretty: true,
    }, dependencies, graphs);

    index = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  });

  afterAll(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it('should produce a valid project-index.json', () => {
    const validatorPath = path.join(__dirname, '..', '..', 'scripts', 'validate-schema.js');
    const output = execSync(
      `node ${validatorPath} project-index ${outputPath}`,
      { encoding: 'utf8' }
    );
    expect(output).toContain('validation passed');
  });

  it('should populate imports/exports on TS/JS files', () => {
    const tsFile = index.files.find((f: FileEntry) => f.path === 'src/app.ts');
    expect(tsFile).toBeDefined();
    expect(tsFile.imports.length).toBeGreaterThan(0);
    expect(tsFile.exports.length).toBeGreaterThan(0);
  });

  it('should resolve local imports to file ids', () => {
    const tsFile = index.files.find((f: FileEntry) => f.path === 'src/app.ts');
    const localImports = tsFile.imports.filter((i: ImportEntry) => i.type === 'local');

    expect(localImports.length).toBeGreaterThan(0);
    for (const imp of localImports) {
      expect(imp.resolvedFileId).not.toBeNull();
      expect(index.files.some((f: FileEntry) => f.id === imp.resolvedFileId)).toBe(true);
    }
  });

  it('should populate dependencyGraph with edges', () => {
    expect(index.graphs.dependencyGraph.length).toBeGreaterThan(0);
  });

  it('should detect package imports as package kind', () => {
    const hasPackage = index.files.some((f: FileEntry) =>
      f.imports?.some((i: ImportEntry) => i.type === 'package')
    );
    expect(hasPackage).toBe(true);
  });
});
