/**
 * فاز ۴۹ — گراف از روی ادعاهای حل‌شده ساخته می‌شود، نه از روی ترتیب
 * درج.
 *
 * ── باگی که این فایل را ساخت ────────────────────────────────────────
 *
 * روی ایندکس واقعی `semantic-engine/src` (۳۲۴ فایل، ۹۴۷۷ symbol،
 * ۲۳٬۴۶۲ یال فراخوانی) یک جفت گره پیدا شد که دو ادعای متناقض داشت:
 *
 * ```
 * d9316b2bff96cfc4 → 695a7f20caf77472
 *   line  57  name-match       40   (و ۹ خط دیگر، همه name-match)
 *   line 151  import-resolved  85
 * ```
 *
 * و `path()` برای همان دو گره این را می‌گفت:
 *
 * ```
 * weakestLink = 40 · confident = false · weakEdges = 1
 * best available edge confidence = 85
 * ```
 *
 * یعنی موتور یک رابطه را «حدسِ نام» اعلام می‌کرد در حالی که شاهد
 * `import-resolved` را در دست داشت. علت: `add()` هر یال را در انتهای
 * آرایه می‌ریخت و BFS اولین عضو آرایه را برمی‌داشت — ترتیب درج، نه
 * ترتیب شواهد.
 *
 * جالب اینکه `neighbors(minConfidence: 70)` **درست** جواب می‌داد
 * (`pathConfidence: 85`)، چون فیلتر آستانه یال ۴۰ را حذف می‌کرد.
 * پس دو تابع روی یک گراف دو جواب متفاوت می‌دادند — که از هر دو
 * جواب بدتر است.
 */

import { ProjectIndex } from '../core/types/project-index.types';
import { GraphQueryEngine } from './GraphQueryEngine';
import { provenanceFor } from './EdgeProvenance';

/*
| کوچک‌ترین بازتولید همان چیزی که در گراف واقعی دیده شد: بین `a` و
| `b` هم ادعای ضعیف هست و هم قوی، و ضعیف زودتر درج شده.
*/
function indexWithContestedEdge(): ProjectIndex {
  const call = (caller: string, callee: string, basis: 'name-match' | 'import-resolved' | 'ast', line: number) => ({
    id: `${caller}-${callee}-${line}`,
    caller,
    callee,
    kind: 'direct' as const,
    line,
    provenance: provenanceFor(basis, 'tree-sitter', { file: `${caller}.ts`, line }),
  });

  return {
    version: '1',
    root: 'contested',
    rootPath: '/contested',
    generatedAt: new Date(0).toISOString(),
    files: [],
    symbols: [],
    graphs: {
      callGraph: [
        call('a', 'b', 'name-match', 57),
        call('a', 'b', 'name-match', 63),
        call('a', 'b', 'import-resolved', 151),
        /*
        | این یال عمداً ضعیف است. بدون آن، `path` هرگز به شاخهٔ
        | fallback نمی‌رسد و باگ پنهان می‌ماند: جست‌وجوی اول با
        | آستانهٔ ۷۰ یال ۴۰ را حذف می‌کند و جواب تصادفاً درست
        | درمی‌آید.
        */
        call('b', 'c', 'name-match', 5),
      ],
      dependencyGraph: [],
      reverseDependencyGraph: [],
      typeGraph: [],
    },
  } as unknown as ProjectIndex;
}

