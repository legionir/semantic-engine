/**
 * رجیستری زبان‌سرورها — LSP-04.
 *
 * فاز ۳۲ فقط یک سرور را می‌شناخت (TypeScript، چون بدون نصب اضافه
 * می‌آید) و کامنت خودش می‌گفت «این یک رجیستری کامل نیست». این همان
 * جدول است.
 *
 * ── سه قاعده ───────────────────────────────────────────────────────
 *
 * **۱. هیچ‌وقت خودکار نصب نمی‌کنیم.** فقط تشخیص می‌دهیم و دستور
 * نصب را در `doctor` نشان می‌دهیم. نصب خودکار در یک CLI هم
 * غافلگیرکننده است هم ریسک امنیتی — یک `npm i -g` ناخواسته روی
 * ماشین کاربر.
 *
 * **۲. نبودِ سرور خطا نیست.** `resolve` مقدار `null` می‌دهد و
 * زنجیرهٔ استخراج با tree-sitter ادامه پیدا می‌کند. تنزل تمیز، شرط
 * پذیرش فاز ۳۶ است.
 *
 * **۳. `rootMarkers` فقط جایی که واقعاً لازم است.** وسوسه این است
 * که برای هر سرور نشانه‌ای بگذاریم (`package.json` برای TS،
 * `requirements.txt` برای Python). ولی سرورهایی مثل
 * `typescript-go` و `pyright` روی یک پوشهٔ بی‌کانفیگ هم کار می‌کنند،
 * و نشانه گذاشتن یعنی روی پروژه‌های واقعی بی‌دلیل خاموش می‌شوند.
 * نشانه فقط برای سرورهایی است که بدون آن **کار نمی‌کنند**:
 * `gopls` بدون `go.mod`، `clangd` بدون `compile_commands.json`،
 * `rust-analyzer` بدون `Cargo.toml`.
 *
 * ── دربارهٔ نسخه ────────────────────────────────────────────────────
 *
 * `tsc` روی PATH ممکن است نسخهٔ ۵ باشد که `--lsp` ندارد و خطایش را
 * روی stdout می‌ریزد (SE-LSP-07). برای همین resolve مخصوص
 * TypeScript از `typescriptServer.ts` می‌آید که نسخه را پیش از
 * spawn می‌سنجد. بقیهٔ سرورها چنین ابهامی ندارند.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  TypeScriptLspCommand,
  describeMissingTypeScriptLsp,
  resolveTypeScriptLspCommand,
} from './typescriptServer';

export interface LspServerSpec {
  readonly id: string;
  readonly languages: readonly string[];
  /** نام‌های باینری روی PATH، به‌ترتیب ترجیح. */
  readonly binaries: readonly string[];
  readonly args: readonly string[];
  /** دستوری که به کاربر نشان داده می‌شود. */
  readonly install: string;
  /**
   * فایل‌هایی که وجودشان یعنی این سرور به این پروژه می‌خورد.
   * خالی یعنی «همیشه مناسب».
   */
  readonly rootMarkers: readonly string[];
  /** آیا پس از `initialize` هم مدتی ایندکس می‌کند؟ */
  readonly needsWarmup: boolean;
  readonly initializationOptions?: Record<string, unknown>;
  /** resolve مخصوص، برای سروری که فقط روی PATH نیست. */
  readonly resolveCommand?: (options: ResolveOptions) => ResolvedLspServer | null;
  /** یادداشت کوتاه برای `doctor`. */
  readonly note?: string;
}

export type ResolutionSource = 'config' | 'env' | 'bundled' | 'path';

export interface ResolvedLspServer {
  readonly id: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly source: ResolutionSource;
  readonly version?: string;
}

export interface ResolveOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly exists?: (candidate: string) => boolean;
  /** override از پیکربندی: `{ [serverId]: { command, args, disabled } }` */
  readonly overrides?: Readonly<Record<string, ServerOverride>>;
}

export interface ServerOverride {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly disabled?: boolean;
}

/**
 * جدول پیش‌فرض.
 *
 * invocationها از مستندات رسمی هر سرور آمده‌اند و در
 * `LSP-ARCHITECTURE.md` بخش ۵.۱ فهرست شده‌اند. در این محیط فقط
 * TypeScript نصب است؛ بقیه با آزمونِ باینری ساختگی سنجیده می‌شوند،
 * نه با ادعا.
 */
