/**
 * AssembleContextTool — نخستین آزمون‌هایی که این ابزار تا فاز ۴۲ داشت.
 *
 * ابزاری که «context بهینه برای یک task» می‌سازد، بدون هیچ آزمونی سه
 * ادعای اثبات‌نشده داشت و هر سه غلط بودند:
 *
 *   ۱. «تغییرات اخیر را می‌آورد» — SE-AI-05: `GitClient` با یک مسیر
 *      *نسبی* ساخته می‌شد، `cwd` نامعتبر می‌شد، و بلوک `catch` بی‌صدا
 *      ردش می‌کرد. اندازه‌گیری روی ایندکس واقعی: حتی با بودجهٔ
 *      ۱۰۰٬۰۰۰ توکن، صفر سطرِ commit.
 *   ۲. «بودجهٔ توکن» — از انتها می‌بُرید؛ بخش تست‌ها اولین قربانی بود
 *      و از بودجه هم رد می‌شد (SE-AI-16).
 *   ۳. `metadata.relatedSymbols` تعداد *پیداشده* را گزارش می‌کرد نه
 *      تعداد *نوشته‌شده* (SE-AI-17).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

import { ProjectIndex } from '../../core/types/project-index.types';
import { ProjectIndexReader } from '../ProjectIndexReader';
import { AssembleContextTool } from './AssembleContextTool';
import { provenanceFor } from '../../graphs/EdgeProvenance';
import { makeConfidence } from '../../core/types/common.types';
import { estimateTokens } from '../ranking/TokenBudget';

function file(id: string, filePath: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    path: filePath,
    language: 'typescript',
    size: 400,
    lines: 120,
    hash: 'h',
    binary: false,
    testFile: /\.test\.ts$/.test(filePath),
    symbolIds: [],
    imports: [],
    exports: [],
    diagnostics: [],
    outline: [],
    aiMetadata: {
      summary: `${filePath} does a thing that is long enough to matter for a token budget`,
      aiScore: { importance: 50, readPriority: 50, hotness: 20 },
    },
    ...extra,
  };
}

function symbolIn(id: string, fileId: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    fileId,
    parentId: null,
    kind: 'function',
    name,
    fullyQualifiedName: name,
    signature: `function ${name}(input: string): Promise<void>`,
    visibility: 'public',
    line: 3,
    endLine: 20,
    documentation: null,
    deprecated: false,
    exported: true,
    source: 'tree-sitter',
    confidence: makeConfidence(90),
    async: true,
    generator: false,
    abstract: false,
    static: false,
    readonly: false,
    parameters: [],
    returnType: null,
    generics: [],
    extends: [],
    implements: [],
    complexity: 4,
    referenceCount: null,
    calls: [],
    calledBy: [],
    testIds: [],
    ...extra,
  };
}

/*
| ساختار آزمون:
|
|   target.ts ──import──▶ dep-0..dep-11.ts          (۱۲ همسایه، هر کدام پرحجم)
|   target.test.ts                                   (تستِ هدف — آخرین بخش)
*/
function index(rootPath?: string): ProjectIndex {
  const deps = Array.from({ length: 12 }, (_, i) => file(`f-dep-${i}`, `src/dep-${i}.ts`));
  const files = [
    file('f-target', 'src/target.ts'),
    ...deps,
    file('f-test', 'src/target.test.ts'),
  ];

  const symbols = [
    symbolIn('s-target', 'f-target', 'runTarget', { testIds: ['f-test'] }),
    ...deps.map((d, i) => symbolIn(`s-dep-${i}`, d.id, `helper${i}`)),
  ];

  const dep = (from: string, to: string) => ({
    from,
    to,
    kind: 'import' as const,
    provenance: {
      ...provenanceFor('import-resolved', 'typescript-api', { file: from, line: 1 }),
      confidence: 95,
    },
  });

  return {
    schemaVersion: '2.0.0',
    generatedAt: '2026-08-19T00:00:00.000Z',
    root: 'fixture',
    ...(rootPath ? { rootPath } : {}),
    languages: ['typescript'],
    files,
    symbols,
    graphs: {
      dependencyGraph: deps.map(d => dep('f-target', d.id)),
      reverseDependencyGraph: deps.map(d => dep(d.id, 'f-target')),
      callGraph: [],
      typeGraph: [],
    },
    diagnostics: [],
    metrics: {
      totalFiles: files.length,
      totalLoc: 1000,
      totalSymbols: symbols.length,
      avgCyclomaticComplexity: 3,
      languageBreakdown: { typescript: files.length },
    },
  } as unknown as ProjectIndex;
}

