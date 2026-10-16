import { Phase1IndexPlatform, GenerationOwnership } from './Phase1Platform';
import { ProjectIndex } from '../types/project-index.types';
import { makeConfidence } from '../types/common.types';
import { LineIndex } from '../contracts/codeintel';

function fixture(): ProjectIndex { return {
  schemaVersion: '2.0.0', root: 'fixture', rootPath: '/tmp/fixture', generatedAt: '2026-01-01T00:00:00.000Z', languages: ['typescript'],
  languageSupport: { typescript: { symbols: 'full', callGraph: true } },
  files: [{ id: 'f', path: 'src/a.ts', language: 'typescript', encoding: 'utf8', size: 35, lines: 3, hash: 'abc', modified: '2026-01-01T00:00:00.000Z', binary: false, testFile: false, generated: false }],
  symbols: [{ id: 's', fileId: 'f', parentId: null, kind: 'function', name: 'f', fullyQualifiedName: 'f', line: 1, endLine: 1, signature: 'function f()', source: 'tree-sitter', confidence: makeConfidence(100) }],
  graphs: { callGraph: [], typeGraph: [], dependencyGraph: [] }, diagnostics: [], metrics: { totalFiles: 1, totalLoc: 3, totalSymbols: 1, avgCyclomaticComplexity: 1, languageBreakdown: { typescript: 1 } },
} as ProjectIndex; }

describe('Phase 1 index/platform contracts', () => {
  const platform = new Phase1IndexPlatform();
  test('reports adapter status without claiming unsupported languages', () => { const p = fixture(); const result = platform.adapters({ ...p, languages: ['typescript', 'unknown'] }); expect(result.typescript.status).toBe('ok'); expect(result.unknown.status).toBe('unavailable'); });
  test('returns partial outline diagnostics for unclosed syntax and supports CRLF', () => { const p = fixture(); const result = platform.parseDiagnostics('function f() {\r\n', p.files[0]!); expect(result.partial).toBe(true); expect(result.diagnostics[0]).toEqual(expect.objectContaining({ code: 'MISSING', line: 1 })); });
  test('outline keys are stable when only body text changes', () => { const p = fixture(); const a = platform.outline(p, 'f', 'function f() {}\n'); const b = platform.outline(p, 'f', 'function f() { return 1; }\n'); expect(a[0]?.key).toBe(b[0]?.key); expect(a[0]?.signatureHash).toBe(b[0]?.signatureHash); });
  test.each(['a\\nb', 'a\\r\\nb', 'a\\rb', 'فارسی😀\\r\\nدوم'])('LineIndex preserves UTF-16 offsets for %s', (text) => { const li = new LineIndex(text); for (let offset = 0; offset <= li.text.length; offset++) { if (li.isRepresentableOffset(offset)) expect(li.offsetAt(li.positionAt(offset))).toBe(offset); } });
  test('canonicalization and snapshot id do not depend on input file order', () => { const p = fixture(); const reversed = { ...p, files: [...p.files].reverse(), symbols: [...p.symbols].reverse() }; expect(platform.snapshotId(p)).toBe(platform.snapshotId(reversed)); });
  test('generation ownership uses compare-and-swap and rejects stale writers', () => { const owner = new GenerationOwnership(); expect(owner.claim(0, 'worker-a')).toEqual({ generation: 1, owner: 'worker-a' }); expect(() => owner.claim(0, 'worker-b')).toThrow('GENERATION_CONFLICT'); expect(owner.claim(1, 'worker-b')).toEqual({ generation: 2, owner: 'worker-b' }); });
});
