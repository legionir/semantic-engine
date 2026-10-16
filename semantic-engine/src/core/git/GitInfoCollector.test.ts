/**
 * تست GitInfoCollector — جمع‌آوری GitInfo و driftScore.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { GitInfoCollector } from './GitInfoCollector';

describe('GitInfoCollector', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-engine-gitinfo-'));
    execSync('git init', { cwd: repoRoot });
    execSync('git config init.defaultBranch main', { cwd: repoRoot });
    execSync('git config user.email "test@test.com"', { cwd: repoRoot });
    execSync('git config user.name "Test"', { cwd: repoRoot });

    fs.writeFileSync(path.join(repoRoot, 'file1.ts'), 'export const a = 1;', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'file2.ts'), 'export const b = 2;', 'utf8');
    execSync('git add .', { cwd: repoRoot });
    execSync('git commit -m "initial"', { cwd: repoRoot });
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('should collect git info and zero drift on clean repo', async () => {
    const collector = new GitInfoCollector(repoRoot);
    const result = await collector.collect(['file1.ts', 'file2.ts']);

    expect(result.gitInfo).not.toBeNull();
    expect(['main', 'master']).toContain(result.gitInfo!.branch);
    expect(result.gitInfo!.isDirty).toBe(false);
    expect(result.driftScore).toBe(0);
    expect(result.driftedFilePaths).toHaveLength(0);
  });

  it('should detect drift when a file changes', async () => {
    fs.writeFileSync(path.join(repoRoot, 'file1.ts'), 'export const a = 2;', 'utf8');

    const collector = new GitInfoCollector(repoRoot);
    const result = await collector.collect(['file1.ts', 'file2.ts']);

    expect(result.gitInfo!.isDirty).toBe(true);
    expect(result.driftedFilePaths).toContain('file1.ts');
    expect(result.driftScore).toBe(0.5);
  });

  it('should return null git info for non-git directory', async () => {
    const nonGitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-engine-nogitinfo-'));
    const collector = new GitInfoCollector(nonGitRoot);
    const result = await collector.collect([]);

    expect(result.gitInfo).toBeNull();
    expect(result.driftScore).toBe(0);

    fs.rmSync(nonGitRoot, { recursive: true, force: true });
  });

  it('should collect file-level git metrics', async () => {
    // چند commit برای file1.ts و یکی برای file2.ts
    fs.writeFileSync(path.join(repoRoot, 'file1.ts'), 'export const a = 2;', 'utf8');
    execSync('git add .', { cwd: repoRoot });
    execSync('git commit -m "update file1"', { cwd: repoRoot });

    fs.writeFileSync(path.join(repoRoot, 'file1.ts'), 'export const a = 3;', 'utf8');
    execSync('git add .', { cwd: repoRoot });
    execSync('git commit -m "update file1 again"', { cwd: repoRoot });

    const collector = new GitInfoCollector(repoRoot);
    const result = await collector.collectFileMetrics(['file1.ts', 'file2.ts']);

    const file1Metrics = result.metricsByPath.get('file1.ts');
    const file2Metrics = result.metricsByPath.get('file2.ts');

    expect(file1Metrics).toBeDefined();
    expect(file2Metrics).toBeDefined();

    expect(file1Metrics!.commitCount).toBeGreaterThanOrEqual(file2Metrics!.commitCount);
    expect(file1Metrics!.churnRank).toBe(1);
    expect(file2Metrics!.churnRank).toBe(2);
    expect(file1Metrics!.hotspotScore).toBeGreaterThanOrEqual(0);
    expect(file1Metrics!.topContributors).toHaveLength(1);
    expect(file1Metrics!.topContributors![0]!.author).toBe('Test');

    expect(result.maxCommitCount).toBeGreaterThanOrEqual(file1Metrics!.commitCount);
  });

  it('should return empty file metrics for non-git directory', async () => {
    const nonGitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-engine-nogitmetrics-'));
    const collector = new GitInfoCollector(nonGitRoot);
    const result = await collector.collectFileMetrics(['file1.ts']);

    expect(result.metricsByPath.size).toBe(0);
    expect(result.maxCommitCount).toBe(0);

    fs.rmSync(nonGitRoot, { recursive: true, force: true });
  });
});
