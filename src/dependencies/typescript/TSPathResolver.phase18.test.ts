/**
 * تحلیل مسیر TypeScript — فاز ۱۸ (SE-DEP-04 و SE-DEP-05).
 *
 *   SE-DEP-04 — `tsconfig.extends` نادیده گرفته می‌شد. در چیدمان رایج
 *   monorepo که `paths` در `tsconfig.base.json` است، همهٔ aliasها گم
 *   می‌شدند.
 *
 *   SE-DEP-05 — `findExistingFile` به‌ازای هر import تا ۹ بار
 *   `existsSync` + `statSync` می‌زد، بدون کش. و پسوندهای واقعی
 *   (`.mts`, `.cts`, `.d.ts`, `index.mjs`) را نمی‌شناخت.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TSPathResolver } from './TSPathResolver';

let root: string;

function write(relative: string, content = 'export const x = 1;\n'): void {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'se-resolve-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('tsconfig extends (SE-DEP-04)', () => {

  it('reads paths from an extended base config', () => {
    write('tsconfig.base.json', JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/app/*'] } },
    }));
    write('tsconfig.json', JSON.stringify({ extends: './tsconfig.base.json' }));
    write('src/app/thing.ts');
    write('src/main.ts');

    expect(new TSPathResolver(root).resolve('@app/thing', 'src/main.ts'))
      .toBe('src/app/thing.ts');
  });

  it('lets the child config win over the base', () => {
    write('tsconfig.base.json', JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@app/*': ['wrong/*'] } },
    }));
    write('tsconfig.json', JSON.stringify({
      extends: './tsconfig.base.json',
      compilerOptions: { paths: { '@app/*': ['src/app/*'] } },
    }));
    write('src/app/thing.ts');

    expect(new TSPathResolver(root).resolve('@app/thing', 'src/main.ts'))
      .toBe('src/app/thing.ts');
  });

  it('follows a chain of extends', () => {
    write('tsconfig.root.json', JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['src/lib/*'] } },
    }));
    write('tsconfig.base.json', JSON.stringify({ extends: './tsconfig.root.json' }));
    write('tsconfig.json', JSON.stringify({ extends: './tsconfig.base.json' }));
    write('src/lib/util.ts');

    expect(new TSPathResolver(root).resolve('@lib/util', 'src/main.ts'))
      .toBe('src/lib/util.ts');
  });

  it('inherits baseUrl from the base config', () => {
    write('tsconfig.base.json', JSON.stringify({ compilerOptions: { baseUrl: 'src' } }));
    write('tsconfig.json', JSON.stringify({ extends: './tsconfig.base.json' }));
    write('src/deep/thing.ts');

    expect(new TSPathResolver(root).resolve('deep/thing', 'src/main.ts'))
      .toBe('src/deep/thing.ts');
  });

  /*
  | یک `extends` حلقوی نباید پروسه را در حلقهٔ بی‌نهایت بگذارد. روی
  | یک monorepo واقعی، اشتباه پیکربندی از این دست نادر نیست.
  */
  it('survives a circular extends', () => {
    write('tsconfig.json', JSON.stringify({ extends: './tsconfig.other.json' }));
    write('tsconfig.other.json', JSON.stringify({ extends: './tsconfig.json' }));
    write('src/main.ts');

    expect(() => new TSPathResolver(root).resolve('./x', 'src/main.ts')).not.toThrow();
  });

  it('ignores an extends that points at nothing', () => {
    write('tsconfig.json', JSON.stringify({
      extends: './missing.json',
      compilerOptions: { baseUrl: '.', paths: { '@a/*': ['src/*'] } },
    }));
    write('src/thing.ts');

    expect(new TSPathResolver(root).resolve('@a/thing', 'src/main.ts')).toBe('src/thing.ts');
  });
});

