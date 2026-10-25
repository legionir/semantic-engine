/**
 * تست GitClient با یک repository موقت واقعی.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { GitClient } from './GitClient';

describe('GitClient', () => {
  let repoRoot: string;
  let client: GitClient;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-engine-git-'));
    execSync('git init', { cwd: repoRoot });
    execSync('git config init.defaultBranch main', { cwd: repoRoot });
    execSync('git config user.email "test@test.com"', { cwd: repoRoot });
    execSync('git config user.name "Test"', { cwd: repoRoot });

    fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Hello', 'utf8');
    execSync('git add .', { cwd: repoRoot });
    execSync('git commit -m "initial"', { cwd: repoRoot });

    client = new GitClient(repoRoot);
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('should detect git repository', async () => {
    expect(await client.isGitRepository()).toBe(true);
  });

  it('should get current commit', async () => {
    const commit = await client.getCurrentCommit();
    expect(commit).not.toBeNull();
    expect(commit!.hash).toHaveLength(40);
    expect(commit!.shortHash).toHaveLength(7);
    expect(commit!.message).toBe('initial');
  });

  it('should get current branch', async () => {
    const branch = await client.getCurrentBranch();
    expect(['main', 'master']).toContain(branch);
  });

  it('should detect dirty status', async () => {
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'src', 'utils.ts'), 'export const x = 1;', 'utf8');

    const status = await client.getStatus();
    expect(status.isDirty).toBe(true);
    expect(status.untrackedFiles).toContain('src/utils.ts');
  });

  it('should return false for non-git directory', async () => {
    const nonGitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-engine-nogit-'));
    const nonGitClient = new GitClient(nonGitRoot);
    expect(await nonGitClient.isGitRepository()).toBe(false);
    fs.rmSync(nonGitRoot, { recursive: true, force: true });
  });

  it('should compute file commit stats', async () => {
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'src', 'utils.ts'), 'export const x = 1;', 'utf8');
    execSync('git add .', { cwd: repoRoot });
    execSync('git commit -m "add utils"', { cwd: repoRoot });

    fs.writeFileSync(path.join(repoRoot, 'src', 'utils.ts'), 'export const x = 2;\nexport const y = 3;', 'utf8');
    execSync('git add .', { cwd: repoRoot });
    execSync('git commit -m "update utils"', { cwd: repoRoot });

    const stats = await client.getFileCommitStats('src/utils.ts');

    expect(stats.commitCount).toBeGreaterThanOrEqual(2);
    expect(stats.lastCommit).not.toBeNull();
    expect(stats.lastCommit!.message).toBe('update utils');
    expect(stats.contributors).toHaveLength(1);
    expect(stats.contributors[0]!.author).toBe('Test');
    expect(stats.contributors[0]!.commitCount).toBeGreaterThanOrEqual(2);
  });

  it('should return empty stats for untracked file', async () => {
    fs.writeFileSync(path.join(repoRoot, 'new.ts'), 'export const z = 1;', 'utf8');
    const stats = await client.getFileCommitStats('new.ts');

    expect(stats.commitCount).toBe(0);
    expect(stats.lastCommit).toBeNull();
    expect(stats.contributors).toHaveLength(0);
  });

  /*
  | Arguments used to be interpolated into a shell string. Inside double
  | quotes a POSIX shell still expands $(...), so a path was enough to
  | run anything. Every argument here is attacker-shaped on purpose.
  */

  describe('argument handling', () => {

    it('does not let a path run a command', async () => {
      const marker = path.join(repoRoot, 'PWNED');

      await client.getFileLog(`$(touch ${marker})`);
      await client.getFileCommitStats(`\`touch ${marker}\``);
      await client.getFileContentAtCommit(`$(touch ${marker})`);
      await client.getChangedFilesSince(`$(touch ${marker})`);

      expect(fs.existsSync(marker)).toBe(false);
    });

    it('does not let a workspace path run a command', async () => {
      const marker = path.join(repoRoot, 'PWNED_CWD');

      const hostile = new GitClient(`${repoRoot}$(touch ${marker})`);

      await hostile.isGitRepository();

      expect(fs.existsSync(marker)).toBe(false);
    });

    it('reads a file whose name contains a space', async () => {
      fs.writeFileSync(path.join(repoRoot, 'two words.ts'), 'export const a = 1;', 'utf8');
      execSync('git add .', { cwd: repoRoot });
      execSync('git commit -m "spaced"', { cwd: repoRoot });

      const stats = await client.getFileCommitStats('two words.ts');

      expect(stats.commitCount).toBe(1);
      expect(stats.lastCommit!.message).toBe('spaced');
    });

    it('reads a file whose name is not ascii', async () => {
      fs.writeFileSync(path.join(repoRoot, 'مدل.ts'), 'export const b = 2;', 'utf8');
      execSync('git add .', { cwd: repoRoot });
      execSync('git commit -m "unicode"', { cwd: repoRoot });

      const stats = await client.getFileCommitStats('مدل.ts');

      expect(stats.commitCount).toBe(1);
    });
  });

  describe('status parsing', () => {

    it('reports a path that contains a space', async () => {
      fs.writeFileSync(path.join(repoRoot, 'with space.ts'), 'export const c = 3;', 'utf8');

      const status = await client.getStatus();

      expect(status.untrackedFiles).toContain('with space.ts');
      expect(status.isDirty).toBe(true);
    });

    it('reports a non-ascii path', async () => {
      fs.writeFileSync(path.join(repoRoot, 'سلام.ts'), 'export const d = 4;', 'utf8');

      const status = await client.getStatus();

      expect(status.untrackedFiles).toContain('سلام.ts');
    });

    it('reports both sides of a rename', async () => {
      fs.writeFileSync(path.join(repoRoot, 'before.ts'), 'export const e = 5;', 'utf8');
      execSync('git add .', { cwd: repoRoot });
      execSync('git commit -m "add before"', { cwd: repoRoot });
      execSync('git mv before.ts after.ts', { cwd: repoRoot });

      const status = await client.getStatus();

      /*
      | A rename is one entry with two paths. Slicing at a fixed offset
      | used to produce "before.ts -> after.ts" as a single path.
      */

      expect(status.stagedFiles).toContain('after.ts');
      expect(status.stagedFiles).not.toContain('before.ts -> after.ts');
    });
  });

  describe('getChangedFilesSince', () => {

    it('reports files changed after the given commit', async () => {
      const first = (await client.getCurrentCommit())!.hash;

      fs.writeFileSync(path.join(repoRoot, 'later.ts'), 'export const f = 6;', 'utf8');
      execSync('git add .', { cwd: repoRoot });
      execSync('git commit -m "later"', { cwd: repoRoot });

      const changed = await client.getChangedFilesSince(first);

      expect(changed).toContain('later.ts');
    });
  });
});
