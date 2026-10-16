/**
 * ساخت استخراج‌گرها از روی پیکربندی — MIG-21.
 *
 * تا امروز این کار داخل `activate()` هاردکد بود: ده `register` پشت هم،
 * با یک `LSPSymbolExtractor` که به `vscode.commands` وابسته بود. نتیجه
 * این بود که هیچ‌کس جز خود ویرایشگر نمی‌توانست مجموعهٔ استخراج‌گرها را
 * بسازد، و هیچ تستی نمی‌توانست ترکیب دیگری را امتحان کند.
 */

import * as fs from 'fs';
import * as path from 'path';
import { SymbolExtractorManager } from '../symbols/SymbolExtractorManager';
import { DependencyExtractorManager } from '../dependencies/DependencyExtractorManager';
import { HeuristicSymbolExtractor } from '../symbols/heuristic/HeuristicSymbolExtractor';
import { ImperativeSymbolExtractor } from '../symbols/heuristic/ImperativeSymbolExtractor';
import { JsonSymbolExtractor } from '../symbols/heuristic/JsonSymbolExtractor';
import { HtmlSymbolExtractor } from '../symbols/heuristic/HtmlSymbolExtractor';
import { CssSymbolExtractor } from '../symbols/heuristic/CssSymbolExtractor';
import { TreeSitterParserManager } from '../symbols/tree-sitter/TreeSitterParserManager';
import { TreeSitterSymbolExtractor } from '../symbols/tree-sitter/TreeSitterSymbolExtractor';
import { TSDependencyExtractor } from '../dependencies/typescript/TSDependencyExtractor';
import { HeuristicDependencyExtractor } from '../dependencies/heuristic/HeuristicDependencyExtractor';
import { LspSymbolExtractor } from '../symbols/lsp/LspSymbolExtractor';
import { DiagnosticsProvider, FileDiagnosticsSource } from '../lsp/DiagnosticsProvider';
import { LspServerManager } from '../lsp/LspServerManager';
import { LspServerRegistry, describeMissingServers } from '../lsp/registry';
import { ILogger, silentLogger } from '../host/Logger';

export interface ExtractorFactoryOptions {
  readonly workspaceRoot: string;
  /**
   * tree-sitter نیاز به گرامرهای wasm و یک init ناهمگام دارد. خاموش
   * کردنش باید ممکن باشد — هم برای محیط‌هایی که گرامر ندارند و هم برای
   * خروجی قطعی در تست snapshot.
   */
  readonly treeSitter?: boolean;
  readonly grammarDir?: string | null;
  /**
   * استخراج symbol از زبان‌سرور — **پیش‌فرض خاموش**.
   *
   * نه به این دلیل که کار نمی‌کند (فاز ۳۳ روی همین fixture ثابتش
   * کرد)، بلکه به این دلیل که مسیر انبوه جای درستش نیست. اندازه‌گیری
   * `LSP-ARCHITECTURE.md` روی ۱۶۴ فایل همین مخزن:
   *
   * ```
   * tree-sitter : ۲۱۳ ms ·  ۶۵ MB
   * LSP         : ۷٬۷۴۱ ms · ۸۰۹ MB      ← ۳۶× کندتر، ۱۲× حافظه
   * ```
   *
   * جای LSP، **غنی‌سازی انتخابی و بودجه‌دار** روی نتیجهٔ سریع
   * tree-sitter است — که فاز ۳۷ می‌سازد. تا آن‌وقت این کلید برای
   * کسی است که آگاهانه هزینه‌اش را می‌پذیرد.
   */
  readonly lsp?: boolean;
  /**
   * فقط مرحلهٔ diagnostics — بدون استخراج symbol از زبان‌سرور.
   *
   * چندی از `lsp` است: هزینه‌اش بودجه‌دار است (`diagnosticsBudgetMs` در
   * پایپ‌لاین) و نتیجه‌اش چیزی است که مصرف‌کنندهٔ انبوه معمولاً می‌خواهد
   * («این فایل خطای کامپایلور دارد؟»), نه یک بازنویسی کاملِ نمادها.
   */
  readonly lspDiagnostics?: boolean;
  /** override به‌ازای شناسهٔ سرور — از `semanticEngine.lsp.servers`. */
  readonly lspServers?: Readonly<Record<string, { command?: string; args?: readonly string[]; disabled?: boolean }>>;
  readonly lspIdleTimeoutMs?: number;
  readonly lspMemoryLimitMb?: number;
  readonly lspRequestTimeoutMs?: number;
  readonly logger?: ILogger;
}

export interface ExtractorSet {
  readonly symbols: SymbolExtractorManager;
  readonly dependencies: DependencyExtractorManager;
  /**
   * منبع diagnostics زبان‌سرور — فقط وقتی ساخته می‌شود که `lspDiagnostics`
   * روشن باشد. `IndexPipeline` همین را به `diagnosticsSource` می‌دهد؛ تا
   * پیش از این، مرحلهٔ فاز ۳۴ در هیچ مسیر production اجرا نمی‌شد.
   */
  readonly diagnosticsSource?: FileDiagnosticsSource | null;
  dispose(): void;
}

