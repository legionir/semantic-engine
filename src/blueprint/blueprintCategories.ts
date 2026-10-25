/**
 * Static tables the blueprint generator classifies modules with: responsibility
 * categories, architecture layers, and the segment matcher they share.
 */

/**
 * دسته‌های مسئولیت، به ترتیبِ خاص‌بودن.
 *
 * ترتیب فقط برای شکستن تساوی به کار می‌رود — برندهٔ اصلی، پرتکرارترین
 * دسته است. پیش از SE-BP-05 همین ترتیب *تنها* عاملِ تصمیم بود، که
 * یعنی یک فایل با «service» در نامش بر دوازده فایل دیگر می‌چربید.
 */
export const MODULE_CATEGORIES: readonly { readonly label: string; readonly patterns: readonly string[] }[] =
  Object.freeze([
    { label: 'Handles HTTP/API routing', patterns: ['controller', 'route'] },
    { label: 'Request/response pipeline middleware', patterns: ['middleware'] },
    { label: 'Data access and persistence', patterns: ['repository'] },
    { label: 'Business logic and orchestration', patterns: ['service'] },
    { label: 'Domain models and data structures', patterns: ['model'] },
    { label: 'UI components', patterns: ['component'] },
    { label: 'React/state hooks', patterns: ['hook'] },
    { label: 'Shared utilities and helpers', patterns: ['util'] },
  ]);

/** برندهٔ رأی‌گیری باید دست‌کم یک‌سومِ فایل‌های غیرتست را داشته باشد. */
export const MIN_CATEGORY_SHARE_DIVISOR = 3;

/** مسیرِ ماژولِ فایل‌های ریشه — SE-BP-04. */
export const ROOT_MODULE_PATH = '.';

/**
 * آیا یکی از قطعه‌های مسیر با این الگو می‌خواند — با تحملِ جمعِ ساده.
 *
 * نام‌گذاریِ جمع قاعده است نه استثنا (`services`, `controllers`,
 * `repositories`, `models`). تطبیقِ برابریِ خالص روی fixtureِ خودِ
 * پروژه شکست خورد: لایهٔ application خالی درآمد چون پوشه
 * `src/services` است و الگو `service`.
 *
 * تحمل عمداً محدود است — `s`، `es` و `ies` — تا `serviceable` جمعِ
 * `service` حساب نشود.
 */
export function matchesSegment(pattern: string, segments: ReadonlySet<string>): boolean {
  if (segments.has(pattern)) return true;
  if (segments.has(`${pattern}s`)) return true;
  if (segments.has(`${pattern}es`)) return true;
  if (pattern.endsWith('y') && segments.has(`${pattern.slice(0, -1)}ies`)) return true;
  return false;
}

/**
 * لایه‌های معماری، به ترتیبِ جریانِ متعارفِ درخواست.
 *
 * SE-BP-02 — `architectureOverview.layers` همیشه `[]` بود با کامنت
 * «فاز ۷ (AI Metadata)». ولی لایه‌بندی روی ساختار پوشه، **نیازی به
 * LLM ندارد**: همان قراردادهای نام‌گذاری که `inferResponsibility` از
 * آنها استفاده می‌کند، اینجا هم کار می‌کنند.
 *
 * هر ماژول حداکثر به یک لایه می‌رود (اولین تطابق)، وگرنه «لایه»
 * معنایش را از دست می‌دهد.
 */
export const ARCHITECTURE_LAYERS: readonly {
  readonly name: string;
  readonly responsibility: string;
  readonly patterns: readonly string[];
}[] = Object.freeze([
  {
    name: 'presentation',
    responsibility: 'Handles incoming requests and shapes responses',
    patterns: ['controller', 'route', 'api', 'handler', 'view', 'component', 'ui'],
  },
  {
    name: 'application',
    responsibility: 'Business logic and orchestration',
    patterns: ['service', 'usecase', 'use-case', 'workflow', 'command', 'query'],
  },
  {
    name: 'domain',
    responsibility: 'Domain models and entities',
    patterns: ['model', 'entity', 'domain', 'schema'],
  },
  {
    name: 'data',
    responsibility: 'Persistence and external data access',
    patterns: ['repository', 'dao', 'store', 'persistence', 'migration'],
  },
  {
    name: 'infrastructure',
    responsibility: 'Cross-cutting technical concerns',
    patterns: ['middleware', 'config', 'util', 'helper', 'lib', 'infra'],
  },
]);
