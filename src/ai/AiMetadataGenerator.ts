import * as path from 'path';

/**
 * AiMetadataGenerator — تولید metadata مبتنی بر heuristic (فاز ۷ placeholder).
 *
 * تا زمانی که LLM API متصل نشده، این generator با تحلیل:
 * - مسیر و نام فایل
 * - imports / exports
 * - symbols و متریک‌هایشان
 * - dependency graph
 * metadata ای تولید می‌کند که با schema سازگار باشد و در فازهای بعدی جایگزین/تقویت شود.
 */

import {
  FileEntry,
  SymbolEntry,
  DependencyEdge,
  AiMetadata,
  AiScore,
} from '../core/types/project-index.types';
import { isPackageRef } from '../graphs/EdgeProvenance';
import { estimateTokensFromLength } from './ranking/TokenBudget';

export interface AiMetadataInput {
  readonly workspaceRoot: string;
  readonly files: readonly FileEntry[];
  readonly symbols: readonly SymbolEntry[];
  readonly dependencyGraph: readonly DependencyEdge[];
  /** دامنه — فقط این فایل‌ها دوباره تحلیل شوند. */
  readonly changedFileIds?: ReadonlySet<string>;
  /** نتیجهٔ قبلی، برای فایل‌های دست‌نخورده. */
  readonly previous?: ReadonlyMap<string, AiMetadata>;
}

interface FileAnalysisContext {
  readonly imports: string[];
  readonly exports: string[];
  readonly symbols: SymbolEntry[];
  readonly outgoingFileIds: string[];
  readonly incomingFileIds: string[];
  readonly frameworks: string[];
  readonly patterns: string[];
  readonly domains: string[];
  readonly referenceCount: number;
}

const FRAMEWORK_PATTERNS: Readonly<Record<string, string>> = {
  express: 'Express',
  'express/': 'Express',
  react: 'React',
  'react/': 'React',
  'react-dom': 'React',
  next: 'Next.js',
  'next/': 'Next.js',
  vue: 'Vue',
  'vue/': 'Vue',
  nestjs: 'NestJS',
  '@nestjs/': 'NestJS',
  typeorm: 'TypeORM',
  prisma: 'Prisma',
  mongoose: 'Mongoose',
  jest: 'Jest',
  'react-native': 'React Native',
  angular: 'Angular',
  '@angular/': 'Angular',
  fastify: 'Fastify',
  koa: 'Koa',
  hapi: 'Hapi',
  redux: 'Redux',
  mobx: 'MobX',
  zustand: 'Zustand',
  tailwindcss: 'Tailwind CSS',
  sass: 'Sass',
};

const DOMAIN_PATTERNS: Readonly<Record<string, string>> = {
  user: 'User Management',
  account: 'User Management',
  profile: 'User Management',
  auth: 'Authentication & Authorization',
  login: 'Authentication & Authorization',
  logout: 'Authentication & Authorization',
  permission: 'Authentication & Authorization',
  role: 'Authentication & Authorization',
  order: 'Order & Commerce',
  cart: 'Order & Commerce',
  checkout: 'Order & Commerce',
  payment: 'Payment & Billing',
  invoice: 'Payment & Billing',
  billing: 'Payment & Billing',
  product: 'Product & Inventory',
  catalog: 'Product & Inventory',
  inventory: 'Product & Inventory',
  notification: 'Notifications',
  email: 'Notifications',
  sms: 'Notifications',
  push: 'Notifications',
  report: 'Analytics',
  analytics: 'Analytics',
  dashboard: 'Analytics',
  metric: 'Analytics',
};

export class AiMetadataGenerator {
  /** قلاب تست — به ازای هر فایلی که واقعاً تحلیل شد. */
  protected onFileAnalysed(_fileId: string): void {
    /* subclasses may observe */
  }

