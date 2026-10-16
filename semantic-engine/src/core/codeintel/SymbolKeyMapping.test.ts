/**
 * F-09: pipeline `fullyQualifiedName` values may already embed `::`
 * (e.g. `src/a.ts::Name`). Phase producers must map them to canonical,
 * parseable symbol keys instead of throwing on real indexes.
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ProjectIndexReader } from '../../ai/ProjectIndexReader';
import { parseSymbolKey, sanitizeKeyPart } from '../contracts/codeintel';
import { Phase1IndexPlatform } from './Phase1Platform';
import { Phase3SemanticGraphPilot } from './Phase3SemanticGraph';
import { ProjectIndex } from '../types/project-index.types';
import { makeConfidence } from '../types/common.types';

const SOURCE = 'export class Widget {\n  render() { return 1; }\n}\n';

function index(): ProjectIndex {
  return {
    schemaVersion: '2.0.0', root: 'f09', rootPath: '/', generatedAt: '2026-01-01T00:00:00Z',
    languages: ['typescript'],
    files: [{ id: 'f1', path: 'src/a.ts', language: 'typescript', encoding: 'utf8', size: SOURCE.length, lines: 3, hash: 'h', modified: '2026-01-01T00:00:00Z', binary: false, testFile: false, generated: false }],
    symbols: [{ id: 's1', fileId: 'f1', parentId: null, kind: 'class', name: 'Widget', fullyQualifiedName: 'src/a.ts::Widget', line: 1, endLine: 3, source: 'tree-sitter', confidence: makeConfidence(100), exported: true }],
    graphs: { callGraph: [], typeGraph: [], dependencyGraph: [] }, diagnostics: [],
    metrics: { totalFiles: 1, totalLoc: 3, totalSymbols: 1, avgCyclomaticComplexity: 1, languageBreakdown: { typescript: 1 } },
  } as ProjectIndex;
}

describe('F-09 symbol key mapping', () => {
  test('sanitizeKeyPart is deterministic and total', () => {
    expect(sanitizeKeyPart('src/a.ts::Widget')).toBe('src/a.ts:Widget');
    expect(sanitizeKeyPart('plain')).toBe('plain');
    expect(sanitizeKeyPart('a#b')).toBe('a_b');
    expect(() => parseSymbolKey(`src/a.ts::${sanitizeKeyPart('src/a.ts::Widget')}::class`)).not.toThrow();
  });

  test('Phase 1 outline keys pipeline FQNs without throwing', () => {
    const nodes = new Phase1IndexPlatform().outline(index(), 'f1', SOURCE);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].key).toBe('src/a.ts::src/a.ts:Widget::class');
    expect(parseSymbolKey(String(nodes[0].key)).qualifiedName).toBe('src/a.ts:Widget');
  });

  test('Phase 3 pilot builds over pipeline FQNs without throwing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'se-f09-'));
    try {
      await fs.mkdir(path.join(root, 'src'), { recursive: true });
      await fs.writeFile(path.join(root, 'src/a.ts'), SOURCE, 'utf8');
      const graph = await new Phase3SemanticGraphPilot(new ProjectIndexReader(index()), root).build();
      expect(graph.schemaVersion).toBe('3-pilot');
      const { references } = await new Phase3SemanticGraphPilot(new ProjectIndexReader(index()), root).referencesFor('s1');
      expect(Array.isArray(references)).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