export const DEFAULT_LSP_SERVERS: readonly LspServerSpec[] = [
  {
    id: 'typescript',
    languages: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'],
    binaries: ['tsgo', 'tsc'],
    args: ['--lsp', '--stdio'],
    install: 'npm install --save-dev @typescript/native-preview',
    rootMarkers: [],
    needsWarmup: false,
    note: 'ships with @typescript/native-preview; typescript@5 does not have --lsp',
    resolveCommand: options => {
      const resolved: TypeScriptLspCommand | null = resolveTypeScriptLspCommand({
        env: options.env,
        exists: options.exists,
      });
      if (!resolved) return null;
      return {
        id: 'typescript',
        command: resolved.command,
        args: resolved.args,
        source: resolved.source === 'env' ? 'env' : resolved.source === 'path' ? 'path' : 'bundled',
        version: resolved.version,
      };
    },
  },
  {
    id: 'typescript-language-server',
    languages: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'],
    binaries: ['typescript-language-server'],
    args: ['--stdio'],
    install: 'npm install -g typescript-language-server typescript',
    rootMarkers: [],
    needsWarmup: false,
    /*
    | بدون این، سرور با «Could not find tsserver» می‌میرد — با یک
    | probe در فاز طراحی دیده شد.
    */
    initializationOptions: { hostInfo: 'semantic-engine' },
    note: 'needs initializationOptions.tsserver.path in some setups',
  },
  {
    id: 'pyright',
    languages: ['python'],
    binaries: ['pyright-langserver'],
    args: ['--stdio'],
    install: 'npm install -g pyright',
    rootMarkers: [],
    needsWarmup: false,
    note: 'memory hungry on large projects',
  },
  {
    id: 'gopls',
    languages: ['go'],
    binaries: ['gopls'],
    args: ['serve'],
    install: 'go install golang.org/x/tools/gopls@latest',
    rootMarkers: ['go.mod', 'go.work'],
    needsWarmup: true,
  },
  {
    id: 'rust-analyzer',
    languages: ['rust'],
    binaries: ['rust-analyzer'],
    args: [],
    install: 'rustup component add rust-analyzer',
    rootMarkers: ['Cargo.toml'],
    needsWarmup: true,
    note: 'warmup can take minutes and several GB',
  },
  {
    id: 'clangd',
    languages: ['c', 'cpp'],
    binaries: ['clangd'],
    args: [],
    install: 'apt install clangd   (or: brew install llvm)',
    rootMarkers: ['compile_commands.json', 'compile_flags.txt'],
    needsWarmup: true,
  },
  {
    id: 'intelephense',
    languages: ['php'],
    binaries: ['intelephense'],
    args: ['--stdio'],
    install: 'npm install -g intelephense',
    rootMarkers: [],
    needsWarmup: false,
  },
  {
    id: 'solargraph',
    languages: ['ruby'],
    binaries: ['solargraph'],
    args: ['stdio'],
    install: 'gem install solargraph',
    rootMarkers: [],
    needsWarmup: false,
  },
  {
    id: 'jdtls',
    languages: ['java'],
    binaries: ['jdtls'],
    args: [],
    install: 'download from https://github.com/eclipse-jdtls/eclipse.jdt.ls/releases',
    rootMarkers: ['pom.xml', 'build.gradle', 'build.gradle.kts', '.classpath'],
    needsWarmup: true,
    note: 'setup is involved; a data directory is usually required',
  },
];

/** چرا یک سرور به کار نیامد — برای `doctor`. */
export interface ServerDetection {
  readonly id: string;
  readonly languages: readonly string[];
  readonly resolved: ResolvedLspServer | null;
  /** آیا نشانه‌های ریشه هم می‌خوانند؟ */
  readonly suitable: boolean;
  readonly reason: string;
  readonly install: string;
}

export interface RegistryOptions extends ResolveOptions {
  readonly specs?: readonly LspServerSpec[];
}

export class LspServerRegistry {
  private readonly specs: readonly LspServerSpec[];

  constructor(private readonly options: RegistryOptions = {}) {
    this.specs = options.specs ?? DEFAULT_LSP_SERVERS;
  }

  all(): readonly LspServerSpec[] {
    return this.specs;
  }

  /** سرورهای مربوط به یک زبان، به‌ترتیب جدول. */
  forLanguage(languageId: string): readonly LspServerSpec[] {
    const normalized = languageId.toLowerCase();
    return this.specs.filter(spec => spec.languages.includes(normalized));
  }

  /**
   * اولین سروری که هم برای این زبان است، هم به این ریشه می‌خورد، و
   * هم واقعاً روی این ماشین پیدا می‌شود.
   *
   * `null` یعنی «سروری نیست» — نه خطا.
   */
  resolveForLanguage(languageId: string, root: string): ResolvedLspServer | null {
    for (const spec of this.forLanguage(languageId)) {
      if (!this.isSuitable(spec, root)) continue;
      const resolved = this.resolveSpec(spec);
      if (resolved) return resolved;
    }
    return null;
  }

  /** آیا نشانه‌های ریشه می‌خوانند؟ خالی یعنی بله. */
  isSuitable(spec: LspServerSpec, root: string): boolean {
    if (spec.rootMarkers.length === 0) return true;
    const exists = this.options.exists ?? ((candidate: string) => fs.existsSync(candidate));
    return spec.rootMarkers.some(marker => exists(path.join(root, marker)));
  }

