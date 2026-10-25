/**
 * ApiMapExtractor — SE-BP-02: `apiMap` قطعی و بدون LLM.
 *
 * ## چرا بدون LLM
 *
 * `apiMap` از ابتدا `[]` هاردکد بود با کامنت «فاز ۷ (AI Metadata)» —
 * یعنی منتظر مدل. ولی ثبتِ مسیر در Express و Fastify یک الگوی **نحوی**
 * روشن است: یک فراخوانی متد با نامِ فعلِ HTTP و یک رشتهٔ ثابت به‌عنوان
 * اولین آرگومان. چیزی برای استنتاج نیست.
 *
 * سپردنِ کارِ قطعی به یک مدل، سه هزینه دارد: پول، تأخیر، و
 * غیرقطعی‌بودن. مدل را برای جایی نگه می‌داریم که واقعاً ابهام هست.
 *
 * ## چه چیزی *نباید* تطابق بدهد
 *
 * `src/api/routes.ts` در fixture یک آرایهٔ داده دارد:
 *
 * ```ts
 * export const ROUTES = [{ method: 'GET', path: '/users/:id', ... }];
 * ```
 *
 * استخراجی که این را «مسیر» بشمارد، یک تصادف را می‌خواند نه یک ثبت.
 * الگوها به شکلِ **فراخوانی** گره خورده‌اند، نه به وجود کلماتی مثل
 * `method` و `path`.
 *
 * ## محدودیت‌ها، صریح
 *
 * - مسیرِ ثبت‌شده با متغیر (`app.get(ROUTE, h)`) پیدا نمی‌شود؛ این
 *   استخراج فقط رشتهٔ ثابت را می‌خواند.
 * - `app.use('/prefix', router)` پیشوند را به مسیرهای آن router
 *   **اضافه نمی‌کند**؛ برای آن باید router را در فایل دیگری دنبال
 *   کرد. مسیرها همان‌طور که نوشته شده‌اند گزارش می‌شوند.
 * - فقط JS/TS.
 */

export type HttpMethod =
  | 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | 'ALL';

export type ApiFramework = 'express' | 'fastify' | 'nestjs';

export interface ExtractedRoute {
  readonly method: HttpMethod;
  readonly path: string;
  /** نامِ handler اگر یک ارجاعِ نام‌دار باشد؛ برای تابعِ درجا `null`. */
  readonly handlerName: string | null;
  readonly framework: ApiFramework;
  /** ۱-مبنا. */
  readonly line: number;
}

const HTTP_METHODS = new Set([
  'get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all',
]);

/**
 * اشیائی که فراخوانیِ متدِ HTTP رویشان یک ثبتِ مسیر است.
 *
 * محدود کردن به این نام‌ها، `widget.get('color')` را بیرون نگه
 * می‌دارد — بدون آن، هر `.get(` در پروژه یک «مسیر» می‌شد.
 */
const ROUTER_RECEIVERS = /^(app|router|server|fastify|api|routes?|express)$/i;

const JS_LIKE = /\.(m|c)?[jt]sx?$/;

export class ApiMapExtractor {
  extract(filePath: string, source: string): ExtractedRoute[] {
    if (!JS_LIKE.test(filePath)) return [];

    const lines = stripComments(source).split('\n');
    const routes: ExtractedRoute[] = [];

    this.collectMethodCalls(lines, routes);
    this.collectFastifyRouteObjects(lines, routes);
    this.collectNestDecorators(lines, routes);

    return routes;
  }