  /**
   * SE-INC-04: تولید با دامنه.
   *
   * مسیر incremental این را با کل ایندکس صدا می‌زد، پس هر ذخیره
   * متادیتای *همهٔ* فایل‌ها را از نو می‌ساخت. با `changedFileIds` و
   * `previous`، فایل دست‌نخورده همان شیء قبلی‌اش را نگه می‌دارد —
   * که علاوه بر ارزان بودن، هویت مرجع را هم حفظ می‌کند و diff گرفتن
   * را ممکن می‌کند.
   */
  generate(input: AiMetadataInput): Map<string, AiMetadata> {
    const result = new Map<string, AiMetadata>();
    const scope = input.changedFileIds;
    const previous = input.previous;

    const reusable = (file: FileEntry): AiMetadata | undefined => {
      if (!scope || scope.has(file.id)) return undefined;
      return previous?.get(file.id);
    };

    /*
    | `analyzeFiles` سراسری است و باید بماند: امتیازها به وابستگی‌های
    | کل پروژه نگاه می‌کنند. ولی خودش I/O ندارد و روی داده‌های
    | درون‌حافظه کار می‌کند؛ چیزی که گران بود، `buildAiMetadata` به
    | ازای هر فایل بود.
    */
    const contexts = this.analyzeFiles(input);

    for (const file of input.files) {
      if (file.binary) continue;

      const carried = reusable(file);
      if (carried) {
        result.set(file.id, carried);
        continue;
      }

      const ctx = contexts.get(file.id);
      if (!ctx) continue;

      this.onFileAnalysed(file.id);
      result.set(file.id, this.buildAiMetadata(file, ctx));
    }

    return result;
  }

  private analyzeFiles(input: AiMetadataInput): Map<string, FileAnalysisContext> {
    const symbolsByFile = new Map<string, SymbolEntry[]>();
    for (const sym of input.symbols) {
      const list = symbolsByFile.get(sym.fileId);
      if (list) {
        list.push(sym);
      } else {
        symbolsByFile.set(sym.fileId, [sym]);
      }
    }

    const outgoing = new Map<string, Set<string>>();
    const incoming = new Map<string, Set<string>>();

    /*
    | SE-AI-08 — عضویت را می‌سنجیم، نه قرارداد نام‌گذاری را.
    |
    | رفعِ فاز ۱۹ (SE-AI-12) به `isPackageRef` تکیه می‌کرد، یعنی به
    | اینکه *هر* تولیدکنندهٔ یال، پکیج‌ها را با پیشوند علامت بزند. آن
    | شرط امروز برقرار است ولی یک قرارداد است نه یک تضمین: یالی که
    | با `kind: 'package'` و مقصدِ خامِ `react` ساخته شود، از فیلتر
    | رد می‌شود و نام پکیج داخل فیلدی می‌نشیند که نامش می‌گوید
    | شناسهٔ فایل است.
    |
    | معیار پذیرش فاز ۴۵ همین است: «`relatedFileIds` فقط fileId
    | معتبر داشته باشد». پس دقیقاً همان را می‌سنجیم.
    */
    const knownFileIds = new Set(input.files.map(f => f.id));

    for (const edge of input.dependencyGraph) {
      /*
      | SE-AI-12 — کامنت قبلی اینجا می‌گفت «فقط dependencyهای local
      | (fileId)» ولی کد *همهٔ* مقصدها را اضافه می‌کرد. یعنی
      | `relatedFileIds` نام ماژول‌های خارجی را هم در خود داشت —
      | `stdio.h`، `context`، `java.util.List` — در فیلدی که نامش
      | می‌گوید شناسهٔ فایل است.
      |
      | تا فاز ۱۹ این قابل تشخیص نبود، چون نام خام ماژول و fileId در
      | یک فضای نام بودند. حالا که پکیج‌ها پیشوند دارند، فیلتر کردنشان
      | یک شرط است.
      */
      if (isPackageRef(edge.to)) continue;
      if (!knownFileIds.has(edge.to) || !knownFileIds.has(edge.from)) continue;

      const fromSet = outgoing.get(edge.from) ?? new Set<string>();
      fromSet.add(edge.to);
      outgoing.set(edge.from, fromSet);

      const toSet = incoming.get(edge.to) ?? new Set<string>();
      toSet.add(edge.from);
      incoming.set(edge.to, toSet);
    }

    const contexts = new Map<string, FileAnalysisContext>();

    for (const file of input.files) {
      if (file.binary) continue;

      const fileSymbols = symbolsByFile.get(file.id) ?? [];
      const imports = (file.imports ?? []).map(imp => imp.from);
      const exports = (file.exports ?? []).map(exp => exp.name);
      const frameworks = this.detectFrameworks(imports);
      const patterns = this.detectPatterns(file, fileSymbols);
      const domains = this.detectDomains(file, exports, imports);
      const outgoingFileIds = Array.from(outgoing.get(file.id) ?? []).filter(id => id !== file.id);
      const incomingFileIds = Array.from(incoming.get(file.id) ?? []).filter(id => id !== file.id);
      const referenceCount = incomingFileIds.length + fileSymbols.reduce((sum, s) => sum + (s.referenceCount ?? 0), 0);

      contexts.set(file.id, {
        imports,
        exports,
        symbols: fileSymbols,
        outgoingFileIds,
        incomingFileIds,
        frameworks,
        patterns,
        domains,
        referenceCount,
      });
    }

    return contexts;
  }

