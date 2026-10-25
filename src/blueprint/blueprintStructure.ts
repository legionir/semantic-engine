/**
 * Pure structure helpers of the blueprint (split from BlueprintGenerator.ts, behavior unchanged).
 */

import * as path from 'path';
import { FileEntry } from '../core/types/project-index.types';
import { sha256 } from '../core/utils/hash';
import { FolderNode } from '../core/types/blueprint.types';
import { MIN_CATEGORY_SHARE_DIVISOR, MODULE_CATEGORIES, ROOT_MODULE_PATH } from './blueprintCategories';

/**
 * ماژولِ یک فایل = دایرکتوری والدش.
 *
 * SE-BP-04 — قبلاً برای `dir === '.'` مقدار `null` برمی‌گشت، پس هر
 * فایلِ ریشه (`package.json`, `README.md`, `tsconfig.json`) در هیچ
 * ماژولی نبود و از `moduleMap` غایب می‌ماند. حالا همه در یک ماژولِ
 * صریحِ ریشه جمع می‌شوند.
 */
export function deriveModulePath(filePath: string): string {
  const dir = path.dirname(filePath).replace(/\\/g, '/');
  return dir === '.' || dir === '' ? ROOT_MODULE_PATH : dir;
}

/**
 * شناسهٔ ماژول — SE-BP-01.
 *
 * نسخهٔ قبلی این بود:
 *
 * ```ts
 * modulePath.replace(/\//g, '-').replace(/_/g, '-').toLowerCase()
 * ```
 *
 * سه نگاشتِ اتلافی روی هم: جداکنندهٔ مسیر و زیرخط هر دو به `-`
 * تبدیل می‌شدند و همه‌چیز کوچک می‌شد. پس `src/foo_bar` و
 * `src/foo/bar` هر دو `mod-src-foo-bar` می‌شدند، و `src/FooBar` با
 * `src/foobar` یکی. دو `ModuleEntry` با شناسهٔ یکسان در `moduleMap`
 * ظاهر می‌شدند و نگاشتِ فایل به ماژول غلط می‌شد.
 *
 * حالا شناسه هم **خوانا** می‌ماند و هم **یکتا**: شکلِ خواناشده
 * ساخته می‌شود و اگر با مسیرِ اصلی بازگشت‌پذیر نباشد، یک پسوندِ
 * کوتاهِ هش از مسیرِ دقیق به آن اضافه می‌شود.
 */
export function modulePathToId(modulePath: string): string {
  if (modulePath === ROOT_MODULE_PATH) return 'mod-root';

  const normalized = modulePath.replace(/\\/g, '/');
  const readable = normalized
    .toLowerCase()
    // هر نویسه خارج از `[a-z0-9]` (جداکننده، `_`، `.`، `@`، فاصله، ...)
    // با schema (`^mod-[a-z0-9-]+$`) سازگار نیست؛ مثلاً `.github` یا `@types`.
    .replace(/[^a-z0-9]+/g, '-')
    // `src/__tests__` نباید `src---tests--` شود.
    .replace(/^-|-$/g, '');

  // بازگشت‌پذیر؟ اگر شکلِ خوانا اطلاعاتی را دور نریخته باشد، همان کافی است.
  const lossless = /^[a-z0-9]+(\/[a-z0-9]+)*$/.test(normalized);

  if (lossless) return `mod-${readable}`;

  const hash = sha256(normalized).substring(0, 6);
  return readable ? `mod-${readable}-${hash}` : `mod-${hash}`;
}

/**
 * مسئولیت ماژول را با **رأی‌گیری روی فایل‌ها** تعیین می‌کند.
 *
 * SE-BP-05 — نسخهٔ قبلی این بود:
 *
 * ```ts
 * const names = files.map(f => f.path).join(' ');
 * const lower = names.toLowerCase();
 * if (lower.includes('service')) return 'Business logic and orchestration';
 * ...
 * if (lower.includes('test')) return 'Test specifications';
 * ```
 *
 * یعنی زیررشته را در *الحاقِ* همهٔ مسیرها می‌جست، پس یک فایل کافی
 * بود تا برچسبِ کلِ ماژول عوض شود، و ترتیبِ if ها تعیین می‌کرد کدام
 * فایل برنده است. اندازه‌گیری روی ایندکس واقعی این پکیج (۳۲ ماژول):
 * ۲۵ ماژول برچسب «Test specifications» گرفتند و ۲۰ تای آنها
 * اکثریتشان کدِ منبع بود.
 *
 * حالا هر فایل *مستقل* دسته‌بندی می‌شود و پرتکرارترین دسته برنده
 * است. دو قاعدهٔ صریح:
 *
 * - **فایل‌های تست در رأی‌گیریِ موضوع شرکت نمی‌کنند.** `X.test.ts`
 *   دربارهٔ موضوعِ ماژول چیزی نمی‌گوید جز اینکه `X` آزموده شده.
 *   «Test specifications» فقط وقتی برنده است که هیچ فایلِ غیرتست
 *   نمانده باشد.
 * - **تساوی به نفعِ دستهٔ خاص‌تر شکسته می‌شود** (ترتیب `CATEGORIES`)،
 *   تا نتیجه به ترتیبِ ورودی حساس نباشد.
 */