  /** `app.get('/x', handler)` — Express و Fastify هر دو همین شکل را دارند. */
  private collectMethodCalls(lines: string[], routes: ExtractedRoute[]): void {
    const pattern =
      /\b([A-Za-z_$][\w$]*)\s*\.\s*([a-z]+)\s*\(\s*(['"])([^'"]*)\3\s*(?:,\s*([^)]*))?\)/g;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      pattern.lastIndex = 0;

      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line)) !== null) {
        const receiver = match[1]!;
        const method = match[2]!;
        const routePath = match[4]!;
        const rest = match[5] ?? '';

        if (!HTTP_METHODS.has(method)) continue;
        if (!ROUTER_RECEIVERS.test(receiver)) continue;
        if (routePath.length === 0) continue;

        routes.push({
          method: method.toUpperCase() as HttpMethod,
          path: routePath,
          handlerName: namedHandler(rest),
          framework: receiver.toLowerCase() === 'fastify' ? 'fastify' : 'express',
          line: i + 1,
        });
      }
    }
  }

  /** `fastify.route({ method: 'PATCH', url: '/x', handler: fn })`. */
  private collectFastifyRouteObjects(lines: string[], routes: ExtractedRoute[]): void {
    const pattern = /\broute\s*\(\s*\{([^}]*)\}/g;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      pattern.lastIndex = 0;

      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line)) !== null) {
        const body = match[1]!;
        const method = /\bmethod\s*:\s*['"]([A-Za-z]+)['"]/.exec(body)?.[1];
        const url = /\b(?:url|path)\s*:\s*['"]([^'"]+)['"]/.exec(body)?.[1];
        if (!method || !url) continue;
        if (!HTTP_METHODS.has(method.toLowerCase())) continue;

        const handler = /\bhandler\s*:\s*([A-Za-z_$][\w$.]*)/.exec(body)?.[1] ?? null;

        routes.push({
          method: method.toUpperCase() as HttpMethod,
          path: url,
          handlerName: handler,
          framework: 'fastify',
          line: i + 1,
        });
      }
    }
  }

  /**
   * NestJS — `@Controller('users')` روی کلاس و `@Get(':id')` روی متد.
   *
   * پیشوندِ کنترلر با مسیرِ متد ترکیب می‌شود، چون مسیرِ واقعی همان
   * است و گزارش کردنِ `:id` به‌تنهایی گمراه‌کننده است.
   */
  private collectNestDecorators(lines: string[], routes: ExtractedRoute[]): void {
    let prefix: string | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;

      const controller = /@Controller\s*\(\s*(?:['"]([^'"]*)['"])?\s*\)/.exec(line);
      if (controller) {
        prefix = controller[1] ?? '';
        continue;
      }
      if (prefix === null) continue;

      const decorator = /@(Get|Post|Put|Patch|Delete|Head|Options|All)\s*\(\s*(?:['"]([^'"]*)['"])?\s*\)/.exec(
        line
      );
      if (!decorator) continue;

      const method = decorator[1]!.toUpperCase() as HttpMethod;
      const suffix = decorator[2] ?? '';

      /*
      | نامِ متد روی همین خط یا خطِ بعدی است. دکوراتور و امضا معمولاً
      | جدا نوشته می‌شوند، پس هر دو نگاه می‌شوند.
      */
      const rest = line.slice(decorator.index + decorator[0].length);
      const handlerName =
        methodNameIn(rest) ?? methodNameIn(lines[i + 1] ?? '') ?? null;

      routes.push({
        method,
        path: joinNestPath(prefix, suffix),
        handlerName,
        framework: 'nestjs',
        line: i + 1,
      });
    }
  }
}

/**
 * نامِ handler، فقط وقتی یک ارجاعِ نام‌دار باشد.
 *
 * برای `(req, res) => ...` مقدار `null` برمی‌گردد. حدس زدنِ نامی که
 * وجود ندارد، بدتر از نگفتنش است.
 */
function namedHandler(rest: string): string | null {
  const trimmed = rest.trim();
  if (trimmed.length === 0) return null;
  const identifier = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*$/.exec(trimmed);
  return identifier ? identifier[1]! : null;
}

function methodNameIn(text: string): string | null {
  const match = /^\s*(?:public\s+|private\s+|protected\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\(/.exec(
    text
  );
  return match ? match[1]! : null;
}

function joinNestPath(prefix: string, suffix: string): string {
  const parts = [prefix, suffix].map(p => p.replace(/^\/+|\/+$/g, '')).filter(Boolean);
  return `/${parts.join('/')}`;
}

/**
 * کامنت‌ها را با فاصله جایگزین می‌کند تا شمارهٔ خط و ستون به‌هم نریزد.
 *
 * بدون این، `// app.get('/commented-out', h)` یک مسیر تولید می‌کرد.
 * رشته‌ها دنبال می‌شوند تا `'http://x'` به‌اشتباه کامنت حساب نشود.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;

  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];

    if (quote) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
      i++;
      continue;
    }

    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }

    if (ch === '/' && next === '*') {
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += '  ';
      i += 2;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}
