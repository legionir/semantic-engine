/**
 * معیار پذیرش فاز ۴۴.
 *
 * > جست‌وجوی «reset password email» فایل مربوطه را بیابد حتی اگر نام
 * > آن این کلمات را نداشته باشد.
 *
 * این آزمون دقیقاً همان را می‌سنجد و عمداً سخت چیده شده:
 *
 * - فایلِ درست `src/AccountOps.ts` نام دارد. نه مسیرش، نه نام
 *   نمادهایش، هیچ‌کدام واژهٔ `reset`، `password` یا `email` را
 *   ندارند. فقط **بدنه‌اش** دارد.
 * - یک فایلِ طعمه هست که *نامش* پر از آن واژه‌هاست ولی کارش چیز
 *   دیگری است.
 *
 * تا پیش از فاز ۴۴ این ناممکن بود، به دو دلیل مستقل:
 *
 * ۱. SE-VEC-01 — chunkها فقط برچسب بودند (نام، امضا، مسیر)، پس بدنه
 *    اصلاً وارد بردار نمی‌شد.
 * ۲. SE-VEC-02/10 — تنها generator موجود `@xenova/transformers`
 *    می‌خواست که به‌خاطر `sharp` بارگذاری نمی‌شد، پس مسیر برداری در
 *    پیکربندی پیش‌فرض هرگز اجرا نمی‌شد.
 */

import { ProjectIndex, VectorChunk } from '../core/types/project-index.types';
import { makeConfidence } from '../core/types/common.types';
import { VectorIndexer } from '../vector/VectorIndexer';
import { HashingEmbeddingGenerator } from '../vector/HashingEmbeddingGenerator';
import { ProjectIndexReader } from './ProjectIndexReader';
import { SemanticSearchTool } from './tools/SemanticSearchTool';

/* بدنه‌ای که واژه‌های پرس‌وجو را دارد، در فایلی که نامش ندارد. */
const ACCOUNT_OPS = `import { Mailer } from './mailer';

export async function beginRecovery(userId: string): Promise<void> {
  const token = await issueToken(userId);
  const link = composeLink(token);
  await Mailer.sendEmail(userId, 'Your password reset link', link);
}

function composeLink(token: string): string {
  return 'https://app.example.com/password/reset?token=' + token;
}

function issueToken(userId: string): Promise<string> {
  return Promise.resolve(userId + ':' + Date.now());
}
`;

/* نامش پر از واژه‌های پرس‌وجوست، ولی کارش ربطی ندارد. */
const DECOY = `export const RESET_PASSWORD_EMAIL_ICON = 'icon-32.png';

export function iconPath(name: string): string {
  return '/assets/icons/' + name;
}
`;

const UNRELATED = `export function parseSyntaxTree(source: string): unknown {
  return { kind: 'program', body: source.length };
}
`;

function file(id: string, path: string, source: string) {
  return {
    id,
    path,
    language: 'typescript',
    size: source.length,
    lines: source.split('\n').length,
    hash: 'h',
    binary: false,
    testFile: false,
    symbolIds: [],
    imports: [],
    exports: [],
    diagnostics: [],
    outline: [],
  };
}

function sym(id: string, fileId: string, name: string, line: number, endLine: number) {
  return {
    id,
    fileId,
    parentId: null,
    kind: 'function',
    name,
    fullyQualifiedName: name,
    signature: `${name}()`,
    visibility: 'public',
    line,
    endLine,
    documentation: null,
    deprecated: false,
    exported: true,
    source: 'tree-sitter',
    confidence: makeConfidence(90),
    async: false,
    generator: false,
    abstract: false,
    static: false,
    readonly: false,
    parameters: [],
    returnType: null,
    generics: [],
    extends: [],
    implements: [],
    complexity: 1,
    referenceCount: null,
    calls: [],
    calledBy: [],
  };
}

function baseIndex(): ProjectIndex {
  const files = [
    file('f-ops', 'src/AccountOps.ts', ACCOUNT_OPS),
    file('f-decoy', 'src/ResetPasswordEmailIcons.ts', DECOY),
    file('f-parse', 'src/SyntaxTools.ts', UNRELATED),
  ];
  const symbols = [
    sym('s-begin', 'f-ops', 'beginRecovery', 3, 7),
    sym('s-link', 'f-ops', 'composeLink', 9, 11),
    sym('s-icon', 'f-decoy', 'iconPath', 3, 5),
    sym('s-parse', 'f-parse', 'parseSyntaxTree', 1, 3),
  ];

  return {
    schemaVersion: '2.0.0',
    root: 'fixture',
    generatedAt: '2026-08-19T00:00:00.000Z',
    languages: ['typescript'],
    files,
    symbols,
    graphs: {
      dependencyGraph: [],
      reverseDependencyGraph: [],
      callGraph: [],
      typeGraph: [],
    },
    diagnostics: [],
    metrics: {
      totalFiles: files.length,
      totalLoc: 30,
      totalSymbols: symbols.length,
      avgCyclomaticComplexity: 1,
      languageBreakdown: { typescript: files.length },
    },
  } as unknown as ProjectIndex;
}

