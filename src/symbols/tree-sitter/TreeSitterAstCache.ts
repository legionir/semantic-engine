/**
 * TreeSitterAstCache — کش درخت‌های parse بر اساس fileId و hash محتوا.
 *
 * ── چرا سقف دارد (SE-SYM-14) ───────────────────────────────────────
 *
 * درخت‌های tree-sitter در حافظهٔ **WASM** زندگی می‌کنند، نه در heap
 * جاوااسکریپت. یعنی GC آزادشان نمی‌کند و فشار حافظه هم نجاتشان
 * نمی‌دهد؛ تنها راه، فراخوانی صریح `delete()` است. کش قبلی هیچ سقفی
 * نداشت و یک درخت به‌ازای *هر فایل* نگه می‌داشت، که روی مخزن بزرگ
 * یعنی OOM.
 *
 * سیاست، LRU است: چیزی که مدت بیشتری استفاده نشده اول بیرون می‌رود،
 * و درختش همان‌جا آزاد می‌شود.
 */

import { Tree } from 'web-tree-sitter';
import { sha256 } from '../../core/utils/hash';

export interface AstCacheEntry {
  readonly tree: Tree;
  readonly contentHash: string;
  readonly languageId: string;
}

export interface TreeSitterAstCacheOptions {
  /**
   * بیشترین تعداد درختی که هم‌زمان نگه داشته می‌شود.
   *
   * پیش‌فرض ۱۰۲۴ — به‌قدری بزرگ که یک ماژول معمولی کامل در کش بماند،
   * و به‌قدری کوچک که روی مخزن ده‌هزار فایلی حافظهٔ WASM را نترکاند.
   */
  readonly maxEntries?: number;
}

export class TreeSitterAstCache {
  /*
  | ترتیب درج در `Map` جاوااسکریپت حفظ می‌شود، پس قدیمی‌ترین کلید
  | همان اولین کلید است. برای «تازه استفاده شد»، ورودی حذف و دوباره
  | درج می‌شود تا به انتهای ترتیب برود — LRU بدون ساختار دادهٔ اضافه.
  */
  private readonly cache = new Map<string, AstCacheEntry>();
  private readonly maxEntries: number;

  constructor(options: TreeSitterAstCacheOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 1024);
  }

  /**
   * دریافت entry اگر hash محتوا مطابقت داشته باشد.
   */
  get(fileId: string, contentHash: string): AstCacheEntry | undefined {
    const entry = this.cache.get(fileId);
    if (entry && entry.contentHash === contentHash) {
      this.touch(fileId, entry);
      return entry;
    }
    return undefined;
  }

  /**
   * دریافت tree بدون چک کردن hash (برای incremental edit).
   */
  getTree(fileId: string): Tree | undefined {
    const entry = this.cache.get(fileId);
    if (!entry) return undefined;
    this.touch(fileId, entry);
    return entry.tree;
  }

  /**
   * ثبت/به‌روزرسانی tree در cache.
   */
  set(fileId: string, contentHash: string, tree: Tree, languageId: string): void {
    const existing = this.cache.get(fileId);
    if (existing && existing.tree !== tree) {
      existing.tree.delete();
    }
    this.cache.delete(fileId);
    this.cache.set(fileId, { tree, contentHash, languageId });
    this.evictOverflow();
  }

  /** بردن یک ورودی به انتهای ترتیب استفاده. */
  private touch(fileId: string, entry: AstCacheEntry): void {
    this.cache.delete(fileId);
    this.cache.set(fileId, entry);
  }

  private evictOverflow(): void {
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next();
      if (oldest.done) return;

      const entry = this.cache.get(oldest.value);
      // آزادسازی صریح: حافظهٔ WASM با حذف از Map آزاد نمی‌شود.
      entry?.tree.delete();
      this.cache.delete(oldest.value);
    }
  }

  /**
   * ثبت tree با محاسبه‌ی خودکار hash از content.
   */
  setByContent(fileId: string, content: string, tree: Tree, languageId: string): void {
    this.set(fileId, sha256(content), tree, languageId);
  }

  /**
   * حذف یک entry از cache.
   */
  invalidate(fileId: string): void {
    const existing = this.cache.get(fileId);
    if (existing) {
      existing.tree.delete();
      this.cache.delete(fileId);
    }
  }

  /**
   * پاکسازی کامل cache.
   */
  clear(): void {
    for (const entry of this.cache.values()) {
      entry.tree.delete();
    }
    this.cache.clear();
  }

  /**
   * تعداد entry های cache.
   */
  size(): number {
    return this.cache.size;
  }
}