describe('module file shapes (SE-DEP-05)', () => {

  it.each([
    ['thing.ts', './thing'],
    ['thing.tsx', './thing'],
    ['thing.js', './thing'],
    ['thing.mjs', './thing'],
    ['thing.cjs', './thing'],
    ['thing.mts', './thing'],
    ['thing.cts', './thing'],
  ])('resolves %s', (file, specifier) => {
    write(`src/${file}`);
    write('src/main.ts');

    expect(new TSPathResolver(root).resolve(specifier, 'src/main.ts')).toBe(`src/${file}`);
  });

  it.each(['index.ts', 'index.tsx', 'index.js', 'index.mjs', 'index.cjs'])(
    'resolves a directory through %s',
    file => {
      write(`src/folder/${file}`);
      write('src/main.ts');

      expect(new TSPathResolver(root).resolve('./folder', 'src/main.ts'))
        .toBe(`src/folder/${file}`);
    }
  );

  it('resolves a declaration file when there is no implementation', () => {
    write('src/types.d.ts', 'export type X = 1;\n');
    write('src/main.ts');

    expect(new TSPathResolver(root).resolve('./types', 'src/main.ts')).toBe('src/types.d.ts');
  });

  it('prefers a real implementation over a declaration file', () => {
    write('src/thing.ts');
    write('src/thing.d.ts', 'export declare const x: number;\n');
    write('src/main.ts');

    expect(new TSPathResolver(root).resolve('./thing', 'src/main.ts')).toBe('src/thing.ts');
  });

  it('returns null for something that does not exist', () => {
    write('src/main.ts');

    expect(new TSPathResolver(root).resolve('./nope', 'src/main.ts')).toBeNull();
  });
});

describe('probing the disk (SE-DEP-05)', () => {

  /*
  | تا ۹ بار `existsSync` + `statSync` به‌ازای *هر* import، بدون کش.
  | روی مخزنی با هزاران import همان مسیرها بارها و بارها پرسیده
  | می‌شوند.
  */
  it('does not ask the filesystem about the same path twice', () => {
    write('src/thing.ts');
    write('src/main.ts');
    const resolver = new TSPathResolver(root);

    resolver.resolve('./thing', 'src/main.ts');
    const afterFirst = resolver.stats().diskProbes;
    resolver.resolve('./thing', 'src/main.ts');

    expect(afterFirst).toBeGreaterThan(0);
    expect(resolver.stats().diskProbes).toBe(afterFirst);
  });

  /*
  | پاسخ منفی گران‌ترین حالت است: هر ۱۹ شکل ممکن پرسیده می‌شود و
  | هیچ‌کدام نیست. کش نکردنش یعنی هر import ناموفق، هر بار، ۱۹ بار.
  */
  it('remembers a negative answer too', () => {
    write('src/main.ts');
    const resolver = new TSPathResolver(root);

    expect(resolver.resolve('./nope', 'src/main.ts')).toBeNull();
    const afterFirst = resolver.stats().diskProbes;

    expect(resolver.resolve('./nope', 'src/main.ts')).toBeNull();
    expect(resolver.stats().diskProbes).toBe(afterFirst);
  });

  it('probes far less on the second pass over a real import list', () => {
    for (let index = 0; index < 20; index++) write(`src/mod${index}.ts`);
    write('src/main.ts');
    const resolver = new TSPathResolver(root);

    for (let index = 0; index < 20; index++) resolver.resolve(`./mod${index}`, 'src/main.ts');
    const afterFirstPass = resolver.stats().diskProbes;

    for (let index = 0; index < 20; index++) resolver.resolve(`./mod${index}`, 'src/main.ts');

    expect(resolver.stats().diskProbes).toBe(afterFirstPass);
  });

  it('gives the same answer cached as uncached', () => {
    write('src/folder/index.ts');
    write('src/main.ts');
    const resolver = new TSPathResolver(root);

    const first = resolver.resolve('./folder', 'src/main.ts');
    const second = resolver.resolve('./folder', 'src/main.ts');

    expect(second).toBe(first);
    expect(first).toBe('src/folder/index.ts');
  });
});
