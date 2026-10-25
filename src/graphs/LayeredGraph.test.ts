/**
 * فاز ۴۷ — گراف چندلایه (GAP-09).
 *
 * ## مسئله
 *
 * GAP-09 این را «جالب‌ترین ایدهٔ متن، اما مسدود» نامیده بود. گراف
 * امروز فقط دو لایه دارد — فایل و نماد — و پرسش‌هایی که یک آدم
 * می‌پرسد بالاتر از آن‌اند:
 *
 * > «کدام endpoint به جدول users دست می‌زند؟»
 *
 * برای پاسخ، باید از یک گرهِ API به یک گرهِ Entity رسید، و آن دو
 * لایه گرهی نداشتند. `apiMap` و `workflowExecutionMap` و
 * `entityTechnicalMapping` هر سه `[]` بودند. فاز ۴۶ اولی را ساخت؛
 * این فاز دو تای دیگر را و بعد همه را به هم وصل می‌کند.
 *
 * ## معیار پذیرش
 *
 * > `path("API /login", "Database")` مسیر بین‌لایه‌ای بدهد.
 *
 * یعنی گره‌ها باید با **برچسبِ خواندنی** آدرس‌پذیر باشند، نه فقط با
 * هشِ داخلی؛ وگرنه مصرف‌کننده باید اول یک پرس‌وجوی دیگر بزند تا
 * شناسه را پیدا کند.
 */

import { ProjectIndex } from '../core/types/project-index.types';
import { Blueprint } from '../core/types/blueprint.types';
import { makeConfidence } from '../core/types/common.types';
import { LayeredGraph } from './LayeredGraph';
import { GraphQueryEngine } from './GraphQueryEngine';
import { BlueprintGenerator } from '../blueprint/BlueprintGenerator';

/*
| ساختار آزمون — یک زنجیرهٔ کاملِ شش‌لایه:
|
|   API  POST /login
|     └─ handler  loginHandler        (src/api/auth.ts)
|          └─ calls  authenticate     (src/services/auth.service.ts)
|               └─ calls  findByEmail (src/repository/user.repository.ts)
|                    └─ touches  User (src/model/user.ts)  →  storage: sql
*/
const SOURCE = `import express from 'express';
const app = express();
app.post('/login', loginHandler);
function loginHandler() { return authenticate(); }
`;

