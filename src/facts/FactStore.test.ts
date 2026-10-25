/**
 * GAP-08 — لایهٔ Fact.
 *
 * آزمون‌ها روی سه ادعای این کلاس تمرکز دارند، چون هر سه‌تا در گراف
 * واقعی نقض شده بودند:
 *
 * ۱. **قوی‌ترین شاهد برنده است، نه اولین.** باگ اندازه‌گیری‌شده روی
 *    `semantic-engine/src`: جفت `d9316b2b→695a7f20` هم یال
 *    `name-match(40)` داشت و هم `import-resolved(85)`؛ چون ۴۰ زودتر
 *    درج شده بود، `path()` مسیر را «حدس» اعلام می‌کرد.
 * ۲. **نتیجه به ترتیب ورود وابسته نیست.** اگر همان ادعاها برعکس
 *    وارد شوند، همان برنده باید بیرون بیاید.
 * ۳. **بازنده گم نمی‌شود.** «۸۵ برنده شد» بدون «۴۰ هم بود» یعنی
 *    همان پنهان‌کاری‌ای که فاز ۱۹ برای رفعش provenance اضافه کرد.
 */

import { FactStore, Fact, confidenceOf } from './FactStore';
import { provenanceFor, EdgeBasis } from '../graphs/EdgeProvenance';
import { ExtractionSource } from '../core/types/common.types';

function fact(
  subject: string,
  predicate: string,
  object: string,
  basis: EdgeBasis,
  extractor: ExtractionSource = 'tree-sitter',
  attributes?: Record<string, unknown>
): Fact {
  return {
    subject,
    predicate,
    object,
    provenance: provenanceFor(basis, extractor, { file: `${subject}.ts`, line: 1 }),
    attributes,
  };
}

