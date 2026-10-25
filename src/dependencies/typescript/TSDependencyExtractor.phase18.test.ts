/**
 * استخراج وابستگی از TypeScript/JavaScript — فاز ۱۸.
 *
 * همهٔ موارد اینجا اول روی کد واقعی بازتولید شدند. خلاصهٔ آنچه پیش از
 * این فاز اتفاق می‌افتاد:
 *
 *   export { a, b, c }              → یک entry با نام "a, b, c"
 *   const fs = require('fs')        → هیچ import
 *   import 'node:fs'                → package، نه builtin
 *   import type { T } from './t'    → مثل وابستگی runtime
 *   export default function () {}   → هیچ export
 */

import { TSDependencyExtractor } from './TSDependencyExtractor';
import { ImportEntry, ExportEntry } from '../../core/types/project-index.types';

const extractor = new TSDependencyExtractor();

async function run(
  source: string,
  language = 'typescript',
  file = 'src/a.ts'
): Promise<{ imports: readonly ImportEntry[]; exports: readonly ExportEntry[] }> {
  const result = await extractor.extractDependencies('f1', file, source, language);
  if (!result.ok) throw result.error;
  return { imports: result.value.imports, exports: result.value.exports };
}

describe('the extractor tells the truth about itself (SE-DEP-08)', () => {

  /*
  | `name` روی `'tree-sitter'` بود با کامنت «تا فاز ۲ آماده بشه».
  | این استخراج‌گر با TypeScript compiler API کار می‌کند و هیچ ربطی
  | به tree-sitter ندارد؛ یعنی `source` در خروجی دروغ می‌گفت.
  */
  it('does not claim to be tree-sitter', () => {
    expect(extractor.name).not.toBe('tree-sitter');
  });

  it('reports a source that names what it actually is', () => {
    expect(extractor.name).toBe('typescript-api');
  });
});

describe('one export entry per name (SE-DATA-02)', () => {

  /*
  | معیار پذیرش فاز: «`export { a, b }` دو entry با symbolId مستقل
  | بدهد.» نگه داشتن `"a, b, c"` در یک رشته یعنی هر مصرف‌کننده باید
  | خودش split کند — و چهار جا واقعاً می‌کردند، هر کدام کمی متفاوت.
  */
  it('splits a named export list into one entry each', async () => {
    const { exports } = await run('const a=1, b=2, c=3;\nexport { a, b, c };\n');

    expect(exports.map(e => e.name)).toEqual(['a', 'b', 'c']);
    expect(exports.every(e => e.kind === 'named')).toBe(true);
  });

  it('splits a re-export list into one entry each', async () => {
    const { exports } = await run("export { a, b } from './other';\n");

    expect(exports.map(e => e.name)).toEqual(['a', 'b']);
    expect(exports.every(e => e.kind === 're-export')).toBe(true);
    expect(exports.every(e => e.reExportFrom === './other')).toBe(true);
  });

  it('records the exported name, not the local one, when renamed', async () => {
    const { exports } = await run('const a = 1;\nexport { a as publicName };\n');

    expect(exports.map(e => e.name)).toEqual(['publicName']);
  });

  it('never puts a comma inside an export name', async () => {
    const { exports } = await run(`const a=1, b=2;
export { a, b };
export { a as x } from './m';
`);

    for (const entry of exports) {
      expect(entry.name).not.toContain(',');
    }
  });

  it('keeps a star re-export as a single namespace entry', async () => {
    const { exports } = await run("export * from './other';\n");

    expect(exports).toEqual([
      expect.objectContaining({ name: '*', kind: 'namespace', reExportFrom: './other' }),
    ]);
  });

  it('still records a single named export', async () => {
    const { exports } = await run('export const only = 1;\n');

    expect(exports.map(e => e.name)).toEqual(['only']);
  });
});

