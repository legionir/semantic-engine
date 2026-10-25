import { ReverseDependencyIndex } from './ReverseDependencyIndex';
import { Graphs, DependencyEdge, TypeEdge, CallEdge } from '../core/types/project-index.types';

describe('ReverseDependencyIndex', () => {
  it('should reverse file-level imports', () => {
    const graphs: Graphs = {
      callGraph: [],
      typeGraph: [],
      dependencyGraph: [
        { from: 'file-a', to: 'file-b', kind: 'import', provenance: { extractor: 'heuristic', confidence: 95, basis: 'ast' } },
        { from: 'file-c', to: 'file-b', kind: 'import', provenance: { extractor: 'heuristic', confidence: 95, basis: 'ast' } },
        { from: 'file-a', to: 'lodash', kind: 'package', provenance: { extractor: 'heuristic', confidence: 95, basis: 'ast' } },
      ],
    };

    const index = new ReverseDependencyIndex({ includeSymbolLevel: false });
    const reverse = index.build(graphs);

    const importedByB = reverse.filter(e => e.from === 'file-b');
    expect(importedByB).toHaveLength(2);
    expect(importedByB.map(e => e.to)).toContain('file-a');
    expect(importedByB.map(e => e.to)).toContain('file-c');
    expect(importedByB.every(e => e.kind === 'imported-by')).toBe(true);
  });

  it('should reverse type relationships', () => {
    const graphs: Graphs = {
      callGraph: [],
      typeGraph: [
        { parent: 'class-a', child: 'class-b', kind: 'extends', provenance: { extractor: 'heuristic', confidence: 95, basis: 'ast' } },
        { parent: 'interface-x', child: 'class-b', kind: 'implements', provenance: { extractor: 'heuristic', confidence: 95, basis: 'ast' } },
      ],
      dependencyGraph: [],
    };

    const index = new ReverseDependencyIndex({ includeSymbolLevel: false });
    const reverse = index.build(graphs);

    /*
    | SE-GRAPH-09 — این تست تا فاز ۱۹ جهت *رو به جلو* را انتظار
    | داشت (`from: parent`)، یعنی همان باگ را به‌عنوان قرارداد ثبت
    | کرده بود. یک ایندکس معکوس باید به «چه کسی به من وابسته است»
    | جواب بدهد: از فرزند به والد.
    |
    | خودِ این تست از فاز ۱۹ تا ۲۱ اصلاً اجرا نمی‌شد — سوئیتش
    | کامپایل نمی‌شد و jest برای سوئیتی که اجرا نشود صفر تست
    | می‌شمارد (SE-BUILD-11).
    */
    expect(reverse).toContainEqual(expect.objectContaining({
      from: 'class-b', to: 'class-a', kind: 'extends',
    }));
    expect(reverse).toContainEqual(expect.objectContaining({
      from: 'class-b', to: 'interface-x', kind: 'implements',
    }));
  });

  it('should reverse call graph when symbol-level is enabled', () => {
    const graphs: Graphs = {
      callGraph: [
        { id: 'e1', caller: 'sym-a', callee: 'sym-b', kind: 'direct', provenance: { extractor: 'heuristic', confidence: 95, basis: 'ast' } },
        { id: 'e2', caller: 'sym-c', callee: 'sym-b', kind: 'conditional', provenance: { extractor: 'heuristic', confidence: 95, basis: 'ast' } },
      ],
      typeGraph: [],
      dependencyGraph: [],
    };

    const index = new ReverseDependencyIndex({ includeSymbolLevel: true });
    const reverse = index.build(graphs);

    const calledByB = reverse.filter(e => e.from === 'sym-b');
    expect(calledByB).toHaveLength(2);
    expect(calledByB.map(e => e.to)).toContain('sym-a');
    expect(calledByB.map(e => e.to)).toContain('sym-c');
  });

  it('should deduplicate reverse edges', () => {
    const graphs: Graphs = {
      callGraph: [
        { id: 'e1', caller: 'sym-a', callee: 'sym-b', kind: 'direct', provenance: { extractor: 'heuristic', confidence: 95, basis: 'ast' } },
        { id: 'e2', caller: 'sym-a', callee: 'sym-b', kind: 'direct', provenance: { extractor: 'heuristic', confidence: 95, basis: 'ast' } },
      ],
      typeGraph: [],
      dependencyGraph: [],
    };

    const index = new ReverseDependencyIndex({ includeSymbolLevel: true });
    const reverse = index.build(graphs);

    expect(reverse.filter(e => e.from === 'sym-b' && e.to === 'sym-a')).toHaveLength(1);
  });
});
