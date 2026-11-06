/**
 * Output checks found by auditing what each layer hands the model
 * (docs/audit/04-AI-TOOLS-AUDIT.md): an answer must not claim more, or less,
 * than the index supports.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { AiToolRegistry } from './AiToolRegistry';
import { ProjectIndexReader } from './ProjectIndexReader';
import { ProjectIndex } from '../core/types/project-index.types';
import { GitClient } from '../core/git/GitClient';
import { MCP_INSTRUCTIONS } from './mcp/instructions';

function index(): ProjectIndex {
  const file = (id: string, p: string, lines: number) => ({
    id, path: p, language: 'typescript', encoding: 'utf8', size: 10, lines, hash: id, modified: '', binary: false,
    testFile: false, generated: false, symbolIds: [], imports: [], exports: [], diagnostics: [], outline: [],
    metrics: { loc: lines, cyclomaticComplexity: 1 },
  });
  return {
    schemaVersion: '2.0.0', root: 'p', rootPath: '', generatedAt: 'g1', generatorVersion: '0', languages: ['typescript'],
    languageSupport: {}, files: [file('f1', 'a.ts', 3)], symbols: [],
    graphs: { callGraph: [], typeGraph: [], dependencyGraph: [], reverseDependencyGraph: [] },
    diagnostics: [], git: null, metrics: {},
  } as unknown as ProjectIndex;
}

describe('answers do not overstate', () => {
  let dir: string;
  let registry: AiToolRegistry;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-truth-')));
    fs.writeFileSync(path.join(dir, 'a.ts'), 'const a = 1;\nconst b = 2;\nconsole.log("needle");\n');
    registry = new AiToolRegistry({ reader: new ProjectIndexReader(index()), workspaceRoot: dir, projectHash: 'g1' });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reports a parameter it ignored instead of looking as if it was applied', async () => {
    const result = await registry.execute('project_list_files', { limt: 1 });
    expect(result.success).toBe(true);
    expect(result.metadata?.['warnings']).toEqual([expect.stringContaining("unknown parameter 'limt' was ignored; did you mean 'limit'?")]);
  });

  it('does not warn when every parameter is known', async () => {
    const result = await registry.execute('project_list_files', { limit: 1 });
    expect(result.metadata?.['warnings']).toBeUndefined();
  });

  it('impact_analysis on an id that is not in the index fails instead of answering "nothing is impacted"', async () => {
    const result = await registry.execute('impact_analysis', { id: 'does/not/exist.ts' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No file, symbol, module or package found/);
  });

  it('search_text puts the real line number on the item, not line 1', async () => {
    const result = await registry.execute('search_text', { query: 'needle' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.line).toBe(3);
    expect(result.items[0]!.metadata?.['line']).toBe(3);
  });

  it('find_tests explains an empty answer', async () => {
    const result = await registry.execute('find_tests', { path: 'a.ts' });
    expect(result.success).toBe(true);
    expect(result.metadata?.['note']).toMatch(/no test file is linked/);
  });

  it('git hotspots do not report invented line counts', async () => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'], { cwd: dir });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir });
    const result = await registry.execute('get_git_hotspots', { limit: 5 });
    const hotspots = result.metadata?.['hotspots'] as Array<{ linesAdded: unknown; linesDeleted: unknown }>;
    expect(hotspots.length).toBe(1);
    expect(hotspots[0]!.linesAdded).toBeNull();
    expect(hotspots[0]!.linesDeleted).toBeNull();
  });

  it('says why an empty hotspot list is empty', async () => {
    const result = await registry.execute('get_git_hotspots', {});
    expect(result.items).toEqual([]);
    expect(String(result.metadata?.['note'])).toMatch(/not evidence/);
  });
});

describe('git log parsing', () => {
  it('keeps a commit subject that contains "|" intact and does not shift author/date', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-gitlog-')));
    try {
      const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=Ann', ...a], { cwd: dir });
      git('init', '-q');
      fs.writeFileSync(path.join(dir, 'f.txt'), 'x');
      git('add', '.');
      git('commit', '-qm', 'fix: parse a | b | c');
      const [commit] = await new GitClient(dir).getLog(1);
      expect(commit!.message).toBe('fix: parse a | b | c');
      expect(commit!.author).toBe('Ann');
      expect(new Date(commit!.date).getTime()).not.toBeNaN();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('shows a project in a sub-folder only its own history', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-gitsub-')));
    try {
      const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=Ann', ...a], { cwd: dir });
      git('init', '-q');
      fs.mkdirSync(path.join(dir, 'proj'));
      fs.mkdirSync(path.join(dir, 'other'));
      fs.writeFileSync(path.join(dir, 'proj', 'a.txt'), '1');
      git('add', '.');
      git('commit', '-qm', 'proj commit');
      fs.writeFileSync(path.join(dir, 'other', 'b.txt'), '2');
      git('add', '.');
      git('commit', '-qm', 'other commit');
      const log = await new GitClient(path.join(dir, 'proj')).getLog(5);
      expect(log.map(c => c.message)).toEqual(['proj commit']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('MCP instructions', () => {
  it('explain how to start and how to read results', () => {
    expect(MCP_INSTRUCTIONS).toMatch(/project_info/);
    expect(MCP_INSTRUCTIONS).toMatch(/truncated/);
    expect(MCP_INSTRUCTIONS).toMatch(/indexGeneration/);
  });
});