  /** فقط پیدا کردن باینری — بدون نگاه به ریشه. */
  resolveSpec(spec: LspServerSpec): ResolvedLspServer | null {
    const override = this.options.overrides?.[spec.id];
    if (override?.disabled) return null;

    if (override?.command) {
      /*
      | مسیر صریح از پیکربندی، حتی اگر روی PATH نباشد. کسی که این
      | را نوشته می‌داند چه می‌خواهد — ولی وجودش سنجیده می‌شود،
      | وگرنه خطایی که می‌بیند ENOENT وسط spawn است.
      */
      const exists = this.options.exists ?? ((candidate: string) => fs.existsSync(candidate));
      const isPathLike = override.command.includes('/') || override.command.includes('\\');
      if (isPathLike && !exists(override.command)) return null;
      return {
        id: spec.id,
        command: override.command,
        args: override.args ?? spec.args,
        source: 'config',
      };
    }

    if (spec.resolveCommand) {
      const resolved = spec.resolveCommand({
        env: this.options.env,
        exists: this.options.exists,
        overrides: this.options.overrides,
      });
      if (resolved) return this.applyArgsOverride(resolved, override);
      return null;
    }

    const found = this.findOnPath(spec.binaries);
    if (!found) return null;
    return this.applyArgsOverride({ id: spec.id, command: found, args: spec.args, source: 'path' }, override);
  }

  /**
   * SE-F-027 — an args-only override (no `command`) is a documented,
   * normalized shape (`ServerOverride` keeps args independent of command),
   * but the old code consumed `override.args` only inside the
   * `override.command` branch. A configured `{ args: [...] }` without a
   * command was silently dropped at resolution — the user waited to learn
   * their settings did nothing. The override now applies on every path
   * that produced a server, without changing which server was picked.
   */
  private applyArgsOverride(
    resolved: ResolvedLspServer,
    override: { args?: readonly string[] } | undefined
  ): ResolvedLspServer {
    if (override?.args && Array.isArray(override.args)) {
      return { ...resolved, args: [...override.args] };
    }
    return resolved;
  }

  /**
   * وضعیت همهٔ سرورها برای `doctor`.
   *
   * ترتیب جدول حفظ می‌شود تا خروجی `doctor` بین اجراها ثابت بماند.
   */
  detectAll(root: string): ServerDetection[] {
    return this.specs.map(spec => {
      const suitable = this.isSuitable(spec, root);
      const resolved = this.resolveSpec(spec);
      return {
        id: spec.id,
        languages: spec.languages,
        resolved,
        suitable,
        reason: describeReason(spec, resolved, suitable),
        install: spec.install,
      };
    });
  }

  private findOnPath(binaries: readonly string[]): string | null {
    const env = this.options.env ?? process.env;
    const exists = this.options.exists ?? ((candidate: string) => fs.existsSync(candidate));
    const raw = env.PATH ?? env.Path ?? '';
    if (!raw) return null;

    /*
    | روی ویندوز، `foo` روی دیسک `foo.exe` یا `foo.cmd` است. این
    | مسیر روی این ماشین آزمون نمی‌شود و همین‌جا نوشته می‌شود که
    | ادعای پشتیبانی‌اش، ادعای آزمون‌نشده است.
    */
    const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];

    for (const dir of raw.split(path.delimiter)) {
      if (!dir) continue;
      for (const binary of binaries) {
        for (const suffix of suffixes) {
          const candidate = path.join(dir, `${binary}${suffix}`);
          if (exists(candidate)) return candidate;
        }
      }
    }
    return null;
  }
}

function describeReason(
  spec: LspServerSpec,
  resolved: ResolvedLspServer | null,
  suitable: boolean
): string {
  if (resolved && suitable) {
    return `${resolved.command}${resolved.version ? ` (${resolved.version})` : ''}`;
  }
  if (resolved && !suitable) {
    return `found, but this project has none of: ${spec.rootMarkers.join(', ')}`;
  }
  if (spec.id === 'typescript') return describeMissingTypeScriptLsp().split('\n')[0];
  return `not installed — ${spec.install}`;
}

/** پیام کاملی که `doctor` و لاگ‌ها برای یک زبان بی‌سرور نشان می‌دهند. */
export function describeMissingServers(
  registry: LspServerRegistry,
  languageId: string
): string {
  const candidates = registry.forLanguage(languageId);
  if (candidates.length === 0) {
    return `No language server is known for "${languageId}". Extraction falls back to tree-sitter or heuristics.`;
  }
  const lines = [
    `No language server found for "${languageId}". Install one of:`,
    ...candidates.map(spec => `  ${spec.install}`),
    'Nothing is installed automatically. The engine keeps working without it.',
  ];
  return lines.join('\n');
}
