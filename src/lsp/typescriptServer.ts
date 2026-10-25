/**
 * پیدا کردن زبان‌سرور TypeScript — LSP-01.
 *
 * ── چرا این فایل جداست ─────────────────────────────────────────────
 *
 * پکیج به `typescript@~5.9.3` وابسته است و از API کامپایلرش برای
 * پیچیدگی، وابستگی‌ها و گراف فراخوانی استفاده می‌کند. وسوسه‌ای که
 * `LSP-ARCHITECTURE.md` هم دربارهٔ آن هشدار می‌دهد این است که همان
 * وابستگی را زبان‌سرور هم بحساب بیاوریم. نتیجه‌اش را اندازه گرفتیم:
 *
 * ```
 * $ node node_modules/typescript/bin/tsc --lsp --stdio
 * error TS5023: Unknown compiler option '--lsp'.
 * error TS5023: Unknown compiler option '--stdio'.
 * ```
 *
 * و این دو خط روی **stdout** می‌آیند — یعنی همان کانالی که کلاینت
 * LSP انتظار قاب `Content-Length` دارد. خطایی که مصرف‌کننده می‌بیند
 * «نسخهٔ TypeScript شما زبان‌سرور ندارد» نیست؛ یک خطای عجیب تجزیهٔ
 * پروتکل است. پس نسخه **پیش از** spawn سنجیده می‌شود، نه بعدش.
 *
 * زبان‌سرور در `typescript@7` (بازنویسی Go) آمده و با نام
 * `@typescript/native-preview` هم منتشر می‌شود (باینری `tsgo`).
 *
 * ── سیاست ──────────────────────────────────────────────────────────
 *
 * هیچ‌وقت خودکار نصب نمی‌کنیم. فقط تشخیص می‌دهیم و اگر نبود،
 * `describeMissingTypeScriptLsp()` دستور نصب را می‌دهد تا `doctor`
 * (فاز ۳۶) نشانش دهد. نصب خودکار در یک ابزار CLI هم غافلگیرکننده است
 * هم ریسک امنیتی.
 *
 * این یک رجیستری کامل نیست — آن LSP-04 در فاز ۳۶ است. اینجا فقط
 * همان یک سروری است که بدون نصب اضافه در دسترس است.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

/** از کجا پیدایش کردیم — برای `doctor` و لاگ. */
export type TypeScriptLspSource =
  | 'env'
  | 'native-preview'
  | 'typescript-package'
  | 'path';

export interface TypeScriptLspCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly source: TypeScriptLspSource;
  /** رشته‌ای که خود باینری گزارش کرده است. */
  readonly version?: string;
}

export interface ResolveTypeScriptLspOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** ریشه‌ای که ماژول‌ها از آن resolve می‌شوند. پیش‌فرض: همین پکیج. */
  readonly resolveFrom?: string;
  /** برای تست: به‌جای اجرای واقعی باینری. */
  readonly probeVersion?: (command: string) => string | null;
  /** برای تست: به‌جای `fs.existsSync`. */
  readonly exists?: (candidate: string) => boolean;
}

/** مسیر باینری را صریح می‌کند و همهٔ کشف خودکار را کنار می‌گذارد. */
export const TS_LSP_ENV_VAR = 'SEMANTIC_ENGINE_TS_LSP';

/** کمترین major که `--lsp` دارد. */
export const MINIMUM_TYPESCRIPT_LSP_MAJOR = 7;

const LSP_ARGS = ['--lsp', '--stdio'] as const;

/**
 * نسخه را از خروجی `--version` بیرون می‌کشد.
 *
 * `tsc` می‌گوید `Version 5.9.3` و `tsgo` می‌گوید
 * `Version 7.0.0-dev.20260707.2`. هر دو با همین یک الگو خوانده
 * می‌شوند.
 */
