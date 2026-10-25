/**
 * P4 — «توضیح یک کلاس» نباید خالی‌تر از توضیح یک تابع باشد.
 *
 * نسخهٔ اول `explain_symbol` فقط لبه‌های *خودِ* گره را می‌خواند. یال‌های
 * فراخوانی اما به سازنده و متدها وصل‌اند و `complexity` هم روی خودِ اعلان
 * نوشته نمی‌شود، پس برای یک کلاس این جواب درمی‌آمد:
 *
 *   signature: "Widget()" · complexity: null · calls: [] · calledBy: []
 *   confidence: { calls: "none", calledBy: "none" }
 *
 * یعنی کلاسی با چهل متد و سه مصرف‌کننده، دقیقاً مثل کلاسی بی‌استفاده
 * به‌نظر می‌رسید. حالا اعضا، جمع پیچیدگی، یال‌های عضو و شمار
 * referencedBy اضافه می‌شوند — و گفته می‌شود که این‌ها aggregate‌اند.
 */

import { ProjectIndex } from '../../core/types/project-index.types';
import { ProjectIndexReader } from '../ProjectIndexReader';
import { ExplainSymbolTool, SymbolExplanation } from './ExplainSymbolTool';
import { provenanceFor } from '../../graphs/EdgeProvenance';
import { makeConfidence } from '../../core/types/common.types';

const call = (caller: string, callee: string, confidence: number, file: string) => ({
  id: `${caller}->${callee}`,
  caller,
  callee,
  callerKind: 'symbol',
  kind: 'direct',
  line: 10,
  provenance: {
    ...provenanceFor(confidence >= 70 ? 'resolved' : 'name-match', 'typescript-api', { file, line: 10 }),
    confidence,
  },
});

function classIndex(): ProjectIndex {
  return {
    schemaVersion: '2.0.0',
    root: 'test',
    rootPath: '/test',
    generatedAt: new Date().toISOString(),
    languages: ['typescript'],
    files: [
      {
        id: 'f-widget',
        path: 'src/widget.ts',
        language: 'typescript',
        lines: 40,
        hash: 'h1',
        binary: false,
        symbolIds: ['c-widget', 'm-render', 'm-resize'],
        imports: [],
        exports: [],
        outline: [],
        diagnostics: [],
      },
      {
        id: 'f-app',
        path: 'src/app.ts',
        language: 'typescript',
        lines: 12,
        hash: 'h2',
        binary: false,
        symbolIds: ['m-boot'],
        imports: [],
        exports: [],
        outline: [],
        diagnostics: [],
      },
    ],
    symbols: [
      {
        id: 'c-widget',
        fileId: 'f-widget',
        parentId: null,
        kind: 'class',
        name: 'Widget',
        fullyQualifiedName: 'src/widget.ts::Widget',
        signature: 'class Widget implements Renderable',
        line: 3,
        endLine: 38,
        complexity: null,
        referenceCount: null,
        exported: true,
        visibility: 'public',
        parameters: [],
        calls: [],
        calledBy: [],
      },
      {
        id: 'm-render',
        fileId: 'f-widget',
        parentId: 'c-widget',
        kind: 'method',
        name: 'render',
        fullyQualifiedName: 'src/widget.ts::Widget.render',
        signature: 'render(ctx: Ctx): void',
        line: 8,
        endLine: 20,
        complexity: 4,
        referenceCount: 2,
        exported: false,
        visibility: 'public',
        parameters: [],
        calls: [],
        calledBy: [],
      },
      {
        id: 'm-resize',
        fileId: 'f-widget',
        parentId: 'c-widget',
        kind: 'method',
        name: 'resize',
        fullyQualifiedName: 'src/widget.ts::Widget.resize',
        signature: 'resize(w: number): void',
        line: 22,
        endLine: 30,
        complexity: 6,
        referenceCount: 1,
        exported: false,
        visibility: 'private',
        parameters: [],
        calls: [],
        calledBy: [],
      },
      {
        id: 'm-boot',
        fileId: 'f-app',
        parentId: null,
        kind: 'method',
        name: 'boot',
        fullyQualifiedName: 'src/app.ts::App.boot',
        signature: 'boot(): void',
        line: 10,
        endLine: 11,
        complexity: 1,
        referenceCount: null,
        exported: false,
        visibility: 'public',
        parameters: [],
        calls: [],
        calledBy: [],
      },
    ],
    graphs: {
      callGraph: [
        call('m-boot', 'm-render', 95, 'src/app.ts'),
        call('m-render', 'm-resize', 90, 'src/widget.ts'),
        call('m-boot', 'm-resize', 40, 'src/app.ts'),
      ],
      dependencyGraph: [],
      typeGraph: [],
      reverseDependencyGraph: [],
    },
    diagnostics: [],
    metrics: {},
  } as unknown as ProjectIndex;
}