export function inferResponsibility(moduleName: string, files: FileEntry[]): string {
  const votes = new Map<string, number>();
  let nonTestFiles = 0;

  for (const file of files) {
    if (isTestFile(file)) continue;
    nonTestFiles++;

    const category = categorizeFile(file.path);
    if (category) votes.set(category, (votes.get(category) ?? 0) + 1);
  }

  if (nonTestFiles === 0 && files.length > 0) return 'Test specifications';

  let winner: string | null = null;
  let best = 0;
  for (const category of MODULE_CATEGORIES) {
    const count = votes.get(category.label) ?? 0;
    if (count > best) {
      best = count;
      winner = category.label;
    }
  }

  /*
  | اکثریتِ نسبی کافی نیست. `mod-lsp` روی ایندکس واقعی سیزده فایل
  | منبع دارد که فقط یکی‌شان `LspEnrichmentService.ts` است؛ با
  | رأی‌گیریِ ساده همان یک رأی برنده می‌شد چون بقیه هیچ رأیی
  | نمی‌دهند. برچسبی که از ۸٪ فایل‌ها می‌آید، دربارهٔ ماژول چیزی
  | نمی‌گوید.
  |
  | آستانه یک‌سوم است: قضاوت، نه اندازه‌گیری — ولی قضاوتی که نوشته
  | شده و آزمون دارد.
  */
  if (winner && best * MIN_CATEGORY_SHARE_DIVISOR >= nonTestFiles) return winner;
  if (moduleName === 'src' || moduleName === 'app') {
    return 'Application entrypoint and core setup';
  }
  return `Module ${moduleName}`;
}

export function isTestFile(file: FileEntry): boolean {
  if (file.testFile) return true;
  return /\.(test|spec)\.[cm]?[jt]sx?$/i.test(file.path);
}

/** دستهٔ یک فایل بر اساس مسیرِ *خودش*، نه الحاقِ مسیرهای ماژول. */
export function categorizeFile(filePath: string): string | null {
  const lower = filePath.toLowerCase();
  for (const category of MODULE_CATEGORIES) {
    if (category.patterns.some(pattern => lower.includes(pattern))) {
      return category.label;
    }
  }
  return null;
}

export function buildFolderStructure(files: readonly FileEntry[]): FolderNode {
  interface MutableFolderNode {
    name: string;
    type: 'file' | 'directory';
    fileId?: string | null;
    children?: MutableFolderNode[];
  }

  const root: MutableFolderNode = { name: '.', type: 'directory', children: [] };
  const index = new Map<string, MutableFolderNode>();
  index.set('.', root);

  for (const file of files) {
    const parts = file.path.split('/');
    let currentPath = '';

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const isFile = i === parts.length - 1;
      const parentPath = currentPath || '.';
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      let node = index.get(currentPath);
      if (!node) {
        node = isFile
          ? { name: part, type: 'file', fileId: file.id }
          : { name: part, type: 'directory', children: [] };
        index.set(currentPath, node);

        const parent = index.get(parentPath)!;
        parent.children = parent.children ?? [];
        parent.children.push(node);
      }
    }
  }

  sortFolderChildren(root);
  return root as FolderNode;
}

export function sortFolderChildren(node: { children?: { name: string; type: 'file' | 'directory'; children?: unknown[] }[] }): void {
  if (!node.children || node.children.length === 0) return;
  node.children.sort((a, b) => {
    if (a.type === b.type) return a.name.localeCompare(b.name);
    return a.type === 'directory' ? -1 : 1;
  });
  for (const child of node.children) {
    if ('children' in child) {
      sortFolderChildren(child as { children?: { name: string; type: 'file' | 'directory'; children?: unknown[] }[] });
    }
  }
}
