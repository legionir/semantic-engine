/**
 * JsonSymbolExtractor — استخراج symbol از فایل‌های JSON.
 *
 * هر کلید یک symbol از نوع `property` است. شناسه از **مسیر** کلید
 * ساخته می‌شود، نه از مقدارش، پس تغییر مقدار شناسه را عوض نمی‌کند.
 *
 * تا فاز ۱۶ این استخراج‌گر دو مرحله داشت — `JSON.parse` روی متن
 * کامنت‌زدایی‌شده، و بعد جست‌وجوی regex برای شماره خط — و هر دو مرحله
 * شکسته بودند (SE-SYM-21 و SE-SYM-22). حالا یک پیمایش با موقعیت
 * انجام می‌شود که هم رشته‌ها را می‌فهمد و هم مسیر هر کلید را می‌داند.
 */

import { ISymbolExtractor, SymbolExtractionResult } from '../ISymbolExtractor';
import { SymbolEntry } from '../../core/types/project-index.types';
import { ExtractionSource, Result, ok, makeConfidence } from '../../core/types/common.types';
import { getLineNumber } from '../../core/utils/lineNumber';
import { scanJsonKeys, dialectFor, JsonKeyRange } from './JsonScanner';
import { SymbolIdAllocator } from '../../core/id/SymbolIdentity';

export class JsonSymbolExtractor implements ISymbolExtractor {
  readonly name: ExtractionSource = 'heuristic';
  readonly priority = 10;

  async isAvailable(languageId: string): Promise<boolean> {
    return languageId === 'json' || languageId === 'jsonc' || languageId === 'json5';
  }

  async extract(
    fileId: string,
    filePath: string,
    content: string,
    languageId: string
  ): Promise<Result<SymbolExtractionResult>> {
    const warnings: string[] = [];

    /*
    | کامنت فقط در jsonc و json5 مجاز است، و کلید بدون نقل‌قول فقط در
    | json5. کامنت‌زدایی از *همهٔ* فایل‌های JSON بود که SE-SYM-21 را
    | می‌ساخت — و حتی آن‌جا هم حذف نمی‌شود بلکه حین پیمایش رد می‌شود،
    | تا یک `//` داخل یک URL دست‌نخورده بماند.
    |
    | SE-SCAN-12: این شرط تا فاز ۲۲ هرگز برآورده نمی‌شد. رجیستری پسوند
    | `.jsonc` را به idِ `'json'` نگاشت می‌کرد، پس هر فایل JSONC —
    | از جمله `tsconfig.json` خودِ همین پکیج — با خطای تجزیه و صفر
    | symbol برمی‌گشت.
    */
    const dialect = dialectFor(languageId);

    let entries: JsonKeyRange[];
    try {
      entries = scanJsonKeys(content, dialect);
    } catch (error) {
      warnings.push(`JSON parse error: ${error instanceof Error ? error.message : String(error)}`);
      return ok({ symbols: [], source: 'heuristic', partial: true, warnings });
    }

    const allocator = new SymbolIdAllocator();
    const idByPath = new Map<string, string>();
    const symbols: SymbolEntry[] = [];

    /*
    | پیمایشگر فرزندان را پیش از والد بیرون می‌دهد (والد تا پایان
    | مقدارش کامل نشده). برای اینکه `parentId` همیشه در دست باشد،
    | بر اساس عمق مسیر مرتب می‌کنیم؛ ترتیب ظاهر شدن در همان عمق حفظ
    | می‌ماند چون مرتب‌سازی پایدار است.
    */
    const ordered = [...entries].sort((a, b) => depthOf(a.path) - depthOf(b.path));

    for (const entry of ordered) {
      const parentPath = parentOf(entry.path);
      const parentId = parentPath ? idByPath.get(parentPath) ?? null : null;

      const allocated = allocator.allocate({
        filePath,
        parentFqName: parentPath ? `${filePath}::${parentPath}` : null,
        name: entry.key,
        kind: 'property',
      });
      idByPath.set(entry.path, allocated.id);

      symbols.push({
        id: allocated.id,
        fileId,
        parentId,
        kind: 'property',
        name: entry.key,
        fullyQualifiedName: `${filePath}::${entry.path}`,
        line: getLineNumber(content, entry.keyOffset),
        endLine: getLineNumber(content, entry.valueEnd),
        source: 'heuristic',
        confidence: makeConfidence(70),
      });
    }

    // ترتیب خروجی بر اساس موقعیت در فایل — قابل پیش‌بینی برای خواننده
    symbols.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));

    return ok({ symbols, source: 'heuristic', partial: false, warnings });
  }

  async dispose(): Promise<void> {}
}

/** `a.b[0].c` → عمق ۳. اندیس آرایه بخشی از همان گام است. */
function depthOf(path: string): number {
  return path.split('.').length;
}

function parentOf(path: string): string | null {
  const lastDot = path.lastIndexOf('.');
  return lastDot === -1 ? null : path.slice(0, lastDot);
}