function file(id: string, path: string) {
  return {
    id,
    path,
    language: 'typescript',
    size: 100,
    lines: 10,
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

function sym(id: string, fileId: string, name: string, kind = 'function', extra: Record<string, unknown> = {}) {
  return {
    id,
    fileId,
    parentId: null,
    kind,
    name,
    fullyQualifiedName: name,
    signature: `${name}()`,
    visibility: 'public',
    line: 1,
    endLine: 5,
    documentation: null,
    deprecated: false,
    exported: true,
    source: 'tree-sitter',
    confidence: makeConfidence(90),
    ...extra,
  };
}

function callEdge(caller: string, callee: string) {
  return {
    caller,
    callee,
    kind: 'direct',
    callerKind: 'symbol',
    provenance: {
      extractor: 'typescript-api',
      basis: 'ast',
      confidence: 95,
      at: { file: 'x', line: 1 },
    },
  };
}

function index(): ProjectIndex {
  const files = [
    file('f-api', 'src/api/auth.ts'),
    file('f-svc', 'src/services/auth.service.ts'),
    file('f-repo', 'src/repository/user.repository.ts'),
    file('f-model', 'src/model/user.ts'),
  ];

  const symbols = [
    sym('s-handler', 'f-api', 'loginHandler'),
    sym('s-auth', 'f-svc', 'authenticate'),
    sym('s-find', 'f-repo', 'findByEmail'),
    sym('s-user', 'f-model', 'User', 'interface'),
  ];

  return {
    schemaVersion: '2.0.0',
    root: 'fixture',
    rootPath: '/tmp/fixture',
    generatedAt: '2026-08-19T00:00:00.000Z',
    languages: ['typescript'],
    files,
    symbols,
    graphs: {
      dependencyGraph: [],
      reverseDependencyGraph: [],
      callGraph: [
        callEdge('s-handler', 's-auth'),
        callEdge('s-auth', 's-find'),
        callEdge('s-find', 's-user'),
      ],
      typeGraph: [],
    },
    diagnostics: [],
    metrics: {
      totalFiles: files.length,
      totalLoc: 40,
      totalSymbols: symbols.length,
      avgCyclomaticComplexity: 1,
      languageBreakdown: { typescript: files.length },
    },
  } as unknown as ProjectIndex;
}

function blueprintOf(projectIndex: ProjectIndex): Blueprint {
  return new BlueprintGenerator({
    sourceOf: f => (f.path === 'src/api/auth.ts' ? SOURCE : undefined),
  }).generate(projectIndex);
}

function layered(): { graph: LayeredGraph; engine: GraphQueryEngine } {
  const projectIndex = index();
  const blueprint = blueprintOf(projectIndex);
  const graph = new LayeredGraph(projectIndex, blueprint);
  return { graph, engine: new GraphQueryEngine(projectIndex, { extraEdges: graph.edges() }) };
}

describe('LayeredGraph — معیار پذیرش فاز ۴۷', () => {
  it('path("API /login", "Database") مسیر بین‌لایه‌ای می‌دهد', () => {
    const { graph, engine } = layered();

    const from = graph.resolve('API /login')!;
    const to = graph.resolve('Database')!;

    expect(from).toBeDefined();
    expect(to).toBeDefined();

    const result = engine.path(from, to, { minConfidence: 0 });
    expect(result.path).not.toBeNull();
    expect(result.path!.length).toBeGreaterThan(2);
  });

  it('مسیر از هر شش لایه عبور می‌کند', () => {
    const { graph, engine } = layered();
    const result = engine.path(graph.resolve('API /login')!, graph.resolve('Database')!, {
      minConfidence: 0,
    });

    const layers = result.path!.map(step => graph.layerOf(step.node));
    expect(layers[0]).toBe('api');
    expect(layers).toContain('symbol');
    expect(layers).toContain('entity');
    expect(layers[layers.length - 1]).toBe('storage');
  });

  it('هر یالِ بین‌لایه‌ای provenance دارد', () => {
    const { graph } = layered();

    for (const edge of graph.edges()) {
      expect(edge.basis.length).toBeGreaterThan(0);
      expect(edge.confidence).toBeGreaterThan(0);
      expect(edge.confidence).toBeLessThanOrEqual(100);
    }
  });

  it('یالِ حاصلِ حدس، اعتمادِ کمتری از یالِ خوانده‌شده دارد', () => {
    const { graph } = layered();

    const read = graph.edges().filter(e => e.basis === 'blueprint');
    const guessed = graph.edges().filter(e => e.basis === 'name-match');

    if (guessed.length > 0 && read.length > 0) {
      expect(Math.max(...guessed.map(e => e.confidence))).toBeLessThan(
        Math.min(...read.map(e => e.confidence))
      );
    }
  });
});

describe('LayeredGraph — آدرس‌دهی با برچسب', () => {
  it('برچسبِ API با متد هم کار می‌کند', () => {
    const { graph } = layered();

    expect(graph.resolve('API POST /login')).toBe(graph.resolve('API /login'));
  });

  it('برچسبِ ناشناخته، undefined می‌دهد نه گرهِ اشتباه', () => {
    const { graph } = layered();

    expect(graph.resolve('API /nope')).toBeUndefined();
    expect(graph.resolve('')).toBeUndefined();
  });

  it('برچسبِ Entity کار می‌کند', () => {
    const { graph } = layered();

    expect(graph.resolve('Entity User')).toBeDefined();
  });

  it('بزرگی و کوچکی حروف مهم نیست', () => {
    const { graph } = layered();

    expect(graph.resolve('database')).toBe(graph.resolve('Database'));
  });

  it('شناسهٔ خامِ گره هم پذیرفته می‌شود', () => {
    const { graph } = layered();
    const id = graph.resolve('API /login')!;

    expect(graph.resolve(id)).toBe(id);
  });
});

describe('LayeredGraph — لایهٔ هر گره', () => {
  it('لایهٔ گره‌های مصنوعی از پیشوندشان می‌آید', () => {
    const { graph } = layered();

    expect(graph.layerOf(graph.resolve('API /login')!)).toBe('api');
    expect(graph.layerOf(graph.resolve('Entity User')!)).toBe('entity');
    expect(graph.layerOf(graph.resolve('Database')!)).toBe('storage');
  });

  it('نماد و فایل هم لایه دارند', () => {
    const { graph } = layered();

    expect(graph.layerOf('s-handler')).toBe('symbol');
    expect(graph.layerOf('f-api')).toBe('file');
  });

  it('گرهِ ناشناخته، لایهٔ unknown می‌گیرد', () => {
    const { graph } = layered();

    expect(graph.layerOf('nothing-like-this')).toBe('unknown');
  });
});

describe('LayeredGraph — ساختار', () => {
  it('گرهِ API به handler وصل است', () => {
    const { graph } = layered();
    const api = graph.resolve('API /login')!;

    const targets = graph.edges().filter(e => e.from === api).map(e => e.to);
    expect(targets).toContain('s-handler');
  });

  it('گرهِ workflow مراحل را به ترتیب دارد', () => {
    const projectIndex = index();
    const blueprint = blueprintOf(projectIndex);

    expect(blueprint.workflowExecutionMap.length).toBeGreaterThan(0);
    const steps = blueprint.workflowExecutionMap[0]!.steps;
    expect(steps.map(s => s.order)).toEqual([...steps.map(s => s.order)].sort((a, b) => a - b));
    expect(steps[0]!.symbolId).toBe('s-handler');
  });

  it('گرهِ workflow فقط به مرحلهٔ اول وصل است', () => {
    /*
    | مراحل بعدی از قبل با یال‌های `calls` به هم وصل‌اند. تکرارشان
    | یعنی همان اطلاعات دو بار در گراف — و بدتر، مسیرهای کوتاه‌ترِ
    | ساختگی: از گرهِ workflow مستقیم به مرحلهٔ آخر، انگار یک گام
    | فاصله دارند.
    */
    const { graph } = layered();
    const perWorkflow = new Map<string, number>();

    for (const edge of graph.edges()) {
      if (edge.kind !== 'starts') continue;
      perWorkflow.set(edge.from, (perWorkflow.get(edge.from) ?? 0) + 1);
    }

    expect(perWorkflow.size).toBeGreaterThan(0);
    for (const [node, count] of perWorkflow) {
      expect({ node, count }).toEqual({ node, count: 1 });
    }
  });

  it('interfaceی که در فایلِ مدل نیست، entity نمی‌شود', () => {
    /*
    | بدون این شرط هر interfaceی در پروژه یک «موجودیت کسب‌وکار»
    | می‌شود — همان اشتباهی که SE-BP-05 در سطح ماژول مرتکب می‌شد.
    */
    const projectIndex = {
      ...index(),
      files: [file('f-util', 'src/util/shapes.ts')],
      symbols: [sym('s-shape', 'f-util', 'Shape', 'interface')],
    } as unknown as ProjectIndex;

    const bp = new BlueprintGenerator().generate(projectIndex);
    expect(bp.entityTechnicalMapping).toEqual([]);
  });

  it('مسیری که handlerش هیچ فراخوانی ندارد، workflow نمی‌سازد', () => {
    /*
    | یک workflowِ تک‌مرحله‌ای هیچ روایتی ندارد: فقط می‌گوید
    | «handler وجود دارد»، که `apiMap` از قبل گفته.
    */
    const projectIndex = {
      ...index(),
      graphs: { ...index().graphs, callGraph: [] },
    } as unknown as ProjectIndex;

    const bp = blueprintOf(projectIndex);
    expect(bp.apiMap.length).toBeGreaterThan(0);
    expect(bp.workflowExecutionMap).toEqual([]);
  });

  it('وقتی دو فراخوانی هم‌اعتمادند، انتخاب دترمینیستیک است', () => {
    const projectIndex = {
      ...index(),
      graphs: {
        ...index().graphs,
        callGraph: [callEdge('s-handler', 's-find'), callEdge('s-handler', 's-auth')],
      },
    } as unknown as ProjectIndex;

    const bp = blueprintOf(projectIndex);
    const steps = bp.workflowExecutionMap[0]!.steps.map(x => x.symbolId);

    // با اعتمادِ برابر، شناسهٔ کوچک‌تر برنده است — نه ترتیبِ ورودی.
    expect(steps[1]).toBe('s-auth');
  });

  it('نگاشت entity به نماد وجود دارد', () => {
    const blueprint = blueprintOf(index());

    const user = blueprint.entityTechnicalMapping.find(e => e.modelName === 'User');
    expect(user).toBeDefined();
    expect(user!.symbolId).toBe('s-user');
  });

  it('بدون blueprint، هیچ لایهٔ بالایی ساخته نمی‌شود', () => {
    /*
    | یال‌های `declared-in` از خودِ ایندکس می‌آیند و به blueprint
    | ربطی ندارند، پس می‌مانند. آنچه نباید بماند، لایه‌هایی است که
    | منبعشان blueprint است.
    */
    const empty = {
      moduleMap: [],
      apiMap: [],
      workflowExecutionMap: [],
      entityTechnicalMapping: [],
      architectureOverview: { layers: [], dataFlow: [] },
    } as unknown as Blueprint;

    const graph = new LayeredGraph(index(), empty);
    const kinds = new Set(graph.edges().map(e => e.kind));

    expect(kinds).toEqual(new Set(['declared-in']));
    expect(graph.resolve('API /login')).toBeUndefined();
    expect(graph.resolve('Database')).toBeUndefined();
  });

  it('گراف پایه دست‌نخورده می‌ماند', () => {
    const projectIndex = index();
    const before = new GraphQueryEngine(projectIndex).edgeCount;
    const graph = new LayeredGraph(projectIndex, blueprintOf(projectIndex));
    const after = new GraphQueryEngine(projectIndex, { extraEdges: graph.edges() }).edgeCount;

    expect(after).toBe(before + graph.edges().length);
  });

  it('نتیجه دترمینیستیک است', () => {
    const a = layered().graph.edges();
    const b = layered().graph.edges();

    expect(a).toEqual(b);
  });
});

/*
| SE-BP-10 — دو entity هم‌نام، یک شناسه می‌گرفتند.
|
| اجرای واقعی روی fixture: سه نمادِ `User` در سه فایل (TypeScript،
| Kotlin، Swift) هر سه `conceptualEntityId = 'entity-User'` گرفتند.
|
| ```
| entity-User    interface   src/model/user.ts
| entity-User    class       kt/Model.kt
| entity-User    struct      swift/Model.swift
| ```
|
| و در گراف چندلایه بدتر می‌شود: هر سه به گرهِ `entity:User` نگاشت
| می‌شوند، پس یک گره سه یالِ `models` به سه نمادِ متفاوت دارد و
| مسیرِ «از این endpoint به این entity» می‌تواند از فایل کاملاً
| بی‌ربطی رد شود. همان جنسِ تصادمی که SE-BP-01 در سطح ماژول داشت.
*/
describe('EntityMapExtractor — شناسهٔ یکتا (SE-BP-10)', () => {
  function multiLanguage(): ProjectIndex {
    const files = [
      file('f-ts', 'src/model/user.ts'),
      file('f-kt', 'kt/Model.kt'),
      file('f-swift', 'swift/Model.swift'),
    ];
    const symbols = [
      sym('s-ts', 'f-ts', 'User', 'interface'),
      sym('s-kt', 'f-kt', 'User', 'class'),
      sym('s-swift', 'f-swift', 'User', 'struct'),
    ];

    return {
      ...index(),
      files,
      symbols,
      graphs: { dependencyGraph: [], reverseDependencyGraph: [], callGraph: [], typeGraph: [] },
    } as unknown as ProjectIndex;
  }

  it('سه entity هم‌نام، سه شناسهٔ متفاوت می‌گیرند', () => {
    const bp = new BlueprintGenerator().generate(multiLanguage());
    const ids = bp.entityTechnicalMapping.map(e => e.conceptualEntityId);

    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it('نامِ مدل همچنان خواندنی می‌ماند', () => {
    const bp = new BlueprintGenerator().generate(multiLanguage());

    expect(bp.entityTechnicalMapping.every(e => e.modelName === 'User')).toBe(true);
    expect(bp.entityTechnicalMapping.every(e => e.conceptualEntityId.includes('User'))).toBe(true);
  });

  it('entityِ بی‌رقیب، شناسهٔ تمیز می‌گیرد', () => {
    const bp = new BlueprintGenerator().generate(index());
    const user = bp.entityTechnicalMapping.find(e => e.modelName === 'User')!;

    expect(user.conceptualEntityId).toBe('entity-User');
  });

  it('هر گرهِ entity در گراف، دقیقاً یک یالِ models دارد', () => {
    const projectIndex = multiLanguage();
    const graph = new LayeredGraph(projectIndex, new BlueprintGenerator().generate(projectIndex));

    const byNode = new Map<string, number>();
    for (const edge of graph.edges()) {
      if (edge.kind !== 'models') continue;
      byNode.set(edge.from, (byNode.get(edge.from) ?? 0) + 1);
    }

    expect(byNode.size).toBe(3);
    for (const [node, count] of byNode) {
      expect({ node, count }).toEqual({ node, count: 1 });
    }
  });

  it('نتیجه به ترتیبِ ورودی حساس نیست', () => {
    const forward = new BlueprintGenerator().generate(multiLanguage());
    const reversed = multiLanguage();
    const backward = new BlueprintGenerator().generate({
      ...reversed,
      symbols: [...reversed.symbols].reverse(),
    } as ProjectIndex);

    expect(forward.entityTechnicalMapping.map(e => e.conceptualEntityId)).toEqual(
      backward.entityTechnicalMapping.map(e => e.conceptualEntityId)
    );
  });
});

/*
| پلِ نماد به فایل — لایهٔ `Symbol → File` در GAP-09.
|
| بدون آن، دو نیمهٔ گراف به هم نمی‌رسند: یال‌های `calls` بین نمادهایند
| و `imports` بین فایل‌ها، و هیچ یالی از یکی به دیگری نیست. روی
| fixture واقعی این را دیدیم:
|
|   path(API /users, Database)  →  (none)
|
| چون زنجیرهٔ فراخوانی به `persistUser` می‌رسید و همان‌جا می‌ایستاد:
| ارجاعِ آن به مدل یک ارجاعِ **نوعی** است نه فراخوانی، و ارجاع نوعی
| فقط در سطح فایل (import) دیده می‌شود.
*/
describe('LayeredGraph — پلِ نماد به فایل', () => {
  it('هر نماد به فایلش وصل است', () => {
    const { graph } = layered();
    const declaredIn = graph.edges().filter(e => e.kind === 'declared-in');

    expect(declaredIn.length).toBe(index().symbols.length);
    for (const edge of declaredIn) {
      expect(graph.layerOf(edge.from)).toBe('symbol');
      expect(graph.layerOf(edge.to)).toBe('file');
    }
  });

  it('فایل به entityهایی که اعلام می‌کند وصل است', () => {
    const { graph } = layered();
    const declares = graph.edges().filter(e => e.kind === 'declares');

    expect(declares.length).toBeGreaterThan(0);
    for (const edge of declares) {
      expect(graph.layerOf(edge.from)).toBe('file');
      expect(graph.layerOf(edge.to)).toBe('entity');
    }
  });

  it('مسیر از راه import هم پیدا می‌شود، نه فقط از راه فراخوانی', () => {
    /*
    | یک ایندکس که در آن هیچ فراخوانی‌ای به نمادِ مدل نیست — فقط
    | یک import در سطح فایل. مسیر باید همچنان وجود داشته باشد.
    */
    const projectIndex = {
      ...index(),
      graphs: {
        ...index().graphs,
        callGraph: [callEdge('s-handler', 's-auth')],
        dependencyGraph: [
          {
            from: 'f-svc',
            to: 'f-model',
            kind: 'import',
            provenance: { extractor: 'typescript-api', basis: 'import-resolved', confidence: 95, at: { file: 'x', line: 1 } },
          },
        ],
      },
    } as unknown as ProjectIndex;

    const blueprint = new BlueprintGenerator({
      sourceOf: f => (f.path === 'src/api/auth.ts' ? SOURCE : undefined),
    }).generate(projectIndex);

    const graph = new LayeredGraph(projectIndex, blueprint);
    const engine = new GraphQueryEngine(projectIndex, { extraEdges: graph.edges() });

    const result = engine.path(graph.resolve('API /login')!, graph.resolve('Database')!, {
      minConfidence: 0,
    });

    expect(result.path).not.toBeNull();
    expect(result.path!.map(s => graph.layerOf(s.node))).toContain('file');
  });

  it('نمادی که فایلش در ایندکس نیست، یال نمی‌سازد', () => {
    const orphan = {
      ...index(),
      symbols: [...index().symbols, sym('s-orphan', 'f-missing', 'ghost')],
    } as unknown as ProjectIndex;

    const graph = new LayeredGraph(orphan, blueprintOf(orphan));
    const froms = graph.edges().filter(e => e.kind === 'declared-in').map(e => e.from);

    expect(froms).not.toContain('s-orphan');
  });
});