describe('فاز ۴۹ — گراف روی ادعاهای حل‌شده', () => {
  describe('تعارض بین دو ادعا دربارهٔ یک رابطه', () => {
    it('`path` قوی‌ترین شاهد را گزارش می‌کند، نه اولین یال درج‌شده', () => {
      const engine = new GraphQueryEngine(indexWithContestedEdge());
      const result = engine.path('a', 'b', { relations: ['calls'], minConfidence: 0 });

      expect(result.path).not.toBeNull();
      expect(result.weakestLink).toBe(85);
      expect(result.confident).toBe(true);
      expect(result.weakEdges).toHaveLength(0);
    });

    it('در fallback به یال‌های ضعیف، فقط گام واقعاً ضعیف ضعیف شمرده می‌شود', () => {
      /*
      | `path` اول با آستانهٔ ۷۰ می‌گردد و چون `b → c` فقط ۴۰ است
      | مسیری پیدا نمی‌کند، پس دوباره با همه‌چیز می‌گردد. در آن گذر
      | دوم، گام `a → b` هم می‌تواند از یال ۴۰ برداشته شود — و
      | آن‌وقت موتور دو یال ضعیف گزارش می‌کند در حالی که برای یکی
      | از آن‌ها شاهد ۸۵ دارد.
      */
      const engine = new GraphQueryEngine(indexWithContestedEdge());
      const result = engine.path('a', 'c', { relations: ['calls'] });

      expect(result.path).not.toBeNull();
      expect(result.weakEdges).toHaveLength(1);
      expect(result.weakEdges[0].to).toBe('c');

      const stepToB = result.path?.find(step => step.node === 'b');
      expect(stepToB?.via?.confidence).toBe(85);
    });

    it('`path` و `neighbors` دربارهٔ همان رابطه یک عدد می‌گویند', () => {
      const engine = new GraphQueryEngine(indexWithContestedEdge());

      const viaPath = engine.path('a', 'b', { relations: ['calls'] }).weakestLink;
      const viaNeighbors = engine
        .neighbors('a', { depth: 1, direction: 'out', relations: ['calls'], minConfidence: 70 })
        .nodes.find(node => node.id === 'b')?.pathConfidence;

      expect(viaPath).toBe(viaNeighbors);
    });

    it('یال ضعیف‌تر پاک نمی‌شود — روی یال برنده ثبت می‌شود', () => {
      const engine = new GraphQueryEngine(indexWithContestedEdge());
      const [edge] = engine.edgesFrom('a', 'out', ['calls'], 0).filter(e => e.to === 'b');

      expect(edge.confidence).toBe(85);
      expect(edge.contested).toBe(true);
      expect(edge.superseded?.map(claim => claim.basis)).toContain('name-match');
    });

    it('مسیرِ واقعاً ضعیف همچنان ضعیف گزارش می‌شود', () => {
      /*
      | خطر این رفع، بیش‌اصلاح است: اگر «قوی‌ترین برنده» به معنی
      | «همه‌چیز قوی است» تفسیر شود، هشدار فاز ۱۹ بی‌اثر می‌شود.
      */
      const index = indexWithContestedEdge();
      const graphs = index.graphs as unknown as { callGraph: unknown[] };
      graphs.callGraph = [
        {
          id: 'a-b-1',
          caller: 'a',
          callee: 'b',
          kind: 'direct',
          line: 1,
          provenance: provenanceFor('name-match', 'tree-sitter', { file: 'a.ts', line: 1 }),
        },
      ];

      const engine = new GraphQueryEngine(index);
      const result = engine.path('a', 'b', { relations: ['calls'] });
      expect(result.weakestLink).toBe(40);
      expect(result.confident).toBe(false);
      expect(result.weakEdges).toHaveLength(1);
    });
  });

  describe('تکرار عین‌به‌عین', () => {
    it('دو فراخوانی روی یک خط، یک یال است', () => {
      /*
      | روی ایندکس واقعی ۲۱۰ سطر مازاد از این جنس بود (۱۹۰ کلید
      | تکراری) — مثل `m.has(a) && m.has(b)` که دو بار روی خط ۱۹۸
      | «has» را صدا می‌زند. خطای استخراج نیست، ولی برای پیمایش دو
      | یال یعنی دو بار راه رفتن روی یک راه.
      */
      const engine = new GraphQueryEngine(indexWithContestedEdge());
      expect(engine.edgesFrom('a', 'out', ['calls'], 0).filter(e => e.to === 'b')).toHaveLength(1);
    });

    it('`edgeCount` رابطه می‌شمارد، نه ادعا', () => {
      const engine = new GraphQueryEngine(indexWithContestedEdge());
      /* چهار ادعا در ورودی، دو رابطهٔ یکتا: a→b و b→c. */
      expect(engine.edgeCount).toBe(2);
    });
  });
});
