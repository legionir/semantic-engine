/**
 * تست BlueprintGenerator: بررسی تولید blueprint.json معتبر از project-index.json
 */

import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { WorkspaceScanner } from '../scanner/WorkspaceScanner';
import { TSDependencyExtractor } from '../dependencies/typescript/TSDependencyExtractor';
import { TSPathResolver } from '../dependencies/typescript/TSPathResolver';
import { DependencyExtractorManager } from '../dependencies/DependencyExtractorManager';
import { JsonExporter, DependencyResult, GraphResult } from '../export/JsonExporter';
import { BlueprintExporter } from '../export/BlueprintExporter';
import { ImportEntry, FileEntry } from '../core/types/project-index.types';
import { CallGraphBuilder, TypeGraphBuilder, DependencyGraphBuilder } from '../graphs';

const fixtureRoot = path.join(__dirname, '..', '..', 'test-fixture');
const outDir = path.join(__dirname, '..', '..', 'tmp-phase6-test');
const projectIndexPath = path.join(outDir, 'project-index.json');
const blueprintPath = path.join(outDir, 'blueprint.json');

describe('Phase 6 — BlueprintGenerator end-to-end', () => {
  let projectIndex: any;

  beforeAll(async () => {
    fs.mkdirSync(outDir, { recursive: true });

    const scanner = new WorkspaceScanner(fixtureRoot, { skipHiddenDirectories: false });
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
      outputPath: projectIndexPath,
      workspaceRoot: fixtureRoot,
      pretty: true,
    }, dependencies, graphs);

    projectIndex = JSON.parse(fs.readFileSync(projectIndexPath, 'utf8'));

    const blueprintExporter = new BlueprintExporter();
    await blueprintExporter.export(projectIndex, {
      outputPath: blueprintPath,
      pretty: true,
    });
  });

  afterAll(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it('should produce a valid blueprint.json', () => {
    const validatorPath = path.join(__dirname, '..', '..', 'scripts', 'validate-schema.js');
    const output = execSync(
      `node ${validatorPath} blueprint ${blueprintPath}`,
      { encoding: 'utf8' }
    );
    expect(output).toContain('validation passed');
  });

  it('should derive moduleMap from directory structure', () => {
    const blueprint = JSON.parse(fs.readFileSync(blueprintPath, 'utf8'));
    expect(blueprint.moduleMap.length).toBeGreaterThan(0);

    const servicesModule = blueprint.moduleMap.find((m: any) => m.path === 'src/services');
    expect(servicesModule).toBeDefined();
    expect(servicesModule.fileIds.length).toBeGreaterThan(0);
  });

  it('should include file and module nodes in dependencyGraph', () => {
    const blueprint = JSON.parse(fs.readFileSync(blueprintPath, 'utf8'));
    expect(blueprint.dependencyGraph.nodes.length).toBeGreaterThan(0);
    expect(blueprint.dependencyGraph.nodes.some((n: any) => n.kind === 'file')).toBe(true);
    expect(blueprint.dependencyGraph.nodes.some((n: any) => n.kind === 'module')).toBe(true);
  });

  it('should build symbolIndex from project-index symbols', () => {
    const blueprint = JSON.parse(fs.readFileSync(blueprintPath, 'utf8'));
    expect(Array.isArray(blueprint.symbolIndex)).toBe(true);
  });

  it('should link blueprint meta to source project-index', () => {
    const blueprint = JSON.parse(fs.readFileSync(blueprintPath, 'utf8'));
    expect(blueprint.meta.sourceProjectIndex.schemaVersion).toBe(projectIndex.schemaVersion);
    expect(blueprint.meta.sourceProjectIndex.generatedAt).toBe(projectIndex.generatedAt);
    expect(blueprint.meta.sourceProjectIndex.fileCountAtSync).toBe(projectIndex.files.length);
  });
});
