import { TSDependencyExtractor } from './TSDependencyExtractor';

async function exportsOf(content: string) {
  const result = await new TSDependencyExtractor().extractDependencies('f', 'src/a.ts', content, 'typescript');
  if (!result.ok) throw new Error('expected ok');
  return result.value.exports;
}

describe('exported variable declarations produce one ExportEntry per name', () => {
  it('multiple declarators in one statement', async () => {
    expect(await exportsOf('export const a = 1, b = 2, c = 3;')).toEqual([
      { name: 'a', kind: 'named' },
      { name: 'b', kind: 'named' },
      { name: 'c', kind: 'named' },
    ]);
  });

  it('never emits a name that is not an identifier', async () => {
    const names = (await exportsOf('export let x = 1, y = 2;\nexport var { p, q: r } = obj;\nexport const [s, , t] = arr;')).map(e => e.name);
    expect(names).toEqual(['x', 'y', 'p', 'r', 's', 't']);
    for (const name of names) expect(name).toMatch(/^[A-Za-z_$][\w$]*$/);
  });

  it('other exported declarations and default exports are unchanged', async () => {
    expect(await exportsOf('export function f() {}\nexport class C {}\nexport default function () {}')).toEqual([
      { name: 'f', kind: 'named' },
      { name: 'C', kind: 'named' },
      { name: 'default', kind: 'default' },
    ]);
  });
});