function reader(rootPath?: string): ProjectIndexReader {
  return new ProjectIndexReader(index(rootPath));
}

describe('AssembleContextTool — بودجهٔ آگاه از ساختار (GAP-07)', () => {
  it('معیار پذیرش فاز ۴۲: با بودجهٔ کم، بخش تست‌ها حذف نمی‌شود', async () => {
    const tool = new AssembleContextTool(reader());
    const result = await tool.execute({
      task: 'fix runTarget',
      targetFiles: ['src/target.ts'],
      maxTokens: 220,
      includeTests: true,
    });

    expect(result.success).toBe(true);
    expect(result.context).toContain('=== Related Tests ===');
    expect(result.context).toContain('src/target.test.ts');
  });

  it('بخش «فایل‌های مرتبط» است که کوچک می‌شود، نه بخش تست‌ها', async () => {
    const tool = new AssembleContextTool(reader());
    const result = await tool.execute({
      task: 'fix runTarget',
      targetFiles: ['src/target.ts'],
      maxTokens: 220,
      includeTests: true,
    });

    const budget = result.metadata!.budget as { sections: { name: string; kept: number; dropped: number }[] };
    const related = budget.sections.find(s => s.name === 'relatedFiles')!;
    const tests = budget.sections.find(s => s.name === 'tests')!;

    expect(related.dropped).toBeGreaterThan(0);
    expect(tests.kept).toBeGreaterThanOrEqual(1);
  });

  it('هرگز از maxTokens رد نمی‌شود — SE-AI-16', async () => {
    const tool = new AssembleContextTool(reader());

    for (const maxTokens of [40, 120, 300, 800, 4000]) {
      const result = await tool.execute({
        task: 'fix runTarget',
        targetFiles: ['src/target.ts'],
        maxTokens,
        includeTests: true,
      });

      expect(estimateTokens(result.context ?? '')).toBeLessThanOrEqual(maxTokens);
      expect(result.metadata!.estimatedTokens as number).toBeLessThanOrEqual(maxTokens);
    }
  });

  it('هیچ سطری وسطش بریده نمی‌شود', async () => {
    const tool = new AssembleContextTool(reader());
    const result = await tool.execute({
      task: 'fix runTarget',
      targetFiles: ['src/target.ts'],
      maxTokens: 200,
    });

    for (const line of (result.context ?? '').split('\n')) {
      if (!line.startsWith('- ')) continue;
      // هر سطرِ آیتم یا با شرح تمام می‌شود یا با پرانتزِ بستهٔ متادیتا؛
      // آنچه رخ نباید بدهد، پایانِ ناگهانی وسط یک مسیر است.
      expect(line.endsWith('…')).toBe(false);
    }
  });

  it('متادیتای بودجه، تعداد نوشته‌شده را گزارش می‌کند نه پیداشده — SE-AI-17', async () => {
    const tool = new AssembleContextTool(reader());
    const result = await tool.execute({
      task: 'fix runTarget',
      targetFiles: ['src/target.ts'],
      maxTokens: 220,
    });

    const budget = result.metadata!.budget as { sections: { name: string; kept: number }[] };
    const related = budget.sections.find(s => s.name === 'relatedFiles')!;
    const rendered = (result.context ?? '')
      .split('\n')
      .filter(l => /^- src\/dep-\d+\.ts/.test(l)).length;

    expect(related.kept).toBe(rendered);
    expect(result.metadata!.relatedFiles).toBe(rendered);
  });
});

