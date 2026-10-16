import { TSDependencyExtractor } from './TSDependencyExtractor';

const extractor = new TSDependencyExtractor();

describe('TSDependencyExtractor', () => {
  it('should extract named imports', async () => {
    const content = `import { User } from '../core/types';\nimport { ApiClient } from './api';`;

    const result = await extractor.extractDependencies('f1', 'src/services/user.ts', content, 'typescript');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');

    expect(result.value.imports).toHaveLength(2);
    expect(result.value.imports[0]!.from).toBe('../core/types');
    expect(result.value.imports[0]!.type).toBe('local');
    expect(result.value.imports[0]!.specifiers).toEqual([{ imported: 'User', local: 'User' }]);
  });

  it('should classify package vs builtin imports', async () => {
    const content = `import express from 'express';\nimport * as fs from 'fs';\nimport path from 'path';`;

    const result = await extractor.extractDependencies('f1', 'src/app.ts', content, 'typescript');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');

    const types = result.value.imports.map(i => i.type);
    expect(types).toContain('package');
    expect(types).toContain('builtin');
  });

  it('should extract dynamic imports', async () => {
    const content = `const lazy = await import('./lazy');`;

    const result = await extractor.extractDependencies('f1', 'src/app.ts', content, 'typescript');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');

    const dynamic = result.value.imports.find(i => i.dynamic);
    expect(dynamic).toBeDefined();
    expect(dynamic!.from).toBe('./lazy');
  });

  it('should extract exports', async () => {
    const content = `export class UserService {}\nexport function helper() {}\nexport default class App {}`;

    const result = await extractor.extractDependencies('f1', 'src/services/user.ts', content, 'typescript');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');

    expect(result.value.exports).toHaveLength(3);
    expect(result.value.exports.some(e => e.name === 'UserService' && e.kind === 'named')).toBe(true);
    expect(result.value.exports.some(e => e.name === 'helper' && e.kind === 'named')).toBe(true);
    expect(result.value.exports.some(e => e.kind === 'default')).toBe(true);
  });

  it('should detect re-exports', async () => {
    const content = `export { User } from '../core/types';`;

    const result = await extractor.extractDependencies('f1', 'src/index.ts', content, 'typescript');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');

    const reExport = result.value.exports[0]!;
    expect(reExport.kind).toBe('re-export');
    expect(reExport.reExportFrom).toBe('../core/types');
  });

  it('should map aliased import specifiers correctly', async () => {
    const content = `import { foo as bar, baz } from './utils';`;

    const result = await extractor.extractDependencies('f1', 'src/app.ts', content, 'typescript');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');

    const specifiers = result.value.imports[0]!.specifiers ?? [];
    expect(specifiers).toHaveLength(2);

    const aliasSpec = specifiers.find(s => s.local === 'bar');
    expect(aliasSpec).toBeDefined();
    expect(aliasSpec!.imported).toBe('foo');

    const normalSpec = specifiers.find(s => s.local === 'baz');
    expect(normalSpec).toBeDefined();
    expect(normalSpec!.imported).toBe('baz');
  });
});
