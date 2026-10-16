/**
 * Phase 2 ast-grep engine matrix (D-0016 / G-2.1, plan steps 2.1–2.3).
 *
 * The pre-existing `Phase2Structural.test.ts` runs UNCHANGED against the new
 * default engine (parity with current fixtures). This suite pins the engine
 * contract: version, $NAME/$$$ARGS captures, nesting, multiline, UTF-16/CRLF
 * offsets, invalid syntax/patterns, unsupported languages, bounds, and the
 * explicitly-experimental legacy fallback (including proof it is NOT
 * ast-grep-compatible).
 */
import { AST_GREP_VERSION, parsePatternMetavariables, searchAstGrep } from './Phase2AstGrep';
import { searchLegacySeam, searchTextStructurally } from './Phase2Structural';

const req = (pattern: string, language: 'typescript' | 'javascript' | 'tsx', extra: Record<string, unknown> = {}) => ({
  path: 'src/a.ts',
  language,
  pattern,
  ...extra,
});

describe('Phase 2 ast-grep engine', () => {
  test('pins the exact engine version in package.json and node_modules', () => {
    const pkg = require('../../../package.json') as { dependencies: Record<string, string> };
    const installed = require('@ast-grep/napi/package.json') as { version: string };
    expect(pkg.dependencies['@ast-grep/napi']).toBe('0.45.3');
    expect(installed.version).toBe('0.45.3');
    expect(AST_GREP_VERSION).toBe('0.45.3');
  });

  test('captures $NAME values and reports expression spans', () => {
    const result = searchTextStructurally('console.log(user);\nconsole.log(account);', req('console.log($VALUE)', 'typescript'));
    expect(result.matches.map(m => m.captures.VALUE)).toEqual(['user', 'account']);
    expect(result.matches.map(m => [m.start, m.end, m.line, m.column])).toEqual([[0, 17, 1, 0], [19, 39, 2, 0]]);
    expect(result.matches[0].text).toBe('console.log(user)');
    expect(result.truncated).toBe(false);
  });

  test('captures $$$ARGS as a source span, empty when no arguments', () => {
    const some = searchTextStructurally('f(a, b);\n', req('f($$$ARGS)', 'typescript'));
    expect(some.matches).toHaveLength(1);
    expect(some.matches[0].captures.ARGS).toBe('a, b');
    const none = searchTextStructurally('f();\n', req('f($$$ARGS)', 'typescript'));
    expect(none.matches).toHaveLength(1);
    expect(none.matches[0].captures.ARGS).toBe('');
  });

  test('finds nested matches in deterministic document order', () => {
    const result = searchTextStructurally('f(g(1));\n', req('$F($A)', 'typescript'));
    expect(result.matches.map(m => m.text)).toEqual(['f(g(1))', 'g(1)']);
    expect(result.matches.map(m => m.start)).toEqual([0, 2]);
  });

  test('enforces identical text for repeated $NAME natively', () => {
    const result = searchTextStructurally('eq(a, a);\neq(a, b);\n', req('eq($X, $X)', 'typescript'));
    expect(result.matches.map(m => m.text)).toEqual(['eq(a, a)']);
  });

  test('matches multiline patterns across line breaks', () => {
    const result = searchTextStructurally('f(1,\n  2);\n', req('f($A,\n$B)', 'typescript'));
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].text).toBe('f(1,\n  2)');
    expect([result.matches[0].start, result.matches[0].end]).toEqual([0, 9]);
    expect(result.matches[0].captures).toEqual({ A: '1', B: '2' });
  });

  test('reports UTF-16 offsets for Persian/emoji (plan 2.3)', () => {
    const src = 'const e = "🎉ش";\nsh(ش);\n';
    const call = searchTextStructurally(src, req('sh($X)', 'typescript'));
    expect(call.matches).toHaveLength(1);
    expect([call.matches[0].start, call.matches[0].end, call.matches[0].line, call.matches[0].column]).toEqual([17, 22, 2, 0]);
    expect(call.matches[0].text).toBe('sh(ش)');
    expect(call.matches[0].captures.X).toBe('ش');
    const literal = searchTextStructurally(src, req('"🎉ش"', 'typescript'));
    expect(literal.matches).toHaveLength(1);
    expect([literal.matches[0].start, literal.matches[0].end, literal.matches[0].line, literal.matches[0].column]).toEqual([10, 15, 1, 10]);
    expect(src.slice(10, 15)).toBe('"🎉ش"');
  });

  test('reports correct offsets across CRLF', () => {
    const result = searchTextStructurally('x();\r\nx();\r\n', req('x()', 'typescript'));
    expect(result.matches.map(m => [m.start, m.end, m.line, m.column])).toEqual([[0, 3, 1, 0], [6, 9, 2, 0]]);
  });

  test('derives line numbers from the contract LineIndex, not the engine (lone CR)', () => {
    const result = searchTextStructurally('x();\rx();\n', req('x()', 'typescript'));
    expect(result.matches).toHaveLength(2);
    // ast-grep itself reports line 0 for both; our contract counts \r as a break.
    expect(result.matches.map(m => [m.start, m.line, m.column])).toEqual([[0, 1, 0], [5, 2, 0]]);
  });

  test('tolerates invalid syntax without crashing', () => {
    const result = searchTextStructurally('const = ;;; \nfoo(1);\n', req('foo($A)', 'typescript'));
    expect(result.matches.map(m => m.text)).toEqual(['foo(1)']);
    expect(result.matches[0].captures.A).toBe('1');
  });

  test('unparseable patterns match nothing instead of crashing (upstream behavior)', () => {
    const result = searchTextStructurally('x();\n', req('(((', 'typescript'));
    expect(result.matches).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  test('standalone $$$ metavariables fail honestly, never silently', () => {
    expect(() => searchTextStructurally('x();\n', req('$$$A', 'typescript'))).toThrow('INVALID_PATTERN');
  });

  test('rejects empty patterns and non-positive bounds before touching the engine', () => {
    expect(() => searchTextStructurally('x();\n', req('   ', 'typescript'))).toThrow('pattern is required');
    expect(() => searchTextStructurally('x();\n', req('x()', 'typescript', { maxResults: 0 }))).toThrow('maxResults must be a positive integer');
  });

  test.each(['python', 'php', 'unknown', 'cobol'])('fails closed for unsupported language %s', language => {
    // The tool layer casts arbitrary input strings (as here); the engine must
    // still fail closed with a named error instead of guessing a parser.
    const request = { path: 'a', language: language as unknown as import('./Phase2Structural').StructuralLanguage, pattern: 'x' };
    expect(() => searchAstGrep('x = 1\n', request)).toThrow('UNSUPPORTED_LANGUAGE');
    expect(() => searchAstGrep('x = 1\n', request)).toThrow('supports: typescript, javascript, tsx');
  });

  test('bounds output and reports truncation honestly', () => {
    const bounded = searchTextStructurally('x();\nx();\nx();', req('x()', 'typescript', { maxResults: 2 }));
    expect(bounded.matches).toHaveLength(2);
    expect(bounded.truncated).toBe(true);
    const full = searchTextStructurally('x();\nx();\nx();', req('x()', 'typescript'));
    expect(full.matches).toHaveLength(3);
    expect(full.truncated).toBe(false);
  });

  test('is deterministic across runs and carries ruleId', () => {
    const src = 'f(g(1));\nconsole.log(user);\n';
    const first = searchTextStructurally(src, req('$F($A)', 'typescript', { ruleId: 'r1' }));
    const second = searchTextStructurally(src, req('$F($A)', 'typescript', { ruleId: 'r1' }));
    expect(second).toEqual(first);
    expect(first.matches.every(m => m.ruleId === 'r1')).toBe(true);
  });

  test('parses typescript, javascript and tsx through their own parsers', () => {
    expect(searchTextStructurally('const n = f(1);\n', req('f($A)', 'javascript')).matches).toHaveLength(1);
    expect(searchTextStructurally('const n = f(1);\n', req('f($A)', 'tsx')).matches).toHaveLength(1);
    expect(searchTextStructurally('const n: number = f(1);\n', req('f($A)', 'typescript')).matches).toHaveLength(1);
  });

  test('declares pattern metavariables for both engines', () => {
    expect(parsePatternMetavariables('f($A, $$$REST)')).toEqual({ single: ['A'], multi: ['REST'] });
    expect(parsePatternMetavariables('eq($X, $X)')).toEqual({ single: ['X'], multi: [] });
  });

  test('legacy seam works only when explicitly selected', () => {
    const explicit = searchTextStructurally('console.log(user);\n', { path: 'src/a.ts', language: 'typescript', pattern: 'console.log($VALUE)', engine: 'legacy-seam' });
    expect(explicit.matches.map(m => m.captures.VALUE)).toEqual(['user']);
    expect(searchLegacySeam('x();\nx();', { path: 'a', language: 'python', pattern: 'x()' }).matches).toHaveLength(2);
  });

  test('legacy seam is provably NOT ast-grep-compatible (multiline)', () => {
    const src = 'f(1,\n  2);\n';
    const pattern = 'f($A,\n$B)';
    expect(searchTextStructurally(src, req(pattern, 'typescript')).matches).toHaveLength(1);
    expect(searchTextStructurally(src, { ...req(pattern, 'typescript'), engine: 'legacy-seam' }).matches).toHaveLength(0);
  });
});