export function parseVersion(output: string | null | undefined): string | null {
  if (!output) return null;
  const match = /(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/.exec(output);
  return match ? match[0] : null;
}

export function majorOf(version: string | null): number | null {
  if (!version) return null;
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  return Number.isFinite(major) ? major : null;
}

export function supportsLsp(version: string | null): boolean {
  const major = majorOf(version);
  return major !== null && major >= MINIMUM_TYPESCRIPT_LSP_MAJOR;
}

function defaultProbeVersion(command: string): string | null {
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return null;
  return parseVersion(`${result.stdout ?? ''}${result.stderr ?? ''}`);
}

/**
 * باینری بومی داخل `@typescript/native-preview`.
 *
 * پکیج اصلی فقط یک shim است (`bin/tsgo` که ESM است و
 * `lib/tsgo.js` را import می‌کند)؛ باینری واقعی در پکیج مخصوص
 * سکو می‌نشیند. مستقیم اجرا کردن باینری، یک راه‌اندازی Node را
 * صرفه‌جویی می‌کند — که برای سروری که در ۸ms بالا می‌آید، بی‌اهمیت
 * نیست.
 *
 * منطقش عمداً بازنویسی شده و از `typescript/lib/getExePath.js`
 * استفاده نمی‌کند: آن فایل ESM است (`import.meta.url`) و از
 * CommonJS قابل `require` نیست.
 */
function nativePreviewCandidates(resolveFrom: string): string[] {
  const platformPackage = `@typescript/native-preview-${process.platform}-${process.arch}`;
  const binName = process.platform === 'win32' ? 'tsgo.exe' : 'tsgo';
  const candidates: string[] = [];

  for (const spec of [`${platformPackage}/package.json`, '@typescript/native-preview/package.json']) {
    try {
      const manifest = require.resolve(spec, { paths: [resolveFrom] });
      const root = path.dirname(manifest);
      candidates.push(path.join(root, 'lib', binName));
      candidates.push(path.join(root, 'bin', 'tsgo'));
      // خواهرِ سکو، کنار پکیج اصلی
      candidates.push(path.join(root, '..', `native-preview-${process.platform}-${process.arch}`, 'lib', binName));
    } catch {
      // نصب نیست — گزینهٔ بعدی.
    }
  }
  return candidates;
}

function typescriptPackageCandidate(resolveFrom: string): string | null {
  try {
    const manifest = require.resolve('typescript/package.json', { paths: [resolveFrom] });
    const root = path.dirname(manifest);
    const binName = process.platform === 'win32' ? 'tsc.exe' : 'tsc';
    /*
    | فقط باینری بومی نسخهٔ ۷ به درد می‌خورد. `bin/tsc` نسخهٔ ۵ یک
    | اسکریپت Node است که `--lsp` را نمی‌شناسد و خطایش را روی
    | stdout می‌ریزد.
    */
    const platformPackage = path.join(
      root,
      '..',
      `typescript-${process.platform}-${process.arch}`,
      'lib',
      binName
    );
    return platformPackage;
  } catch {
    return null;
  }
}

function fromPath(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATH ?? env.Path ?? '';
  if (!raw) return [];
  const names = process.platform === 'win32' ? ['tsgo.exe', 'tsc.exe'] : ['tsgo', 'tsc'];
  const found: string[] = [];
  for (const dir of raw.split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) found.push(path.join(dir, name));
  }
  return found;
}

/**
 * اولین باینری‌ای که هم وجود دارد و هم نسخه‌اش `--lsp` دارد.
 *
 * `null` یعنی «سروری نیست» — نه خطا. مصرف‌کننده باید با tree-sitter
 * ادامه بدهد (تنزل تمیز)، نه اینکه بایستد.
 */
export function resolveTypeScriptLspCommand(
  options: ResolveTypeScriptLspOptions = {}
): TypeScriptLspCommand | null {
  const env = options.env ?? process.env;
  const resolveFrom = options.resolveFrom ?? __dirname;
  const exists = options.exists ?? ((candidate: string) => fs.existsSync(candidate));
  const probe = options.probeVersion ?? defaultProbeVersion;

  const attempt = (
    candidate: string | null,
    source: TypeScriptLspSource
  ): TypeScriptLspCommand | null => {
    if (!candidate || !exists(candidate)) return null;
    const version = probe(candidate);
    if (!supportsLsp(version)) return null;
    return { command: candidate, args: [...LSP_ARGS], source, version: version ?? undefined };
  };

  const explicit = env[TS_LSP_ENV_VAR];
  if (explicit) {
    /*
    | مسیر صریح، حتی اگر نسخه‌اش را نتوانیم بخوانیم، احترام دارد:
    | کسی که این متغیر را ست می‌کند می‌داند چه می‌خواهد (مثلاً یک
    | سرور wrapper). فقط وجودش سنجیده می‌شود.
    */
    if (!exists(explicit)) return null;
    const version = probe(explicit);
    return {
      command: explicit,
      args: [...LSP_ARGS],
      source: 'env',
      version: version ?? undefined,
    };
  }

  for (const candidate of nativePreviewCandidates(resolveFrom)) {
    const resolved = attempt(candidate, 'native-preview');
    if (resolved) return resolved;
  }

  const fromTypeScript = attempt(typescriptPackageCandidate(resolveFrom), 'typescript-package');
  if (fromTypeScript) return fromTypeScript;

  for (const candidate of fromPath(env)) {
    const resolved = attempt(candidate, 'path');
    if (resolved) return resolved;
  }

  return null;
}

/** پیامی که `doctor` نشان می‌دهد وقتی سروری پیدا نشد. */
export function describeMissingTypeScriptLsp(): string {
  return [
    'No TypeScript language server was found.',
    `The bundled typescript@5 compiler does not provide one (\`--lsp\` was added in typescript@${MINIMUM_TYPESCRIPT_LSP_MAJOR}).`,
    'Install one of:',
    '  npm install --save-dev @typescript/native-preview   # provides `tsgo`',
    '  npm install --save-dev typescript@next              # provides `tsc --lsp`',
    `Or point ${TS_LSP_ENV_VAR} at an existing binary.`,
  ].join('\n');
}
