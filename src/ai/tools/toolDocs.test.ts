import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AiToolRegistry } from '../AiToolRegistry';
import { ProjectIndexReader } from '../ProjectIndexReader';
import { renderSkillCatalog, renderToolReference } from './renderToolDocs';
import { TOOL_DOCS } from './toolDocs';
import { ProjectIndex } from '../../core/types/project-index.types';

const ROOT = path.join(__dirname, '..', '..', '..');

function emptyIndex(): ProjectIndex {
  return {
    schemaVersion: '2.0.0', root: 'x', rootPath: os.tmpdir(), generatedAt: '1970-01-01T00:00:00.000Z',
    generatorVersion: '0', languages: [], languageSupport: {}, files: [], symbols: [],
    graphs: { callGraph: [], typeGraph: [], dependencyGraph: [], reverseDependencyGraph: [] },
    diagnostics: [], git: null, metrics: {},
  } as unknown as ProjectIndex;
}

function fullRegistry(): AiToolRegistry {
  return new AiToolRegistry({
    reader: new ProjectIndexReader(emptyIndex()),
    workspaceRoot: os.tmpdir(),
    enablePhase2Edits: true,
    experimental: { 'semantic-graph': true, 'controlled-expansion': true },
  });
}

describe('what the model is shown for every tool', () => {
  const listed = fullRegistry().list();

  it('has reviewed documentation for every registered tool, and none for tools that do not exist', () => {
    const names = listed.map(t => t.name).sort();
    expect(Object.keys(TOOL_DOCS).sort()).toEqual(names);
  });

  it('describes every parameter, and documents only parameters that exist', () => {
    const undocumented: string[] = [];
    const orphans: string[] = [];
    for (const tool of listed) {
      const props = (tool.inputSchema['properties'] ?? {}) as Record<string, { description?: string }>;
      for (const [name, prop] of Object.entries(props)) {
        if (!prop.description || prop.description.trim().length < 8) undocumented.push(`${tool.name}.${name}`);
      }
      for (const key of Object.keys(TOOL_DOCS[tool.name]!.params)) {
        if (!(key in props)) orphans.push(`${tool.name}.${key}`);
      }
    }
    expect(undocumented).toEqual([]);
    expect(orphans).toEqual([]);
  });

  it('states what each tool returns in its description', () => {
    for (const tool of listed) {
      expect(tool.description).toContain('Returns:');
      expect(tool.description.length).toBeGreaterThan(80);
    }
  });

  it('tells the model the shape of an edit (edit_plan.edits was an untyped object)', () => {
    const edit = listed.find(t => t.name === 'edit_plan')!;
    const items = ((edit.inputSchema['properties'] as Record<string, any>)['edits'] as any).items;
    expect(items.required).toEqual(['path', 'start', 'end', 'replacement', 'expectedHash']);
  });

  it('does not mutate the tools it describes (a second list is identical)', () => {
    const registry = fullRegistry();
    expect(JSON.stringify(registry.list())).toBe(JSON.stringify(registry.list()));
  });
});

describe('checked-in documents match the registry', () => {
  const tools = fullRegistry().list();

  it('docs/AI-TOOLS.md is current (run: npm run docs:ai-tools)', () => {
    const text = fs.readFileSync(path.join(ROOT, 'docs', 'AI-TOOLS.md'), 'utf8');
    expect(text).toContain(renderToolReference(tools));
    expect(text).toContain(`${tools.length} tools.`);
  });

  it('the skill catalogue is current and the skill has valid frontmatter', () => {
    const skill = fs.readFileSync(path.join(ROOT, 'skills', 'semantic-engine', 'SKILL.md'), 'utf8');
    expect(skill).toContain(renderSkillCatalog(tools));
    const front = /^---\nname: semantic-engine\ndescription: (.+)\n---\n/.exec(skill);
    expect(front).not.toBeNull();
    expect(front![1]!.length).toBeGreaterThan(80);
    expect(front![1]!.length).toBeLessThan(1024);
  });
});