describe('FactStore — GAP-08', () => {
  describe('حل تعارض', () => {
    it('قوی‌ترین شاهد برنده است، حتی اگر ضعیف زودتر آمده باشد', () => {
      const store = new FactStore();
      store.add(fact('a', 'calls', 'b', 'name-match'));
      store.add(fact('a', 'calls', 'b', 'import-resolved'));

      const resolved = store.resolve();
      expect(resolved).toHaveLength(1);
      expect(resolved[0].provenance.basis).toBe('import-resolved');
      expect(resolved[0].provenance.confidence).toBe(confidenceOf('import-resolved'));
    });

    it('همان نتیجه، وقتی ادعاها برعکس وارد شوند', () => {
      const forward = new FactStore();
      forward.add(fact('a', 'calls', 'b', 'name-match'));
      forward.add(fact('a', 'calls', 'b', 'import-resolved'));

      const backward = new FactStore();
      backward.add(fact('a', 'calls', 'b', 'import-resolved'));
      backward.add(fact('a', 'calls', 'b', 'name-match'));

      expect(backward.resolve()[0].provenance).toEqual(forward.resolve()[0].provenance);
    });

    it('در اعتماد برابر، مبنای قوی‌تر برنده است — نه ترتیب درج', () => {
      /*
      | `declared` و `resolved` هر دو بالای آستانه‌اند ولی یکی
      | «در کد نوشته شده» و دیگری «کامپایلر گفت». بدون رتبهٔ مبنا،
      | این دو با ترتیب درج حل می‌شدند.
      */
      const store = new FactStore();
      const declared: Fact = {
        ...fact('K', 'extends', 'Base', 'declared'),
        provenance: { ...provenanceFor('declared', 'tree-sitter'), confidence: 98 },
      };
      const resolvedBasis: Fact = fact('K', 'extends', 'Base', 'resolved', 'lsp');

      store.add(declared);
      store.add(resolvedBasis);
      expect(store.resolve()[0].provenance.basis).toBe('resolved');

      const other = new FactStore();
      other.add(resolvedBasis);
      other.add(declared);
      expect(other.resolve()[0].provenance.basis).toBe('resolved');
    });

    it('در تساوی کامل، اولین می‌ماند — نتیجه قطعی است', () => {
      const store = new FactStore();
      store.add(fact('a', 'calls', 'b', 'ast', 'tree-sitter'));
      store.add(fact('a', 'calls', 'b', 'ast', 'heuristic'));
      expect(store.resolve()[0].provenance.extractor).toBe('tree-sitter');
    });
  });

  describe('نگه‌داشتن بازنده', () => {
    it('ادعای کنارگذاشته‌شده در `superseded` می‌ماند', () => {
      const store = new FactStore();
      store.add(fact('a', 'calls', 'b', 'name-match'));
      store.add(fact('a', 'calls', 'b', 'import-resolved'));

      const [only] = store.resolve();
      expect(only.superseded).toHaveLength(1);
      expect(only.superseded[0].basis).toBe('name-match');
    });

    it('`superseded` از قوی به ضعیف مرتب است', () => {
      const store = new FactStore();
      store.add(fact('a', 'calls', 'b', 'unresolved'));
      store.add(fact('a', 'calls', 'b', 'name-match'));
      store.add(fact('a', 'calls', 'b', 'ast'));

      const [only] = store.resolve();
      expect(only.provenance.basis).toBe('ast');
      expect(only.superseded.map(p => p.basis)).toEqual(['name-match', 'unresolved']);
    });

    it('رابطه‌ای که منابع دربارهٔ مبنایش اختلاف دارند `contested` است', () => {
      const agreed = new FactStore();
      agreed.add(fact('a', 'calls', 'b', 'ast', 'tree-sitter'));
      agreed.add(fact('a', 'calls', 'b', 'ast', 'lsp'));
      expect(agreed.resolve()[0].contested).toBe(false);

      const disputed = new FactStore();
      disputed.add(fact('a', 'calls', 'b', 'ast'));
      disputed.add(fact('a', 'calls', 'b', 'name-match'));
      expect(disputed.resolve()[0].contested).toBe(true);
    });
  });

  describe('تکرار', () => {
    it('ادعای عین‌به‌عین یک رابطه می‌ماند و شمرده می‌شود', () => {
      const store = new FactStore();
      store.add(fact('a', 'calls', 'b', 'ast'));
      store.add(fact('a', 'calls', 'b', 'ast'));
      store.add(fact('a', 'calls', 'b', 'ast'));

      expect(store.size).toBe(1);
      expect(store.claimCount).toBe(3);
      expect(store.stats().duplicates).toBe(2);
      expect(store.resolve()[0].corroborations).toBe(2);
      /* تکرار همان مبنا اختلاف نیست. */
      expect(store.resolve()[0].contested).toBe(false);
    });

    it('`attributes` در کلید تطبیق نیست — دو فراخوانی، یک رابطه', () => {
      const store = new FactStore();
      store.add(fact('a', 'calls', 'b', 'ast', 'tree-sitter', { line: 10 }));
      store.add(fact('a', 'calls', 'b', 'ast', 'tree-sitter', { line: 20 }));
      expect(store.size).toBe(1);
    });

    it('predicate متفاوت، رابطهٔ متفاوت', () => {
      const store = new FactStore();
      store.add(fact('a', 'calls', 'b', 'ast'));
      store.add(fact('a', 'imports', 'b', 'ast'));
      expect(store.size).toBe(2);
    });
  });

  describe('پرس‌وجو و آمار', () => {
    it('`resolveFor` فقط ادعاهای همان subject را می‌دهد، از قوی به ضعیف', () => {
      const store = new FactStore();
      store.add(fact('a', 'calls', 'weak', 'name-match'));
      store.add(fact('a', 'calls', 'strong', 'ast'));
      store.add(fact('other', 'calls', 'b', 'ast'));

      const rows = store.resolveFor('a');
      expect(rows.map(r => r.object)).toEqual(['strong', 'weak']);
    });

    it('`resolveFor` با predicate فیلتر می‌کند', () => {
      const store = new FactStore();
      store.add(fact('a', 'calls', 'b', 'ast'));
      store.add(fact('a', 'imports', 'c', 'ast'));
      expect(store.resolveFor('a', 'imports').map(r => r.object)).toEqual(['c']);
    });

    it('آمار، تفاوت ادعا و رابطه را می‌گوید', () => {
      const store = new FactStore();
      store.add(fact('a', 'calls', 'b', 'ast'));
      store.add(fact('a', 'calls', 'b', 'ast'));
      store.add(fact('a', 'calls', 'b', 'name-match'));
      store.add(fact('c', 'calls', 'd', 'ast'));

      expect(store.stats()).toEqual({
        claims: 4,
        resolved: 2,
        duplicates: 1,
        contested: 1,
      });
    });

    it('ترتیب خروجی، ترتیب اولین بار دیده شدن است', () => {
      const store = new FactStore();
      store.add(fact('z', 'calls', 'b', 'name-match'));
      store.add(fact('a', 'calls', 'b', 'ast'));
      store.add(fact('z', 'calls', 'b', 'ast'));

      expect(store.resolve().map(r => r.subject)).toEqual(['z', 'a']);
    });

    it('فروشگاه خالی، آمار خالی', () => {
      const store = new FactStore();
      expect(store.resolve()).toEqual([]);
      expect(store.stats()).toEqual({ claims: 0, resolved: 0, duplicates: 0, contested: 0 });
    });
  });
});
