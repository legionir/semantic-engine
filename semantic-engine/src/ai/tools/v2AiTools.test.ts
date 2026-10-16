import { ProjectIndexReader } from '../ProjectIndexReader';
import { SimulateMutationTool } from './SimulateMutationTool';
import { DetectArchitectureViolationsTool } from './DetectArchitectureViolationsTool';
import { GetGitHotspotsTool } from './GetGitHotspotsTool';
import { ProjectIndex } from '../../core/types/project-index.types';

describe('V2 AI Tools (Simulate Mutation, Architecture Violations, Git Hotspots)', () => {
  const sampleIndex = {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    files: [
      { id: 'f1', path: 'src/auth.service.ts', hash: 'h1', size: 100, language: 'typescript' },
      { id: 'f2', path: 'src/user.repo.ts', hash: 'h2', size: 80, language: 'typescript' },
    ],
    symbols: [
      { id: 's1', fileId: 'f1', parentId: null, kind: 'class', name: 'AuthService', line: 1, endLine: 20 },
      { id: 's2', fileId: 'f2', parentId: null, kind: 'class', name: 'UserRepo', line: 1, endLine: 15 },
    ],
    graphs: {
      dependencyGraph: [
        { from: 's1', to: 's2', kind: 'import', provenance: { confidence: 100, basis: 'resolved', extractor: 'tree-sitter' } },
      ],
      callGraph: [],
      typeGraph: [],
    },
  } as unknown as ProjectIndex;

  const reader = new ProjectIndexReader(sampleIndex);

  it('simulate_mutation detects broken references on symbol deletion', async () => {
    const tool = new SimulateMutationTool(reader);
    const result = await tool.execute({
      actionType: 'delete_symbol',
      targetSymbolId: 's2',
    });

    expect(result.success).toBe(true);
    expect(result.items.length).toBe(1);
    /*
    | SE-AI-11 — آیتم حالا **به‌ازای فایل** تجمیع می‌شود، نه به‌ازای هر یال،
    | پس هویت آیتم مسیر فایل است (یکتا و قابل ویرایش) و نام هم همان
    | مسیر خوانا؛ شناسهٔ سمبل فراخوان دیگر در `id` تکراری نمی‌آید، بلكه
    | در `metadata.callerSymbols` و `metadata.diff.brokenReferences` حفظ می‌شود.
    */
    expect(result.items[0]?.name).toBe('src/auth.service.ts');
    expect(result.items[0]?.id).toBe('src/auth.service.ts');
    expect((result.items[0]?.metadata ?? {}).brokenReferenceCount).toBe(1);
    expect(JSON.stringify((result.metadata as { diff: unknown }).diff)).toContain('s1');
  });

  it('فراخوانِ سطح ماژول، فایلش را گم نمی‌کند (callerFile ≠ unknown)', async () => {
    /*
    | `callGraph` می‌تواند `callerKind: "file"` داشته باشد: سرِ یال یک fileId
    | است نه symbolId. تا پیش از این گراف فقط node سمبل داشت، پس
    | `getNode(fileId)` تعریف‌نشده برمی‌گشت و خروجی 'unknown' می‌شد.
    */
    const fileCallerIndex = {
      version: '1.0.0',
      generatedAt: new Date().toISOString(),
      files: [
        { id: 'f1', path: 'src/boot.ts', hash: 'h1', size: 10, language: 'typescript' },
        { id: 'f2', path: 'src/repo.ts', hash: 'h2', size: 20, language: 'typescript' },
      ],
      symbols: [{ id: 's2', fileId: 'f2', parentId: null, kind: 'class', name: 'UserRepo', line: 1, endLine: 9 }],
      graphs: {
        dependencyGraph: [],
        typeGraph: [],
        callGraph: [
          {
            id: 'c1',
            caller: 'f1',
            callerKind: 'file',
            callee: 's2',
            kind: 'direct',
            line: 3,
            provenance: { confidence: 90, basis: 'resolved', extractor: 'tree-sitter' },
          },
        ],
      },
    } as unknown as ProjectIndex;

    const result = await new SimulateMutationTool(new ProjectIndexReader(fileCallerIndex)).execute({
      actionType: 'delete_symbol',
      targetSymbolId: 's2',
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.path).toBe('src/boot.ts');
    /*
    | سطرِ محل فراخوانی هم می‌آید؛ وگرنه «۳ ارجاع شکسته در یک فایل» با
    | «۳ سطر تکراری» فرقی نمی‌کند.
    */
    expect(result.items[0]?.excerpt).toContain('src/boot.ts:3');
    expect(result.context).toContain('across 1 file(s)');
    expect((result.metadata as { diff: { brokenReferences: { callerLabel: string }[] } })
      .diff.brokenReferences[0]!.callerLabel).toBe('src/boot.ts');
  });

  it('detect_architecture_violations analyzes project rules', async () => {
    const tool = new DetectArchitectureViolationsTool(reader);
    const result = await tool.execute({});

    expect(result.success).toBe(true);
    expect(result.context).toContain('Found');
  });

  it('get_git_hotspots identifies hotspots from repository files', async () => {
    const tool = new GetGitHotspotsTool(reader);
    const result = await tool.execute({ limit: 5 });

    expect(result.success).toBe(true);
    expect(result.items.length).toBeGreaterThan(0);
  });
});

describe('detect_architecture_violations — چرخه با نام، نه با هش', () => {
  const cyclicIndex = {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    files: [
      { id: 'fa', path: 'src/a.ts', hash: 'ha', size: 10, language: 'typescript' },
      { id: 'fb', path: 'src/b.ts', hash: 'hb', size: 10, language: 'typescript' },
    ],
    symbols: [],
    graphs: {
      dependencyGraph: [
        { from: 'fa', to: 'fb', kind: 'import', provenance: { confidence: 90, basis: 'resolved', extractor: 'tree-sitter' } },
        { from: 'fb', to: 'fa', kind: 'import', provenance: { confidence: 90, basis: 'resolved', extractor: 'tree-sitter' } },
      ],
      callGraph: [],
      typeGraph: [],
    },
  } as unknown as ProjectIndex;

  it('excerpt مسیر فایل‌ها را می‌گوید و شناسه‌ها در metadata می‌مانند', async () => {
    const result = await new DetectArchitectureViolationsTool(new ProjectIndexReader(cyclicIndex)).execute({});

    const cycles = result.items.filter(item => item.kind === 'architecture_cycle');
    expect(cycles.length).toBeGreaterThan(0);
    expect(String(cycles[0]?.excerpt)).toContain('src/a.ts');
    expect(String(cycles[0]?.excerpt)).toContain('src/b.ts');
    expect(String(cycles[0]?.excerpt)).not.toMatch(/\bfa\b -> \bfb\b/);
    // ترتیب ورود به چرخه به نقطهٔ شروع تشخیص وابسته است؛ مجموعه مهم است.
    expect([...(cycles[0]?.metadata as { nodeIds: string[] }).nodeIds].sort()).toEqual(['fa', 'fb']);
  });
});
