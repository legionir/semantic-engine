/**
 * The model reads what a tool returns, error and note text included. After the
 * tools were consolidated, some of that text still pointed at tools that are not
 * offered (`project_list_files`, `semantic_search`, ...), and the model then called
 * names that do not exist. This runs every offered tool against good and bad
 * input and requires that nothing it says names a tool the model cannot call.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AiToolRegistry } from './AiToolRegistry';
import { ProjectIndexReader } from './ProjectIndexReader';
import { ProjectIndex } from '../core/types/project-index.types';
import { ADVANCED_TOOL_NAMES, INTERNAL_TOOL_NAMES } from './tools/AgentTools';
import { MCP_INSTRUCTIONS } from './mcp/instructions';

const HIDDEN = [...ADVANCED_TOOL_NAMES, ...INTERNAL_TOOL_NAMES, 'query_index'];

function index(): ProjectIndex {
  const file = (id: string, p: string, lines: number) => ({
    id, path: p, language: 'typescript', encoding: 'utf8', size: 10, lines, hash: id, modified: '', binary: false,
    testFile: false, generated: false, symbolIds: ['s1'], imports: [], exports: [], diagnostics: [], outline: [],
    metrics: { loc: lines, cyclomaticComplexity: 1 },
  });
  return {
    schemaVersion: '2.0.0', root: 'p', rootPath: '', generatedAt: 'g1', generatorVersion: '0', languages: ['typescript'],
    languageSupport: {}, files: [file('f1', 'a.ts', 3)],
    symbols: [{ id: 's1', fileId: 'f1', parentId: null, kind: 'function', name: 'alpha', line: 1, endLine: 2, source: 'tree-sitter', confidence: 90 }],
    graphs: { callGraph: [], typeGraph: [], dependencyGraph: [], reverseDependencyGraph: [] },
    diagnostics: [], git: null, metrics: {},
  } as unknown as ProjectIndex;
}

describe('what the offered tools say never names a tool the model cannot call', () => {
  let dir: string;
  let registry: AiToolRegistry;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-names-')));
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export function alpha() {\n  return 1;\n}\n');
    registry = new AiToolRegistry({ reader: new ProjectIndexReader(index()), workspaceRoot: dir, projectHash: 'g1' });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const inputs: Record<string, Record<string, unknown>[]> = {
    project_info: [{}],
    find_context: [{}, { task: 'alpha' }, { task: 'zzz nothing', includeSource: true }],
    search: [{}, { query: 'alpha' }, { query: 'nothing-here', mode: 'text' }, { query: 'function $N', mode: 'pattern' }, { query: 'x', mode: 'bogus' }],
    find_symbol: [{}, { name: 'alpha' }, { name: 'nope' }],
    explain_symbol: [{}, { target: 'alpha' }, { target: 'nope' }, { id: 'nope' }],
    file_outline: [{}, { path: 'a.ts' }, { path: 'missing.ts' }],
    read_code: [{}, { path: 'a.ts' }, { path: 'missing.ts' }, { path: '../etc/passwd' }, { path: 'a.ts', startLine: 50, endLine: 60 }],
    list_files: [{}, { path: 'nothing/' }, { limt: 1 }],
    impact: [{}, { target: 'nope' }, { target: 'alpha' }, { target: 'alpha', change: 'rename' }, { target: 'a.ts', direction: 'dependencies' }],
    find_tests: [{}, { path: 'a.ts' }, { path: 'missing.ts' }],
    git_history: [{}, { view: 'hotspots' }, { path: 'missing.ts' }],
  };

  for (const [tool, calls] of Object.entries(inputs)) {
    it(`${tool}`, async () => {
      for (const input of calls) {
        const result = await registry.execute(tool, input).catch(error => ({ thrown: String(error) }));
        const text = JSON.stringify(result);
        for (const hidden of HIDDEN) {
          expect(`${tool}(${JSON.stringify(input)}) mentions ${hidden}: ${text.includes(hidden)}`).toBe(
            `${tool}(${JSON.stringify(input)}) mentions ${hidden}: false`
          );
        }
      }
    });
  }

  it('every offered tool is covered here', () => {
    expect(Object.keys(inputs).sort()).toEqual(registry.list().map(t => t.name).sort());
  });

  it('neither do the descriptions, schemas and instructions the model reads up front', () => {
    const skill = fs.readFileSync(path.join(__dirname, '..', '..', 'plugin', 'skills', 'semantic-engine', 'SKILL.md'), 'utf8');
    const surfaces: Record<string, string> = {
      'tool list (names, descriptions, schemas)': JSON.stringify(registry.list()),
      'MCP instructions': MCP_INSTRUCTIONS,
      'plugin skill': skill,
    };
    for (const [where, text] of Object.entries(surfaces)) {
      for (const hidden of HIDDEN) {
        expect(`${where} mentions ${hidden}: ${new RegExp(`\\b${hidden}\\b`).test(text)}`).toBe(`${where} mentions ${hidden}: false`);
      }
    }
  });
});