describe('CommonJS (SE-DEP-01)', () => {

  /*
  | هیچ پروژهٔ CommonJS گراف وابستگی نداشت — از جمله خودِ این مخزن،
  | که `agent/` و `bin/` آن CJS خالص‌اند.
  */
  it('finds a require call', async () => {
    const { imports } = await run("const fs = require('fs');\n", 'javascript', 'a.js');

    expect(imports).toEqual([
      expect.objectContaining({ from: 'fs', type: 'builtin' }),
    ]);
  });

  it('finds a destructured require', async () => {
    const { imports } = await run("const { join, resolve } = require('path');\n", 'javascript', 'a.js');

    expect(imports[0].from).toBe('path');
    expect(imports[0].specifiers?.map(s => s.imported)).toEqual(['join', 'resolve']);
  });

  it('finds a local require and classifies it as local', async () => {
    const { imports } = await run("const helper = require('./helper');\n", 'javascript', 'a.js');

    expect(imports).toEqual([expect.objectContaining({ from: './helper', type: 'local' })]);
  });

  it('finds a bare require with no assignment', async () => {
    const { imports } = await run("require('./side-effect');\n", 'javascript', 'a.js');

    expect(imports.map(i => i.from)).toEqual(['./side-effect']);
  });

  it('finds a require nested in an expression', async () => {
    const { imports } = await run("const x = require('lodash').merge;\n", 'javascript', 'a.js');

    expect(imports.map(i => i.from)).toEqual(['lodash']);
  });

  it('ignores a require whose argument is not a literal', async () => {
    const { imports } = await run('const name = "fs";\nconst m = require(name);\n', 'javascript', 'a.js');

    expect(imports).toEqual([]);
  });

  it('expands a module.exports object literal into named exports (SE-DEP-12)', async () => {
    const { exports } = await run('module.exports = { a: 1, b: 2 };\n', 'javascript', 'a.js');

    expect(exports.map(e => e.name)).toEqual(['a', 'b']);
    expect(exports.every(e => e.kind === 'named')).toBe(true);
  });

  it('keeps a non-object module.exports as a namespace export', async () => {
    const { exports } = await run('module.exports = someValue;\n', 'javascript', 'a.js');

    expect(exports).toEqual([expect.objectContaining({ kind: 'namespace' })]);
  });

  it('records a named property export', async () => {
    const { exports } = await run('exports.helper = function () {};\nexports.other = 1;\n', 'javascript', 'a.js');

    expect(exports.map(e => e.name)).toEqual(['helper', 'other']);
  });

  it('leaves require alone in a TypeScript file that uses import', async () => {
    const { imports } = await run("import fs from 'fs';\n");

    expect(imports.map(i => i.from)).toEqual(['fs']);
  });
});

describe('builtin classification (SE-DEP-06)', () => {

  it('recognises the node: prefix', async () => {
    const { imports } = await run("import fs from 'node:fs';\n");

    expect(imports[0]).toMatchObject({ from: 'node:fs', type: 'builtin' });
  });

  it.each(['worker_threads', 'perf_hooks', 'async_hooks', 'diagnostics_channel', 'inspector'])(
    'recognises %s as a builtin',
    async name => {
      const { imports } = await run(`import x from '${name}';\n`);

      expect(imports[0].type).toBe('builtin');
    }
  );

  it('still calls a real package a package', async () => {
    const { imports } = await run("import x from 'lodash';\n");

    expect(imports[0].type).toBe('package');
  });

  it('does not mistake a scoped package for a builtin', async () => {
    const { imports } = await run("import x from '@scope/fs';\n");

    expect(imports[0].type).toBe('package');
  });

  it('classifies a subpath of a builtin', async () => {
    const { imports } = await run("import { promises } from 'node:fs/promises';\n");

    expect(imports[0].type).toBe('builtin');
  });
});

describe('type-only imports (SE-DEP-07)', () => {

  /*
  | وابستگی صرفاً تایپی در زمان اجرا وجود ندارد. علامت‌نزدنش یعنی
  | گراف وابستگی یال‌هایی دارد که هیچ‌وقت اجرا نمی‌شوند — و هر تحلیل
  | «چه چیزی را می‌شکنم اگر این را عوض کنم» را بیش از حد بدبین
  | می‌کند.
  */
  it('marks import type', async () => {
    const { imports } = await run("import type { Foo } from './foo';\n");

    expect(imports[0]).toMatchObject({ from: './foo', typeOnly: true });
  });

  it('leaves a runtime import unmarked', async () => {
    const { imports } = await run("import { bar } from './bar';\n");

    expect(imports[0].typeOnly).toBeFalsy();
  });

  it('marks an inline type specifier list as type-only when all are types', async () => {
    const { imports } = await run("import { type A, type B } from './t';\n");

    expect(imports[0].typeOnly).toBe(true);
  });

  it('does not mark a mixed import as type-only', async () => {
    const { imports } = await run("import { type A, b } from './t';\n");

    expect(imports[0].typeOnly).toBeFalsy();
  });

  it('marks export type as type-only too', async () => {
    const { exports } = await run("export type { Foo } from './foo';\n");

    expect(exports[0]).toMatchObject({ name: 'Foo', typeOnly: true });
  });
});

describe('anonymous default export (SE-DEP-09)', () => {

  it('records an anonymous default function', async () => {
    const { exports } = await run('export default function () { return 1; }\n');

    expect(exports).toEqual([expect.objectContaining({ name: 'default', kind: 'default' })]);
  });

  it('records an anonymous default class', async () => {
    const { exports } = await run('export default class { run() {} }\n');

    expect(exports.map(e => e.name)).toEqual(['default']);
  });

  it('records an anonymous default arrow', async () => {
    const { exports } = await run('export default () => 1;\n');

    expect(exports.map(e => e.name)).toEqual(['default']);
  });

  it('keeps the name of a named default export', async () => {
    const { exports } = await run('export default function main() { return 1; }\n');

    expect(exports).toEqual([expect.objectContaining({ name: 'main', kind: 'default' })]);
  });
});
