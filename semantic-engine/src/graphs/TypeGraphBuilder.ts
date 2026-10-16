/**
 * ساخت TypeGraph از روی symbols استخراج‌شده.
 *
 * TypeGraph شامل روابط extends/implements بین symbol هاست.
 * در این فاز ساده، از فیلدهای symbol.extends و symbol.implements استفاده می‌کنیم.
 */

import { TypeEdge, SymbolEntry } from '../core/types/project-index.types';
import { SymbolIndex } from './SymbolIndex';
import { provenanceFor, EdgeBasis } from './EdgeProvenance';

export class TypeGraphBuilder {
  private readonly symbolIndex: SymbolIndex;

  constructor(private readonly symbols: readonly SymbolEntry[]) {
    this.symbolIndex = new SymbolIndex(symbols);
  }

  build(): readonly TypeEdge[] {
    const edges: TypeEdge[] = [];

    for (const sym of this.symbols) {
      if (sym.extends) {
        for (const parentName of sym.extends) {
          const parent = this.resolveSymbol(parentName, sym);
          if (parent) {
            edges.push({
              parent: parent.id,
              child: sym.id,
              kind: 'extends',
              provenance: provenanceFor(parent.basis, 'tree-sitter'),
            });
          }
        }
      }

      if (sym.implements) {
        for (const parentName of sym.implements) {
          const parent = this.resolveSymbol(parentName, sym);
          if (parent) {
            edges.push({
              parent: parent.id,
              child: sym.id,
              kind: 'implements',
              provenance: provenanceFor(parent.basis, 'tree-sitter'),
            });
          }
        }
      }
    }

    return edges;
  }

  /**
   * پیدا کردن symbol والد، همراه با اینکه *چطور* پیدا شد.
   *
   * SE-GRAPH-05 — نسخهٔ قبلی `baseFqName` و `candidate` را محاسبه
   * می‌کرد و **هرگز استفاده نمی‌کرد**؛ هر دو شاخه به همان
   * `findByName(name)` می‌رسیدند. یعنی زیر ظاهرِ «اول FQN را امتحان
   * کن»، تنها کاری که انجام می‌شد «اولین symbol هم‌نام در کل پروژه»
   * بود.
   *
   * کد مرده حذف شد و آنچه واقعاً اتفاق می‌افتد صادقانه علامت می‌خورد:
   * ترجیح با symbol هم‌فایل است (`ast`)، وگرنه تطبیق نام سراسری
   * (`name-match`) با اعتماد پایین.
   */
  private resolveSymbol(
    name: string,
    context: SymbolEntry
  ): { id: string; basis: EdgeBasis } | undefined {
    const sameFile = this.symbolIndex.findByNameAndFile(context.fileId, name);
    if (sameFile) return { id: sameFile.id, basis: 'ast' };

    const anywhere = this.symbolIndex.findByName(name);
    return anywhere ? { id: anywhere.id, basis: 'name-match' } : undefined;
  }
}