  private buildAiMetadata(file: FileEntry, ctx: FileAnalysisContext): AiMetadata {
    const name = this.fileName(file.path);
    const exportList = ctx.exports.length > 0 ? ctx.exports.join(', ') : 'no public exports';
    const dependencyList = ctx.outgoingFileIds.length > 0
      ? `${ctx.outgoingFileIds.length} local module(s)`
      : 'no local dependencies';

    const summary = ctx.exports.length > 0
      ? `${name} provides ${exportList}. Depends on ${dependencyList}.`
      : `${name} is a support/utilities file at ${file.path}.`;

    const keywords = this.extractKeywords(file, ctx);
    /*
    | SE-AI-09 — یک فرمول، همان که بودجه‌بندی رویش بنا شده.
    |
    | قبلاً `lines * 15 + size / 4` بود. روی یک فایل ۱٬۰۰۰ خطی و
    | ۳۰KB این می‌شود ۲۲٬۵۰۰ توکن در برابر ۷٬۵۰۰ توکنِ تقریبِ
    | متعارف — سه برابر. اندازه‌گیری روی ایندکس واقعی: میانگین ۲٫۶۲
    | برابرِ `bytes ÷ 4`.
    |
    | سه فرمولِ متفاوت در مخزن وجود داشت و `TokenBudget` فاز ۴۲
    | چهارمی را اضافه کرد — با این تفاوت که بودجه‌بندی *واقعاً* روی
    | آن یکی بنا شده. پس همان مرجع است.
    */
    const tokenEstimate = Math.max(1, estimateTokensFromLength(file.size));

    const isEntryPoint = this.isEntryPoint(file);
    const aiScore = this.computeAiScore(file, ctx, isEntryPoint);

    return {
      summary,
      keywords,
      businessDomains: ctx.domains,
      designPatterns: ctx.patterns,
      frameworks: ctx.frameworks,
      relatedFileIds: [...new Set([...ctx.outgoingFileIds, ...ctx.incomingFileIds])].sort(),
      estimatedTokenCost: tokenEstimate,
      aiScore,
    };
  }

  private detectFrameworks(imports: string[]): string[] {
    const frameworks = new Set<string>();
    for (const imp of imports) {
      for (const [pattern, name] of Object.entries(FRAMEWORK_PATTERNS)) {
        if (imp === pattern || imp.startsWith(pattern)) {
          frameworks.add(name);
        }
      }
    }
    return Array.from(frameworks).sort();
  }