describe('AssembleContextTool — رتبه‌بندی (GAP-06)', () => {
  it('آیتم‌ها با امتیاز برگردانده می‌شوند و مرتب‌اند', async () => {
    const tool = new AssembleContextTool(reader());
    const result = await tool.execute({
      task: 'fix runTarget',
      targetFiles: ['src/target.ts'],
      maxTokens: 4000,
    });

    const scores = result.items.map(i => i.relevanceScore);
    expect(scores.every(s => typeof s === 'number')).toBe(true);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1]!).toBeGreaterThanOrEqual(scores[i]!);
    }
  });

  it('هر آیتم می‌گوید از کجا آمده و چند هاپ فاصله دارد', async () => {
    const tool = new AssembleContextTool(reader());
    const result = await tool.execute({
      task: 'fix runTarget',
      targetFiles: ['src/target.ts'],
      maxTokens: 4000,
    });

    const target = result.items.find(i => i.path === 'src/target.ts')!;
    expect(target.metadata!.section).toBe('targetFiles');
    expect(target.metadata!.graphHops).toBe(0);

    const dep = result.items.find(i => i.path === 'src/dep-0.ts');
    if (dep) expect(dep.metadata!.graphHops).toBe(1);
  });

  it('فایلی با importance بالاتر، بالاتر از فایلی با importance پایین می‌ایستد', async () => {
    const base = index();
    const bumped = {
      ...base,
      files: base.files.map(f =>
        f.path === 'src/dep-5.ts'
          ? { ...f, aiMetadata: { ...f.aiMetadata, aiScore: { importance: 100, readPriority: 100, hotness: 90 } } }
          : f.path === 'src/dep-6.ts'
            ? { ...f, aiMetadata: { ...f.aiMetadata, aiScore: { importance: 1, readPriority: 1, hotness: 0 } } }
            : f
      ),
    } as ProjectIndex;

    const tool = new AssembleContextTool(new ProjectIndexReader(bumped));
    const result = await tool.execute({
      task: 'fix runTarget',
      targetFiles: ['src/target.ts'],
      maxTokens: 4000,
    });

    const ids = result.items.map(i => i.path);
    expect(ids.indexOf('src/dep-5.ts')).toBeLessThan(ids.indexOf('src/dep-6.ts'));
  });
});

describe('AssembleContextTool — تغییرات اخیر (SE-AI-05)', () => {
  let repoRoot: string;

  beforeAll(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-engine-assemble-'));
    const run = (...args: string[]) => execFileSync('git', args, { cwd: repoRoot, stdio: 'ignore' });
    run('init');
    run('config', 'user.email', 'probe@example.com');
    run('config', 'user.name', 'Probe');
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'src', 'target.ts'), 'export const a = 1;\n');
    run('add', '.');
    run('commit', '-m', 'add the target module');
  });

  afterAll(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('با rootPath در ایندکس، commit های واقعی را می‌آورد', async () => {
    const tool = new AssembleContextTool(reader(repoRoot));
    const result = await tool.execute({
      task: 'fix runTarget',
      targetFiles: ['src/target.ts'],
      maxTokens: 4000,
      includeRecentChanges: true,
    });

    expect(result.context).toContain('=== Recent Changes ===');
    expect(result.context).toContain('add the target module');
  });

  it('روش قدیمی — dirname یک مسیر نسبی — هرگز نمی‌توانست کار کند', async () => {
    // ثبت علتِ باگ: `path.dirname('src/target.ts')` می‌شود `'src'`، که
    // نسبت به cwdِ پروسه تفسیر می‌شود و ربطی به مخزن ندارد.
    expect(path.isAbsolute(path.dirname('src/target.ts'))).toBe(false);
  });

  it('بدون rootPath، بی‌صدا رد می‌شود ولی در متادیتا اعلام می‌کند', async () => {
    const tool = new AssembleContextTool(reader());
    const result = await tool.execute({
      task: 'fix runTarget',
      targetFiles: ['src/target.ts'],
      maxTokens: 4000,
      includeRecentChanges: true,
    });

    expect(result.success).toBe(true);
    expect(result.context).not.toContain('=== Recent Changes ===');
    expect(result.metadata!.recentChanges).toBe('unavailable: no workspace root');
  });

  it('workspaceRoot صریحِ سازنده بر rootPath ایندکس مقدم است', async () => {
    const tool = new AssembleContextTool(reader('/definitely/not/a/repo'), undefined, {
      workspaceRoot: repoRoot,
    });
    const result = await tool.execute({
      task: 'fix runTarget',
      targetFiles: ['src/target.ts'],
      maxTokens: 4000,
      includeRecentChanges: true,
    });

    expect(result.context).toContain('add the target module');
  });

  it('بودجهٔ بیشتر هرگز باعث ناپدیدشدن تغییرات اخیر نمی‌شود — SE-AI-18', async () => {
    // اندازه‌گیری روی ایندکس واقعی نشان داد با بودجهٔ ۲۰۰ توکن یک سطر
    // commit می‌آمد و با ۴۰۰ توکن هیچ سطری. سطرهای commit امتیاز صفر
    // می‌گیرند (رتبه‌بند هیچ سیگنالی دربارهٔ آنها ندارد)، پس در استخر
    // سراسری آخر می‌ایستند و باید سهم تضمین‌شده داشته باشند.
    const tool = new AssembleContextTool(reader(repoRoot));

    for (let maxTokens = 150; maxTokens <= 900; maxTokens += 50) {
      const result = await tool.execute({
        task: 'fix runTarget',
        targetFiles: ['src/target.ts'],
        maxTokens,
        includeRecentChanges: true,
      });

      const budget = result.metadata!.budget as { sections: { name: string; kept: number }[] };
      const recent = budget.sections.find(s => s.name === 'recentChanges')!;
      expect({ maxTokens, kept: recent.kept > 0 }).toEqual({ maxTokens, kept: true });
    }
  });
});