/**
 * محل گرامرهای tree-sitter.
 *
 * همان ترتیبی که `getTreeSitterGrammarDir` در `extension.ts` داشت، منهای
 * `context.extensionUri` که بیرون از ویرایشگر وجود ندارد و جایش پوشهٔ
 * خود پکیج نشسته است.
 */
export function resolveGrammarDir(
  workspaceRoot: string,
  configured?: string | null
): string {
  if (configured) return configured;

  /*
  | SE-EXT-02: نسخهٔ قبلی فقط `packages/semantic-engine/…` را نگاه
  | می‌کرد، که با چیدمان واقعی همین مخزن (`semantic-engine/…`) نمی‌خورد
  | و همیشه رد می‌شد. هر دو بررسی می‌شوند.
  */
  const candidates = [
    path.join(workspaceRoot, 'packages', 'semantic-engine', 'tree-sitter-grammars'),
    path.join(workspaceRoot, 'semantic-engine', 'tree-sitter-grammars'),
    path.join(workspaceRoot, 'tree-sitter-grammars'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // پوشهٔ خود پکیج: dist/pipeline → ریشهٔ پکیج
  return path.join(__dirname, '..', '..', 'tree-sitter-grammars');
}

export function createExtractors(options: ExtractorFactoryOptions): ExtractorSet {
  const logger = options.logger ?? silentLogger;
  const symbols = new SymbolExtractorManager();
  const dependencies = new DependencyExtractorManager();
  let parserManager: TreeSitterParserManager | undefined;
  let lspManager: LspServerManager | undefined;
  let diagnosticsSource: FileDiagnosticsSource | undefined;

  if (options.lsp === true || options.lspDiagnostics === true) {
    /*
    | از فاز ۳۶ این کار به `LspServerManager` سپرده شده و نه یک
    | `LspClient` دستی: spawn تنبل، خاموشی سرور بیکار، restart با
    | backoff و تنزل پس از سه شکست، همه همان‌جا هستند. اینجا فقط
    | وصل کردن است.
    */
    const registry = new LspServerRegistry({ overrides: options.lspServers });
    const covered = ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'].some(
      language => registry.resolveForLanguage(language, options.workspaceRoot) !== null
    );

    if (!covered) {
      /*
      | نبودِ سرور خطا نیست — ولی کسی که کلید را روشن کرده باید
      | *بداند* که روشن نشده. پیام، دستور نصب را هم دارد.
      */
      logger.warn(describeMissingServers(registry, 'typescript'));
    } else {
      const manager = new LspServerManager({
        workspaceRoot: options.workspaceRoot,
        registry,
        logger,
        idleTimeoutMs: options.lspIdleTimeoutMs,
        memoryLimitMb: options.lspMemoryLimitMb,
        requestTimeoutMs: options.lspRequestTimeoutMs,
      });
      lspManager = manager;
      if (options.lsp === true) {
        symbols.register(
          new LspSymbolExtractor({
            logger,
            acquire: languageId => manager.acquire(languageId),
          })
        );
        logger.debug('lsp extractor registered');
      }
      if (options.lspDiagnostics === true) {
        diagnosticsSource = new DiagnosticsProvider({
          logger,
          acquire: languageId => manager.acquire(languageId),
        });
        logger.debug('lsp diagnostics registered');
      }
    }
  }

  if (options.treeSitter !== false) {
    const grammarDir = resolveGrammarDir(options.workspaceRoot, options.grammarDir);
    parserManager = new TreeSitterParserManager({ grammarDir });
    symbols.register(new TreeSitterSymbolExtractor({ parserManager }));
    logger.debug('tree-sitter extractor registered', { grammarDir });
  }

  /*
  | ترتیب ثبت مهم نیست — مدیر بر اساس `priority` انتخاب می‌کند
  | (tree-sitter=50, heuristic=10) — ولی پوشش زبانی مهم است: هر زبانی
  | که گرامر ندارد باید به heuristic برسد، نه به هیچ.
  */
  symbols.register(new HeuristicSymbolExtractor());
  symbols.register(new ImperativeSymbolExtractor());
  symbols.register(new JsonSymbolExtractor());
  symbols.register(new HtmlSymbolExtractor());
  symbols.register(new CssSymbolExtractor());

  dependencies.register(new TSDependencyExtractor());
  dependencies.register(new HeuristicDependencyExtractor());

  return {
    symbols,
    dependencies,
    diagnosticsSource: diagnosticsSource ?? null,
    dispose(): void {
      symbols.dispose();
      dependencies.dispose();
      diagnosticsSource?.dispose?.();
      parserManager?.dispose();
      void lspManager?.disposeAll();
    },
  };
}
