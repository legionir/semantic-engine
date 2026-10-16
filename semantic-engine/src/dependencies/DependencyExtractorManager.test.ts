import { DependencyExtractorManager } from './DependencyExtractorManager';
import { DependencyExtractionResult, IDependencyExtractor } from './IDependencyExtractor';
import { ExtractionSource, Result, err, ok } from '../core/types/common.types';
import { HeuristicDependencyExtractor } from './heuristic/HeuristicDependencyExtractor';

const imp = (from: string) => ({ from, type: 'package' as const, resolvedFileId: null });

function fake(
  name: ExtractionSource,
  priority: number,
  behaviour: () => Promise<Result<DependencyExtractionResult>>,
  available: () => Promise<boolean> = async () => true
): IDependencyExtractor {
  return { name, priority, isAvailable: available, extractDependencies: behaviour, dispose: async () => undefined };
}

describe('DependencyExtractorManager — isolation, partial results, diagnostics', () => {
  it('a throwing extractor does not stop the next one and is reported', async () => {
    const manager = new DependencyExtractorManager();
    manager.register(fake('typescript' as ExtractionSource, 100, async () => { throw new Error('boom'); }));
    manager.register(fake('heuristic', 10, async () => ok({ imports: [imp('x')], exports: [], partial: false })));

    const result = await manager.extract('f', 'a.ts', '', 'typescript');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.imports.map(i => i.from)).toEqual(['x']);
    expect(result.value.diagnostics?.join(' ')).toMatch(/threw: boom/);
  });

  it('a rejecting isAvailable is isolated too', async () => {
    const manager = new DependencyExtractorManager();
    manager.register(fake('typescript' as ExtractionSource, 100, async () => ok({ imports: [], exports: [], partial: false }), async () => { throw new Error('probe failed'); }));
    manager.register(fake('heuristic', 10, async () => ok({ imports: [imp('y')], exports: [], partial: false })));
    const result = await manager.extract('f', 'a.ts', '', 'typescript');
    expect(result.ok && result.value.imports[0]?.from).toBe('y');
  });

  it('keeps the richest partial result and every diagnostic when nothing is complete', async () => {
    const manager = new DependencyExtractorManager();
    manager.register(fake('typescript' as ExtractionSource, 100, async () => ok({ imports: [imp('a'), imp('b')], exports: [], partial: true })));
    manager.register(fake('lsp' as ExtractionSource, 50, async () => err(new Error('lsp down'))));
    manager.register(fake('heuristic', 10, async () => ok({ imports: [imp('c')], exports: [], partial: true })));

    const result = await manager.extract('f', 'a.ts', '', 'typescript');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.partial).toBe(true);
    expect(result.value.imports.map(i => i.from)).toEqual(['a', 'b']);
    const text = (result.value.diagnostics ?? []).join('|');
    expect(text).toMatch(/typescript.*partial/);
    expect(text).toMatch(/lsp down/);
    expect(text).toMatch(/heuristic.*partial/);
  });

  it('a clean first result carries no diagnostics; total failure lists every attempt', async () => {
    const clean = new DependencyExtractorManager();
    clean.register(fake('heuristic', 10, async () => ok({ imports: [], exports: [], partial: false })));
    const ok1 = await clean.extract('f', 'a', '', 'python');
    expect(ok1.ok && ok1.value.diagnostics).toBeUndefined();

    const bad = new DependencyExtractorManager();
    bad.register(fake('heuristic', 10, async () => { throw new Error('one'); }));
    bad.register(fake('typescript' as ExtractionSource, 100, async () => err(new Error('two'))));
    const failed = await bad.extract('f', 'a', '', 'python');
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.message).toMatch(/one.*|two/s);
    if (!failed.ok) expect(failed.error.message).toMatch(/two/);
    if (!failed.ok) expect(failed.error.message).toMatch(/one/);
  });
});

describe('HeuristicDependencyExtractor contract', () => {
  it('ignores filePath and never sets resolvedFileId (resolution is the pipeline stage)', async () => {
    const extractor = new HeuristicDependencyExtractor();
    const src = 'import os\nfrom .local import thing\n';
    const one = await extractor.extractDependencies('f1', 'a/b.py', src, 'python');
    const two = await extractor.extractDependencies('f1', 'z/other/path.py', src, 'python');
    expect(one).toEqual(two);
    if (one.ok) for (const i of one.value.imports) expect(i.resolvedFileId ?? null).toBeNull();
  });

  it('the documented language list equals the implemented one', async () => {
    const source = require('fs').readFileSync(require.resolve('./heuristic/HeuristicDependencyExtractor.ts'), 'utf8') as string;
    const header = source.slice(0, source.indexOf('*/'));
    const documented = [...header.matchAll(/^ \* - ([a-z, ]+):/gm)].flatMap(m => m[1]!.split(',').map(s => s.trim()));
    const extractor = new HeuristicDependencyExtractor();
    const implemented: string[] = [];
    for (const lang of ['python','go','php','shellscript','java','rust','csharp','c','cpp','ruby','swift','kotlin','javascript','typescript','lua']) {
      if (await extractor.isAvailable(lang)) implemented.push(lang);
    }
    expect(documented.sort()).toEqual(implemented.sort());
  });
});
