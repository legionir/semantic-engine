/**
 * فاز ۴۶ — بخش‌های خالیِ blueprint.
 *
 * ## SE-BP-02 — چهار بخش از یازده بخش همیشه `[]` بود
 *
 * ```ts
 * entityTechnicalMapping: [], // فاز ۷ (AI Metadata)
 * apiMap: [],                 // فاز ۷
 * workflowExecutionMap: [],   // فاز ۷
 * ...
 * layers: [],                 // فاز ۷ (AI Metadata)
 * ```
 *
 * blueprint به‌عنوان «محصول نهاییِ قابل مصرف برای AI» بیش از یک‌سوم
 * قراردادش را تحویل نمی‌داد. دو تای این چهارتا بدون LLM قابل ساختن‌اند
 * و همین فاز می‌سازدشان.
 *
 * ## SE-BP-01 — تصادم شناسهٔ ماژول
 *
 * ```ts
 * modulePath.replace(/\//g, '-').replace(/_/g, '-').toLowerCase()
 * ```
 *
 * `src/foo_bar` و `src/foo/bar` هر دو `mod-src-foo-bar` می‌شوند، و
 * `src/FooBar` با `src/foobar` یکی می‌شود.
 *
 * ## SE-BP-03 — حلقهٔ تشخیص نقض، کد مرده بود
 *
 * حلقه‌ای روی فایل‌ها که تنها دستور مؤثرش `continue` است؛
 * `violatingFileIds` هرگز پر نمی‌شود. و «No Circular Dependencies»
 * اعلام می‌شود بی‌آنکه هیچ حلقه‌ای تشخیص داده شود — با اینکه گراف کامل
 * در دسترس است.
 *
 * ## SE-BP-04 — فایل‌های ریشه در هیچ ماژولی نیستند
 *
 * `deriveModulePath` برای `dir === '.'` مقدار `null` می‌دهد، پس
 * `package.json`, `README.md` و هر فایلِ ریشه از `moduleMap` غایب‌اند.
 */

import { BlueprintGenerator } from './BlueprintGenerator';
import { ProjectIndex, FileEntry, DependencyEdge } from '../core/types/project-index.types';

function file(id: string, filePath: string, extra: Partial<FileEntry> = {}): FileEntry {
  return {
    id,
    path: filePath,
    language: 'typescript',
    size: 100,
    lines: 10,
    hash: 'h',
    binary: false,
    testFile: /\.(test|spec)\.ts$/.test(filePath),
    symbolIds: [],
    imports: [],
    exports: [],
    diagnostics: [],
    outline: [],
    ...extra,
  } as unknown as FileEntry;
}

function index(files: FileEntry[], dependencyGraph: DependencyEdge[] = []): ProjectIndex {
  return {
    schemaVersion: '2.0.0',
    root: 'fixture',
    generatedAt: '2026-08-19T00:00:00.000Z',
    languages: ['typescript'],
    files,
    symbols: [],
    graphs: { dependencyGraph, reverseDependencyGraph: [], callGraph: [], typeGraph: [] },
    diagnostics: [],
    metrics: {
      totalFiles: files.length,
      totalLoc: 100,
      totalSymbols: 0,
      avgCyclomaticComplexity: 1,
      languageBreakdown: { typescript: files.length },
    },
  } as unknown as ProjectIndex;
}

const dep = (from: string, to: string): DependencyEdge =>
  ({ from, to, kind: 'import' }) as unknown as DependencyEdge;

