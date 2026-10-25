/**
 * fileRole — SE-DATA-04.
 *
 * `FileEntry.role` و `FileEntry.entryPoint` سال‌ها در قرارداد داده
 * اعلام شده بودند و هیچ مسیر نوشتنی مقداردهی‌شان نمی‌کرد. `role` فقط
 * هرگز خوانده نمی‌شد، و `entryPoint` محاسبه
 * می‌شد ولی نتیجه‌اش داخل `aiScore.factors` دفن می‌شد و به خودِ فیلد
 * نمی‌رسید.
 *
 * منطقِ تشخیص از قبل در سه جای مختلف پراکنده بود
 * (`AiMetadataGenerator.isEntryPoint`، `inferResponsibility` در
 * blueprint، و الگوهای لایه‌بندی). اینجا یک‌جا جمع شده تا هر سه یک
 * تعریف داشته باشند.
 *
 * ## تطبیق روی قطعه، نه زیررشته
 *
 * همان درسِ SE-VEC-11 و SE-BP-05: `src/serviceable` یک service نیست و
 * `src/remodel` یک model نیست. مسیر به قطعه‌های الفبا-عددی شکسته
 * می‌شود و تطبیق روی قطعهٔ کامل انجام می‌شود، با تحملِ جمعِ ساده.
 */

import type { FileRole } from './types/project-index.types';

/** نام‌های متعارفِ نقطهٔ ورود. */
const ENTRY_NAMES = new Set(['index', 'main', 'app', 'server', 'cli', 'bin']);

const TEST_PATTERN = /(^|[^a-z0-9])(test|tests|spec|__tests__|__mocks__)([^a-z0-9]|$)/i;

/**
 * ترتیب مهم است: اولین تطابق برنده است.
 *
 * `test` بالاتر از همه چون `user.service.test.ts` یک تست است نه یک
 * service — تشخیصِ برعکس، فایل‌های تست را به‌عنوان کدِ منبع در
 * لایه‌بندی و رتبه‌بندی وارد می‌کند.
 */
const ROLE_PATTERNS: readonly { readonly role: FileRole; readonly patterns: readonly string[] }[] =
  Object.freeze([
    { role: 'controller', patterns: ['controller', 'route', 'router', 'handler', 'api'] },
    { role: 'service', patterns: ['service', 'usecase', 'workflow'] },
    { role: 'repository', patterns: ['repository', 'dao', 'store'] },
    { role: 'middleware', patterns: ['middleware', 'interceptor', 'guard'] },
    { role: 'model', patterns: ['model', 'entity', 'domain'] },
    { role: 'hook', patterns: ['hook', 'hooks'] },
    { role: 'component', patterns: ['component', 'components', 'widget'] },
    { role: 'config', patterns: ['config', 'configuration', 'settings', 'env'] },
    { role: 'util', patterns: ['util', 'utils', 'helper', 'helpers', 'lib', 'common'] },
  ]);

function segmentsOf(filePath: string): Set<string> {
  return new Set(
    filePath
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
  );
}

/** تحملِ جمعِ ساده — همان قاعدهٔ لایه‌بندی blueprint. */
function hasSegment(segments: ReadonlySet<string>, pattern: string): boolean {
  return (
    segments.has(pattern) ||
    segments.has(`${pattern}s`) ||
    segments.has(`${pattern}es`) ||
    (pattern.endsWith('y') && segments.has(`${pattern.slice(0, -1)}ies`))
  );
}

/** آیا این مسیر یک نقطهٔ ورود است. */
export function isEntryPointPath(filePath: string): boolean {
  if (TEST_PATTERN.test(filePath)) return false;

  const base = filePath.split('/').pop() ?? filePath;
  // `index.ts` → `index`، `project-index.types.ts` → `project-index.types`
  const stem = base.replace(/\.(m|c)?[jt]sx?$/, '').replace(/\.d$/, '');

  return ENTRY_NAMES.has(stem.toLowerCase());
}

/**
 * نقشِ یک فایل از روی مسیرش.
 *
 * `unknown` یک پاسخ درست است. حدس زدنِ نقشی که شواهدش نیست، همان
 * کاری است که SE-BP-05 در سطح ماژول انجام می‌داد و ۲۵ ماژول از ۳۲ را
 * غلط برچسب می‌زد.
 */
export function classifyFileRole(filePath: string): FileRole {
  if (TEST_PATTERN.test(filePath)) return 'test';
  if (isEntryPointPath(filePath)) return 'entrypoint';

  const base = (filePath.split('/').pop() ?? filePath).toLowerCase();
  if (base.endsWith('.d.ts') || /(^|[.-])types?\./.test(base) || segmentsOf(filePath).has('types')) {
    return 'type-definition';
  }

  const segments = segmentsOf(filePath);
  for (const entry of ROLE_PATTERNS) {
    if (entry.patterns.some(pattern => hasSegment(segments, pattern))) return entry.role;
  }

  return 'unknown';
}