  private detectPatterns(file: FileEntry, symbols: SymbolEntry[]): string[] {
    const patterns = new Set<string>();
    const pathLower = file.path.toLowerCase();
    const names = [
      ...symbols.map(s => s.name.toLowerCase()),
      pathLower,
    ];

    if (pathLower.includes('repository') || names.some(n => n.endsWith('repository'))) {
      patterns.add('Repository');
    }
    if (pathLower.includes('service') || names.some(n => n.endsWith('service'))) {
      patterns.add('Service Layer');
    }
    if (pathLower.includes('controller') || names.some(n => n.endsWith('controller'))) {
      patterns.add('Controller/Handler');
    }
    if (pathLower.includes('middleware')) {
      patterns.add('Middleware');
    }
    if (names.some(n => n.includes('factory'))) {
      patterns.add('Factory');
    }
    if (names.some(n => n.includes('singleton'))) {
      patterns.add('Singleton');
    }
    if (names.some(n => n.includes('observer') || n.includes('subject') || n.includes('eventemitter'))) {
      patterns.add('Observer');
    }

    return Array.from(patterns).sort();
  }

  private detectDomains(file: FileEntry, exports: string[], imports: string[]): string[] {
    const domains = new Set<string>();
    const tokens = [
      file.path,
      ...exports,
      ...imports,
    ]
      .join(' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/);

    for (const token of tokens) {
      /*
      | `hasOwn`: a bare index would also hit inherited keys — a token like `constructor`
      | or `valueOf` (from `isConstructorNode`) returned a function and crashed keyword extraction.
      */
      if (!Object.prototype.hasOwnProperty.call(DOMAIN_PATTERNS, token)) continue;
      const domain = DOMAIN_PATTERNS[token];
      if (domain) domains.add(domain);
    }

    return Array.from(domains).sort();
  }

  private extractKeywords(file: FileEntry, ctx: FileAnalysisContext): string[] {
    const tokens = new Set<string>();

    const addTokens = (input: string) => {
      const split = input
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^a-z0-9]+/);
      for (const token of split) {
        if (token.length > 1) tokens.add(token);
      }
    };

    // path segments
    for (const part of file.path.split(/[/\\]/)) {
      const cleaned = part.replace(/\.(ts|js|tsx|jsx|py|go|java|json|md|yml|yaml)$/i, '');
      if (cleaned && !['src', 'dist', 'lib', 'test', 'tests'].includes(cleaned.toLowerCase())) {
        addTokens(cleaned);
      }
    }

    // exports and imports
    for (const name of [...ctx.exports, ...ctx.imports]) {
      addTokens(name);
    }

    // frameworks and patterns and domains
    for (const item of [...ctx.frameworks, ...ctx.patterns, ...ctx.domains]) {
      tokens.add(item.toLowerCase());
    }

    return Array.from(tokens).sort();
  }

  private computeAiScore(file: FileEntry, ctx: FileAnalysisContext, isEntryPoint: boolean): AiScore {
    const importsCount = ctx.imports.length;
    const exportsCount = ctx.exports.length;
    const complexitySum = ctx.symbols.reduce((sum, s) => sum + (s.complexity ?? 0), 0);
    const referenceCount = ctx.referenceCount;

    const entryBonus = isEntryPoint ? 30 : 0;
    const exportWeight = Math.min(exportsCount * 5, 25);
    const importWeight = Math.min(importsCount * 2, 15);
    const refWeight = Math.min(referenceCount * 10, 40);
    const complexityWeight = Math.min(complexitySum * 2, 20);
    const testPenalty = file.testFile ? -20 : 0;

    const importance = clamp(
      10 + entryBonus + exportWeight + importWeight + refWeight + complexityWeight + testPenalty,
      0,
      100
    );

    const readPriority = clamp(
      entryBonus + refWeight + Math.round(exportWeight * 1.5) + complexityWeight + importWeight,
      0,
      100
    );

    const hotness = clamp(
      refWeight + complexityWeight + importWeight,
      0,
      100
    );

    return {
      importance,
      readPriority,
      hotness,
      factors: {
        referenceCountWeight: refWeight,
        importCountWeight: importWeight,
        entryPointBonus: entryBonus,
      },
    };
  }

  private isEntryPoint(file: FileEntry): boolean {
    const lower = file.path.toLowerCase();
    const entryNames = ['index.ts', 'index.js', 'main.ts', 'main.js', 'app.ts', 'app.js', 'server.ts', 'server.js'];
    return entryNames.some(name => lower.endsWith('/' + name) || lower === name);
  }

  private fileName(filePath: string): string {
    return path.basename(filePath);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}