describe('BlueprintGenerator — شناسهٔ ماژول بدون تصادم (SE-BP-01)', () => {
  it('`src/foo_bar` و `src/foo/bar` دو شناسهٔ متفاوت می‌گیرند', () => {
    const bp = new BlueprintGenerator().generate(
      index([file('f1', 'src/foo_bar/a.ts'), file('f2', 'src/foo/bar/b.ts')])
    );

    const ids = bp.moduleMap.map(m => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('مسیرهای دارای نقطه/@/فاصله شناسهٔ سازگار با schema می‌گیرند', () => {
    const bp = new BlueprintGenerator().generate(
      index([
        file('f1', '.github/workflows/ci.ts'),
        file('f2', '@types/node/a.ts'),
        file('f3', 'my dir/b.ts'),
        file('f4', 'github/workflows/c.ts'),
      ])
    );

    const ids = bp.moduleMap.map(m => m.id);
    for (const id of ids) expect(id).toMatch(/^mod-[a-z0-9-]+$/);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('تفاوت بزرگی و کوچکی حروف حفظ می‌شود', () => {
    const bp = new BlueprintGenerator().generate(
      index([file('f1', 'src/FooBar/a.ts'), file('f2', 'src/foobar/b.ts')])
    );

    const ids = bp.moduleMap.map(m => m.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('هر fileId دقیقاً به یک ماژول تعلق دارد', () => {
    const bp = new BlueprintGenerator().generate(
      index([file('f1', 'src/foo_bar/a.ts'), file('f2', 'src/foo/bar/b.ts')])
    );

    const seen = new Map<string, string>();
    for (const mod of bp.moduleMap) {
      for (const fileId of mod.fileIds) {
        expect(seen.has(fileId)).toBe(false);
        seen.set(fileId, mod.id);
      }
    }
  });

  it('شناسه همچنان پایدار و خواندنی است', () => {
    const bp = new BlueprintGenerator().generate(index([file('f1', 'src/services/a.ts')]));

    expect(bp.moduleMap[0].id).toMatch(/^mod-/);
    expect(bp.moduleMap[0].id).toContain('services');
  });
});

describe('BlueprintGenerator — فایل‌های ریشه (SE-BP-04)', () => {
  it('فایل ریشه در یک ماژول قرار می‌گیرد', () => {
    const bp = new BlueprintGenerator().generate(
      index([file('f1', 'package.json'), file('f2', 'README.md'), file('f3', 'src/a.ts')])
    );

    const allFileIds = new Set(bp.moduleMap.flatMap(m => m.fileIds));
    expect(allFileIds.has('f1')).toBe(true);
    expect(allFileIds.has('f2')).toBe(true);
  });

  it('ماژول ریشه نامِ روشنی دارد', () => {
    const bp = new BlueprintGenerator().generate(index([file('f1', 'package.json')]));

    const rootModule = bp.moduleMap.find(m => m.fileIds.includes('f1'))!;
    expect(rootModule.id).toBe('mod-root');
    expect(rootModule.path).toBe('.');
  });

  it('هیچ فایلِ غیرباینری بی‌ماژول نمی‌ماند', () => {
    const files = [
      file('f1', 'package.json'),
      file('f2', 'src/a.ts'),
      file('f3', 'src/deep/nested/b.ts'),
    ];
    const bp = new BlueprintGenerator().generate(index(files));

    const covered = new Set(bp.moduleMap.flatMap(m => m.fileIds));
    for (const f of files) {
      expect({ path: f.path, covered: covered.has(f.id) }).toEqual({ path: f.path, covered: true });
    }
  });

  it('فایل باینری همچنان بیرون می‌ماند', () => {
    const bp = new BlueprintGenerator().generate(
      index([file('f1', 'logo.png', { binary: true } as Partial<FileEntry>)])
    );

    const covered = new Set(bp.moduleMap.flatMap(m => m.fileIds));
    expect(covered.has('f1')).toBe(false);
  });
});

describe('BlueprintGenerator — تشخیص واقعی حلقهٔ وابستگی (SE-BP-03)', () => {
  it('حلقهٔ دوتایی پیدا می‌شود', () => {
    const bp = new BlueprintGenerator().generate(
      index([file('f1', 'src/a.ts'), file('f2', 'src/b.ts')], [dep('f1', 'f2'), dep('f2', 'f1')])
    );

    const constraint = bp.technicalConstraints.find(c => c.id === 'tc-no-circular-dependencies')!;
    expect(constraint.violatingFileIds).toEqual(['f1', 'f2']);
  });

  it('حلقهٔ سه‌تایی هم پیدا می‌شود', () => {
    const bp = new BlueprintGenerator().generate(
      index(
        [file('f1', 'src/a.ts'), file('f2', 'src/b.ts'), file('f3', 'src/c.ts')],
        [dep('f1', 'f2'), dep('f2', 'f3'), dep('f3', 'f1')]
      )
    );

    const constraint = bp.technicalConstraints.find(c => c.id === 'tc-no-circular-dependencies')!;
    expect(constraint.violatingFileIds).toEqual(['f1', 'f2', 'f3']);
  });

  it('گراف بدون حلقه، هیچ نقضی ندارد', () => {
    const bp = new BlueprintGenerator().generate(
      index(
        [file('f1', 'src/a.ts'), file('f2', 'src/b.ts'), file('f3', 'src/c.ts')],
        [dep('f1', 'f2'), dep('f2', 'f3')]
      )
    );

    const constraint = bp.technicalConstraints.find(c => c.id === 'tc-no-circular-dependencies')!;
    expect(constraint.violatingFileIds ?? []).toEqual([]);
  });

  it('فایلِ بیرونِ حلقه علامت نمی‌خورد', () => {
    const bp = new BlueprintGenerator().generate(
      index(
        [file('f1', 'src/a.ts'), file('f2', 'src/b.ts'), file('f3', 'src/c.ts')],
        [dep('f1', 'f2'), dep('f2', 'f1'), dep('f3', 'f1')]
      )
    );

    const constraint = bp.technicalConstraints.find(c => c.id === 'tc-no-circular-dependencies')!;
    expect(constraint.violatingFileIds).toEqual(['f1', 'f2']);
  });

  it('یال به خودش هم حلقه است', () => {
    const bp = new BlueprintGenerator().generate(
      index([file('f1', 'src/a.ts')], [dep('f1', 'f1')])
    );

    const constraint = bp.technicalConstraints.find(c => c.id === 'tc-no-circular-dependencies')!;
    expect(constraint.violatingFileIds).toEqual(['f1']);
  });

  it('یال به پکیج خارجی، حلقه نمی‌سازد', () => {
    const bp = new BlueprintGenerator().generate(
      index([file('f1', 'src/a.ts')], [dep('f1', 'react'), dep('react', 'f1')])
    );

    const constraint = bp.technicalConstraints.find(c => c.id === 'tc-no-circular-dependencies')!;
    expect(constraint.violatingFileIds ?? []).toEqual([]);
  });
});

describe('BlueprintGenerator — لایه‌های معماری (SE-BP-02)', () => {
  function layered(): ProjectIndex {
    return index([
      file('f1', 'src/controller/user.controller.ts'),
      file('f2', 'src/services/user.service.ts'),
      file('f3', 'src/repository/user.repository.ts'),
      file('f4', 'src/util/logger.ts'),
      file('f5', 'src/index.ts'),
    ]);
  }

  it('لایه‌ها دیگر خالی نیستند', () => {
    const bp = new BlueprintGenerator().generate(layered());

    expect(bp.architectureOverview.layers.length).toBeGreaterThan(0);
  });

  it('هر لایه به ماژول‌های واقعی اشاره می‌کند', () => {
    const bp = new BlueprintGenerator().generate(layered());
    const moduleIds = new Set(bp.moduleMap.map(m => m.id));

    for (const layer of bp.architectureOverview.layers) {
      expect(layer.moduleIds!.length).toBeGreaterThan(0);
      for (const id of layer.moduleIds!) {
        expect(moduleIds.has(id)).toBe(true);
      }
    }
  });

  it('لایهٔ presentation شامل controller است', () => {
    const bp = new BlueprintGenerator().generate(layered());
    const presentation = bp.architectureOverview.layers.find(l => l.name === 'presentation')!;

    expect(presentation).toBeDefined();
    const modules = presentation.moduleIds!.map(id => bp.moduleMap.find(m => m.id === id)!);
    expect(modules.some(m => m.path.includes('controller'))).toBe(true);
  });

  it('لایهٔ data شامل repository است', () => {
    const bp = new BlueprintGenerator().generate(layered());
    const data = bp.architectureOverview.layers.find(l => l.name === 'data')!;

    expect(data).toBeDefined();
    const modules = data.moduleIds!.map(id => bp.moduleMap.find(m => m.id === id)!);
    expect(modules.some(m => m.path.includes('repository'))).toBe(true);
  });

  it('نامِ جمعِ پوشه هم می‌خورد — `services` مثل `service`', () => {
    /*
    | نام‌گذاریِ جمع قاعده است نه استثنا: `services`, `controllers`,
    | `models`, `repositories`. تطبیقِ برابریِ ساده روی همان
    | fixtureِ خودِ پروژه شکست خورد — لایهٔ application خالی درآمد
    | چون پوشه `src/services` است و الگو `service`.
    */
    const bp = new BlueprintGenerator().generate(
      index([
        file('f1', 'src/services/user.service.ts'),
        file('f2', 'src/controllers/user.controller.ts'),
        file('f3', 'src/repositories/user.repository.ts'),
        file('f4', 'src/models/user.ts'),
      ])
    );

    const names = bp.architectureOverview.layers.map(l => l.name);
    expect(names).toEqual(['presentation', 'application', 'domain', 'data']);
  });

  it('جمعِ کاذب، لایهٔ اشتباه نمی‌سازد', () => {
    // `serviceable` جمعِ `service` نیست.
    const bp = new BlueprintGenerator().generate(
      index([file('f1', 'src/serviceable/a.ts')])
    );

    expect(bp.architectureOverview.layers).toEqual([]);
  });

  it('لایه می‌گوید از کجا آمده', () => {
    const bp = new BlueprintGenerator().generate(layered());

    for (const layer of bp.architectureOverview.layers) {
      expect(layer.derivedFrom).toBe('heuristic');
    }
  });

  it('ماژولی که با دو لایه می‌خواند، فقط در اولی می‌نشیند', () => {
    /*
    | `src/api/services` هم قطعهٔ `api` دارد (presentation) و هم
    | `services` (application). بدون قاعدهٔ «اولین تطابق برنده»، در
    | هر دو لایه ظاهر می‌شود و «لایه» معنایش را از دست می‌دهد.
    */
    const bp = new BlueprintGenerator().generate(
      index([file('f1', 'src/api/services/user.ts')])
    );

    const containing = bp.architectureOverview.layers.filter(l =>
      (l.moduleIds ?? []).some(id => id === bp.moduleMap[0].id)
    );

    expect(containing.map(l => l.name)).toEqual(['presentation']);
  });

  it('هیچ ماژولی در دو لایه نیست', () => {
    const bp = new BlueprintGenerator().generate(layered());

    const seen = new Set<string>();
    for (const layer of bp.architectureOverview.layers) {
      for (const id of layer.moduleIds ?? []) {
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
    }
  });

  it('پروژه‌ای بدون ساختار لایه‌ای، لایهٔ ساختگی نمی‌سازد', () => {
    const bp = new BlueprintGenerator().generate(
      index([file('f1', 'src/alpha/a.ts'), file('f2', 'src/beta/b.ts')])
    );

    const named = bp.architectureOverview.layers.filter(l => l.name !== 'other');
    expect(named).toEqual([]);
  });
});

/*
| SE-DATA-04 — `FileEntry.blueprintRef` هرگز نوشته نمی‌شد.
|
| فیلد اعلام شده بود (`{ moduleId: string | null }`) و هیچ مسیری
| مقداردهی‌اش نمی‌کرد. نگاشتِ فایل به ماژول فقط داخل blueprint وجود
| داشت، پس هر مصرف‌کننده‌ای که از project-index شروع می‌کرد، باید
| خودش دوباره حسابش می‌کرد — یا بی‌خبر می‌ماند.
*/
describe('BlueprintGenerator — نگاشت فایل به ماژول قابل استفاده است (SE-DATA-04)', () => {
  it('برای هر فایل، ماژولش را می‌دهد', () => {
    const generator = new BlueprintGenerator();
    const projectIndex = index([
      file('f1', 'src/services/user.ts'),
      file('f2', 'package.json'),
    ]);

    generator.generate(projectIndex);
    const refs = generator.moduleRefs();

    expect(refs.get('f1')).toBe('mod-src-services');
    expect(refs.get('f2')).toBe('mod-root');
  });

  it('فایل باینری ماژول ندارد', () => {
    const generator = new BlueprintGenerator();
    generator.generate(index([file('f1', 'logo.png', { binary: true } as Partial<FileEntry>)]));

    expect(generator.moduleRefs().has('f1')).toBe(false);
  });

  it('نگاشت با هر بار تولید، از نو ساخته می‌شود', () => {
    const generator = new BlueprintGenerator();
    generator.generate(index([file('f1', 'src/a/x.ts')]));
    generator.generate(index([file('f2', 'src/b/y.ts')]));

    const refs = generator.moduleRefs();
    expect(refs.has('f1')).toBe(false);
    expect(refs.get('f2')).toBe('mod-src-b');
  });
});


/*
| معیار پذیرش فاز ۴۶، این بار از راه خودِ blueprint.
|
| آزمون‌های `ApiMapExtractor` خودِ استخراج را می‌سنجند. این یکی
| می‌سنجد که نتیجه واقعاً به `blueprint.apiMap` می‌رسد — برگرداندنِ
| اتصال، آنجا صفر شکست می‌داد چون هیچ آزمونی مسیرِ کامل را طی
| نمی‌کرد.
*/
describe('BlueprintGenerator — apiMap در خودِ blueprint (SE-BP-02)', () => {
  const EXPRESS = `import express from 'express';
const app = express();
app.get('/health', (_req, res) => res.send('ok'));
app.post('/users', createUser);
function createUser() {}
`;

  function withRoutes() {
    const projectIndex = index([file('f1', 'src/api/app.ts')]);
    return {
      ...projectIndex,
      symbols: [
        {
          id: 's-create',
          fileId: 'f1',
          parentId: null,
          kind: 'function',
          name: 'createUser',
          line: 5,
          endLine: 5,
          source: 'tree-sitter',
          confidence: { value: 90 },
        },
      ],
    } as unknown as ProjectIndex;
  }

  function generate() {
    return new BlueprintGenerator({ sourceOf: () => EXPRESS }).generate(withRoutes());
  }

  it('apiMap دیگر خالی نیست', () => {
    expect(generate().apiMap.length).toBe(2);
  });

  it('متد و مسیر درست‌اند', () => {
    const byPath = new Map(generate().apiMap.map(e => [e.path, e.method]));

    expect(byPath.get('/health')).toBe('GET');
    expect(byPath.get('/users')).toBe('POST');
  });

  it('handler به symbol واقعی وصل می‌شود', () => {
    const users = generate().apiMap.find(e => e.path === '/users')!;

    expect(users.handlerName).toBe('createUser');
    expect(users.handlerSymbolId).toBe('s-create');
  });

  it('handler درجا، شناسهٔ جعلی نمی‌گیرد', () => {
    const health = generate().apiMap.find(e => e.path === '/health')!;

    expect(health.handlerSymbolId).toBeNull();
  });

  it('SE-SEC-001 — بدون شاهد، authRequired:null نه false (نبودِ شاهد ≠ شاهدِ باز بودن)', () => {
    for (const entry of generate().apiMap) {
      expect(entry.authRequired).toBeNull();
    }
  });

  it('هر ورودی شناسه و منشأ دارد', () => {
    for (const entry of generate().apiMap) {
      expect(entry.id).toMatch(/^api-[a-z0-9-]+$/);
      expect(entry.derivedFrom).toBe('static-analysis');
      expect(entry.fileId).toBe('f1');
    }
  });

  it('بدون sourceOf، خالی می‌ماند — «نگاه نکردم» نه «چیزی نبود»', () => {
    expect(new BlueprintGenerator().generate(withRoutes()).apiMap).toEqual([]);
  });
});