const CONTENTS = new Map([
  ['f-ops', ACCOUNT_OPS],
  ['f-decoy', DECOY],
  ['f-parse', UNRELATED],
]);

async function indexWithVectors(withSource: boolean): Promise<ProjectIndex> {
  const base = baseIndex();
  const chunks: VectorChunk[] = await new VectorIndexer({
    embeddingGenerator: new HashingEmbeddingGenerator(),
  }).index(base, withSource ? { contents: CONTENTS } : {});

  return { ...base, vectorChunks: chunks };
}

describe('معیار پذیرش فاز ۴۴ — پیدا کردن فایل بر اساس محتوا، نه نام', () => {
  it('«reset password email» فایلی را می‌یابد که نامش این کلمات را ندارد', async () => {
    const projectIndex = await indexWithVectors(true);
    const tool = new SemanticSearchTool(
      new ProjectIndexReader(projectIndex),
      new HashingEmbeddingGenerator()
    );

    const result = await tool.execute({ query: 'reset password email', limit: 5 });
    const paths = result.items.map(i => i.path);

    expect(paths).toContain('src/AccountOps.ts');
  });

  it('نامِ فایلِ درست واقعاً هیچ‌کدام از واژه‌های پرس‌وجو را ندارد', () => {
    const target = 'src/AccountOps.ts'.toLowerCase();
    for (const term of ['reset', 'password', 'email']) {
      expect(target).not.toContain(term);
    }
    for (const name of ['beginRecovery', 'composeLink', 'issueToken']) {
      for (const term of ['reset', 'password', 'email']) {
        expect(name.toLowerCase()).not.toContain(term);
      }
    }
  });

  it('بدون سورس در chunk، همین پرس‌وجو آن فایل را پیدا نمی‌کند — SE-VEC-01', async () => {
    const projectIndex = await indexWithVectors(false);
    const tool = new SemanticSearchTool(
      new ProjectIndexReader(projectIndex),
      new HashingEmbeddingGenerator()
    );

    const result = await tool.execute({ query: 'reset password email', limit: 5 });
    const opsHits = result.items.filter(i => i.path === 'src/AccountOps.ts');

    expect(opsHits).toEqual([]);
  });

  it('مسیر برداری واقعاً اجرا شد، نه اینکه کلیدواژه جواب داده باشد', async () => {
    const projectIndex = await indexWithVectors(true);
    const tool = new SemanticSearchTool(
      new ProjectIndexReader(projectIndex),
      new HashingEmbeddingGenerator()
    );

    const result = await tool.execute({ query: 'reset password email', limit: 5 });

    expect(result.metadata!.usedEmbeddings).toBe(true);
    expect(result.metadata!.embeddingCandidates as number).toBeGreaterThan(0);

    const ops = result.items.find(i => i.path === 'src/AccountOps.ts')!;
    expect(ops.metadata!.signals).toContain('vector');
  });

  it('بدون تزریق generator هم مسیر برداری اجرا می‌شود — SE-VEC-02', async () => {
    /*
    | این همان بن‌بستی است که SE-VEC-02 توصیفش کرد: سازندهٔ تنبل فقط
    | *داخل* `getEmbeddingCandidates` صدا زده می‌شد، و آن‌جا فقط
    | وقتی می‌رسیدیم که generator از قبل وجود داشته باشد.
    |
    | اینجا هیچ generatorی تزریق نمی‌شود — دقیقاً همان کاری که
    | `AiToolRegistry` می‌کند — و باید از روی مدلِ اعلام‌شده روی
    | خودِ chunkها ساخته شود.
    */
    const projectIndex = await indexWithVectors(true);
    const tool = new SemanticSearchTool(new ProjectIndexReader(projectIndex));

    const result = await tool.execute({ query: 'reset password email', limit: 5 });

    expect(result.metadata!.usedEmbeddings).toBe(true);
    expect(result.metadata!.embeddingModel).toContain('hashing');
    expect(result.items.map(i => i.path)).toContain('src/AccountOps.ts');
  });

  it('اگر مدلِ chunkها در دسترس نباشد، صادقانه اعلام می‌کند', async () => {
    const projectIndex = await indexWithVectors(true);
    const foreign = {
      ...projectIndex,
      vectorChunks: (projectIndex.vectorChunks ?? []).map(c => ({
        ...c,
        embeddingModel: 'a-model-nobody-has',
      })),
    } as ProjectIndex;

    const tool = new SemanticSearchTool(new ProjectIndexReader(foreign));
    const result = await tool.execute({ query: 'reset password email', limit: 5 });

    expect(result.metadata!.usedEmbeddings).toBe(false);
    expect(String(result.metadata!.embeddingNote)).toContain('no usable embedding generator');
  });

  it('کلیدواژه به‌تنهایی فقط فایلِ طعمه را می‌دهد', async () => {
    const projectIndex = await indexWithVectors(true);
    const tool = new SemanticSearchTool(new ProjectIndexReader(projectIndex));

    const result = await tool.execute({
      query: 'reset password email',
      limit: 5,
      useEmbeddings: false,
    });

    expect(result.items.map(i => i.path)).not.toContain('src/AccountOps.ts');
  });
});
