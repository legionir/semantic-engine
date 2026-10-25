import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { WorkspaceScanner } from './WorkspaceScanner';
import { JsonExporter } from '../export/JsonExporter';

describe('Phase 1 — WorkspaceScanner fixture test', () => {
  const fixtureRoot = path.join(__dirname, '..', '..', 'test-fixture');
  const outDir = path.join(__dirname, '..', '..', 'tmp-phase1-test');
  const outputPath = path.join(outDir, 'project-index.json');

  beforeAll(async () => {
    fs.mkdirSync(outDir, { recursive: true });

    const scanner = new WorkspaceScanner(fixtureRoot, {
      skipHiddenDirectories: false,
    });
    const result = await scanner.scan();

    if (!result.ok) {
      throw new Error(`Scan failed: ${result.error.message}`);
    }

    const exporter = new JsonExporter();
    await exporter.export(result.value, [], {
      outputPath,
      workspaceRoot: fixtureRoot,
      pretty: true,
    });
  });

  afterAll(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it('should produce a project-index.json that validates against schema', () => {
    const validatorPath = path.join(__dirname, '..', '..', 'scripts', 'validate-schema.js');
    const output = execSync(
      `node ${validatorPath} project-index ${outputPath}`,
      { encoding: 'utf8' }
    );
    expect(output).toContain('validation passed');
  });

  it('should scan at least 50 files and detect at least 3 languages', () => {
    const index = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    expect(index.files.length).toBeGreaterThanOrEqual(50);
    expect(index.languages.length).toBeGreaterThanOrEqual(3);
  });

  it('should skip node_modules and .git', () => {
    const index = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    const paths = index.files.map((f: { path: string }) => f.path);

    expect(paths).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^node_modules\//)])
    );
    expect(paths).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^\.git\//)])
    );
  });

  it('should not crash on binary files and include them as binary metadata', () => {
    const index = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    const binaryFile = index.files.find((f: { path: string; binary: boolean }) =>
      f.path === 'assets/logo.png'
    );

    expect(binaryFile).toBeDefined();
    expect(binaryFile.binary).toBe(true);
    expect(binaryFile.lines).toBe(0);
  });

  it('should detect TypeScript, JavaScript, Python, and other languages', () => {
    const index = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    expect(index.languages).toEqual(expect.arrayContaining(['typescript']));
    expect(index.languages).toEqual(expect.arrayContaining(['javascript']));
    expect(index.languages).toEqual(expect.arrayContaining(['python']));
  });
});