describe('AssembleContextTool — مسیرهای پایه', () => {
  it('هدفِ ناموجود خطا نمی‌دهد', async () => {
    const tool = new AssembleContextTool(reader());
    const result = await tool.execute({
      task: 'anything',
      targetFiles: ['src/does-not-exist.ts'],
      maxTokens: 1000,
    });

    expect(result.success).toBe(true);
  });

  it('بدون هیچ هدفی، از جست‌وجو دانه می‌گیرد', async () => {
    const tool = new AssembleContextTool(reader());
    const result = await tool.execute({ task: 'helper3', maxTokens: 1000 });

    expect(result.success).toBe(true);
    expect(result.items.length).toBeGreaterThan(0);
  });

  it('task همیشه در سرِ context می‌آید', async () => {
    const tool = new AssembleContextTool(reader());
    const result = await tool.execute({
      task: 'fix runTarget',
      targetFiles: ['src/target.ts'],
      maxTokens: 4000,
    });

    expect((result.context ?? '').startsWith('Task: fix runTarget')).toBe(true);
  });

  it('نتیجه دترمینیستیک است', async () => {
    const tool = new AssembleContextTool(reader());
    const input = { task: 'fix runTarget', targetFiles: ['src/target.ts'], maxTokens: 300 };
    const a = await tool.execute(input);
    const b = await tool.execute(input);

    expect(a.context).toBe(b.context);
  });
});

describe('AssembleContextTool — پاسخ فشرده برای مدل', () => {
  const input = { task: 'fix runTarget', targetFiles: ['src/target.ts'], maxTokens: 400 } as const;

  it('پیش‌فرض: بدون signals و keptIds', async () => {
    const result = await new AssembleContextTool(reader()).execute(input);
    expect(result.success).toBe(true);
    expect(result.items.length).toBeGreaterThan(0);
    for (const item of result.items) {
      expect(item.metadata).not.toHaveProperty('signals');
    }
    const budget = result.metadata!['budget'] as { sections: Array<Record<string, unknown>> };
    for (const section of budget.sections) {
      expect(section).not.toHaveProperty('keptIds');
    }
  });

  it('explain: true توضیح رتبه‌بندی را برمی‌گرداند', async () => {
    const result = await new AssembleContextTool(reader()).execute({ ...input, explain: true });
    expect(result.items.some(item => Array.isArray((item.metadata as { signals?: unknown })?.signals))).toBe(true);
    const budget = result.metadata!['budget'] as { sections: Array<{ keptIds?: string[] }> };
    expect(budget.sections.some(section => Array.isArray(section.keptIds))).toBe(true);
  });

  it('explain نامعتبر رد می‌شود', async () => {
    const result = await new AssembleContextTool(reader()).execute({ ...input, explain: 'yes' as unknown as boolean });
    expect(result.success).toBe(false);
  });
});