const explain = async (input: Record<string, unknown>) => {
  const result = await new ExplainSymbolTool(new ProjectIndexReader(classIndex())).execute(input);
  return { result, explanation: result.items[0]?.metadata as unknown as SymbolExplanation & Record<string, unknown> };
};

describe('explain_symbol روی یک سمبل اعلانی', () => {
  it('اعضا، شمارشان و جمع پیچیدگی را می‌دهد', async () => {
    const { explanation } = await explain({ id: 'c-widget' });

    expect(explanation.memberCount).toBe(2);
    expect((explanation.members as unknown[]).map((m: any) => m.name)).toEqual(['render', 'resize']);
    expect(explanation.aggregateComplexity).toBe(10);
    /* امضای اعلانیِ درست، همان‌که در ایندکس است — بی‌آنکه ابزار بسازد. */
    expect(explanation.signature).toBe('class Widget implements Renderable');
  });

  it('یال‌های اعضا را هم می‌بیند و می‌گوید این‌ها aggregate‌اند', async () => {
    const { explanation } = await explain({ id: 'c-widget' });

    /* نام‌ها بدون پیشوند فایل‌اند — مسیر در فیلد `path` خودش هست. */
    expect(explanation.calledBy.map(entry => entry.name)).toEqual(['App.boot']);
    expect(explanation.calledBy[0]!.path).toBe('src/app.ts');
    /*
    | `m-render → m-resize` call داخلیِ خودِ کلاس است؛ در `calls` نمی‌آید
    | (جای آن در `members` است) وگرنه هر کلاسِ با‌ثبات، «به خودش وابسته است».
    */
    expect(explanation.calls).toEqual([]);
    expect(explanation.aggregation).toMatchObject({ owners: 3, fromMembers: 1 });
  });

  it('referencedBy تعداد منبع و فایل متمایز را می‌دهد', async () => {
    const { explanation } = await explain({ id: 'c-widget' });

    expect(explanation.referencedBy).toEqual({ sources: 1, files: 1 });
  });

  it('برای تابع، هیچ‌کدام از این کلیدها اضافه نمی‌شود', async () => {
    const { explanation } = await explain({ id: 'm-boot' });

    expect(explanation.members).toBeUndefined();
    expect(explanation.memberCount).toBeUndefined();
    expect(explanation.aggregateComplexity).toBeUndefined();
    expect(explanation.aggregation).toBeUndefined();
    expect(explanation.referencedBy).toBeUndefined();
  });

  it('اعلان بدون عضو، memberCount: 0 نمی‌سازد — همان پاسخ قبلی، بدون نویز', async () => {
    const index = classIndex();
    const withoutMembers = {
      ...index,
      symbols: index.symbols.filter(s => s.id !== 'm-render' && s.id !== 'm-resize'),
    } as ProjectIndex;

    const result = await new ExplainSymbolTool(new ProjectIndexReader(withoutMembers)).execute({ id: 'c-widget' });
    const explanation = result.items[0]?.metadata as unknown as Record<string, unknown>;

    expect(explanation.members).toBeUndefined();
    expect(explanation.signature).toBe('class Widget implements Renderable');
  });
});
