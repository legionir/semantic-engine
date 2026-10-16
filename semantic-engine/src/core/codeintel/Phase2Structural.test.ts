import { dumpSyntaxTree, parseRulePack, searchTextStructurally } from './Phase2Structural';

describe('Phase 2 structural adapter', () => {
  test('matches named metavariables deterministically', () => {
    const result = searchTextStructurally('console.log(user);\nconsole.log(account);', { path: 'src/a.ts', language: 'typescript', pattern: 'console.log($VALUE)' });
    expect(result.matches.map(m => m.captures.VALUE)).toEqual(['user', 'account']);
    expect(result.matches[0].start).toBe(0);
  });
  test('bounds and reports truncation', () => {
    const result = searchTextStructurally('x();\nx();\nx();', { path: 'a.ts', language: 'typescript', pattern: 'x()', maxResults: 2 });
    expect(result.matches).toHaveLength(2); expect(result.truncated).toBe(true);
  });
  test('validates JSON and minimal YAML rule packs', () => {
    expect(parseRulePack('{"rules":[{"id":"r","language":"typescript","pattern":"x()","message":"bad"}]}').rules[0].severity).toBe('warning');
    expect(parseRulePack('rules:\n  - id: r\n    language: typescript\n    pattern: x()\n    message: bad').rules[0].id).toBe('r');
    expect(() => parseRulePack('{"rules":[{"id":"r","language":"typescript","pattern":"x()","message":"a"},{"id":"r","language":"typescript","pattern":"x()","message":"b"}]}')).toThrow('duplicate');
  });
  test('syntax dump is deterministic and preserves lines', async () => {
    await expect(dumpSyntaxTree('a\r\nb', 'typescript')).resolves.toEqual({ language: 'typescript', type: 'document', children: [{ type: 'line', index: 0, text: 'a' }, { type: 'line', index: 1, text: 'b' }] });
  });
});
