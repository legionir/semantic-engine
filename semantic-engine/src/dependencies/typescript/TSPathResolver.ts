/**
 * Resolve کردن مسیر import های local با استفاده از tsconfig paths و resolution استاندارد Node.
 *
 * این resolver فرض می‌کند که فایل‌ها از ریشه‌ی workspace relative هستند.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

interface TsConfigInfo {
  readonly baseUrl?: string;
  readonly paths?: Record<string, string[]>;
}

export class TSPathResolver {
  private readonly cache = new Map<string, TsConfigInfo | null>();
  /** مسیر ماژول → فایل موجود (یا `null` اگر هیچ‌کدام). SE-DEP-05. */
  private readonly fileCache = new Map<string, string | null>();
  /**
   * شمار پرسش‌های واقعی از دیسک.
   *
   * وجودش برای این است که ادعای «کش کار می‌کند» *سنجیدنی* باشد. بدون
   * یک عدد، تنها راه اثبات، جاسوسی روی `fs` است که به پیاده‌سازی
   * می‌چسبد و روی نسخه‌های Node که `existsSync` را غیرقابل‌پیکربندی
   * می‌کنند اصلاً کار نمی‌کند.
   */
  private diskProbes = 0;

  constructor(private readonly workspaceRoot: string) {}

  /**
   * Resolve یک مسیر import به مسیر relative نهایی.
   *
   * @param importPath - مسیر import (مثل '../repository/user' یا '@app/utils')
   * @param importerPath - مسیر relative فایل import کننده
   * @returns مسیر relative resolved یا null
   */
  resolve(importPath: string, importerPath: string): string | null {
    if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
      // مسیر نسبی نیست — ممکن است tsconfig path باشد
      return this.resolveTsConfigPath(importPath, importerPath);
    }

    const importerDir = path.dirname(importerPath);
    const resolved = path.resolve(this.workspaceRoot, importerDir, importPath);
    return this.findExistingFile(resolved);
  }

  /** آمار برای سنجش کش — SE-DEP-05. */
  stats(): { diskProbes: number; cachedPaths: number } {
    return { diskProbes: this.diskProbes, cachedPaths: this.fileCache.size };
  }

  /**
   * Resolve با پشتیبانی از fileId lookup.
   */
  resolveToRelativePath(importPath: string, importerPath: string): string | null {
    return this.resolve(importPath, importerPath);
  }

  private resolveTsConfigPath(importPath: string, importerPath: string): string | null {
    const tsConfig = this.loadNearestTsConfig(importerPath);
    if (!tsConfig) return null;

    /*
    | `baseUrl` پس از دنبال کردن `extends` مطلق است — چون نسبت به
    | فایلی معنی دارد که *اعلامش کرده*، نه نسبت به ریشهٔ کارگاه.
    */
    const baseDir = tsConfig.baseUrl
      ? path.resolve(this.workspaceRoot, tsConfig.baseUrl)
      : this.workspaceRoot;

    for (const [pattern, targets] of Object.entries(tsConfig.paths ?? {})) {
      const regex = this.patternToRegex(pattern);
      const match = importPath.match(regex);
      if (!match) continue;

      for (const target of targets) {
        const substituted = this.substituteTarget(target, match);
        const existing = this.findExistingFile(path.resolve(baseDir, substituted));
        if (existing) return existing;
      }
    }

    /*
    | `baseUrl` به‌تنهایی هم مسیر غیرنسبی را حل می‌کند — همان رفتار
    | خود TypeScript. نسخهٔ قبلی بدون `paths` زودهنگام `null`
    | برمی‌گرداند، پس پیکربندی‌های فقط-baseUrl هیچ‌وقت resolve
    | نمی‌شدند.
    */
    if (tsConfig.baseUrl) {
      const existing = this.findExistingFile(path.resolve(baseDir, importPath));
      if (existing) return existing;
    }

    return null;
  }

  private loadNearestTsConfig(filePath: string): TsConfigInfo | null {
    const dir = path.dirname(path.resolve(this.workspaceRoot, filePath));
    let currentDir = dir;

    while (currentDir.startsWith(this.workspaceRoot) || currentDir === this.workspaceRoot) {
      const cached = this.cache.get(currentDir);
      if (cached !== undefined) return cached;

      const tsConfigPath = path.join(currentDir, 'tsconfig.json');
      if (fs.existsSync(tsConfigPath)) {
        try {
          const compilerOptions = this.readCompilerOptions(tsConfigPath, new Set<string>());
          const info: TsConfigInfo = {
            baseUrl: compilerOptions.baseUrl,
            paths: compilerOptions.paths,
          };
          this.cache.set(currentDir, info);
          return info;
        } catch {
          this.cache.set(currentDir, null);
          return null;
        }
      }

      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) break;
      currentDir = parentDir;
    }

    this.cache.set(dir, null);
    return null;
  }

  /**
   * `compilerOptions` با دنبال کردن زنجیرهٔ `extends`.
   *
   * SE-DEP-04 — `ts.readConfigFile` فقط فایل را می‌خواند و `extends`
   * را resolve نمی‌کند. در چیدمان رایج monorepo که `paths` در
   * `tsconfig.base.json` است، تنظیمات مؤثر خالی درمی‌آمد و **همهٔ
   * aliasها گم می‌شدند**.
   *
   * `baseUrl` نسبت به فایلی که آن را *اعلام کرده* معنی دارد، پس هنگام
   * بالا رفتن از زنجیره به مسیر مطلق تبدیل می‌شود.
   */
  private readCompilerOptions(
    configPath: string,
    visited: Set<string>
  ): { baseUrl?: string; paths?: Record<string, string[]> } {
    const resolved = path.resolve(configPath);

    /*
    | `extends` حلقوی روی monorepoهای واقعی اتفاق می‌افتد. بدون این
    | نگهبان، حل مسیر در حلقهٔ بی‌نهایت می‌رود.
    */
    if (visited.has(resolved)) return {};
    visited.add(resolved);

    const config = ts.readConfigFile(resolved, ts.sys.readFile).config;
    if (!config) return {};

    const own = config.compilerOptions ?? {};
    const ownBaseUrl = own.baseUrl
      ? path.resolve(path.dirname(resolved), own.baseUrl)
      : undefined;

    if (!config.extends) {
      return { baseUrl: ownBaseUrl, paths: own.paths };
    }

    const parents = Array.isArray(config.extends) ? config.extends : [config.extends];
    let inherited: { baseUrl?: string; paths?: Record<string, string[]> } = {};

    for (const parent of parents) {
      const parentPath = this.resolveExtends(String(parent), path.dirname(resolved));
      if (!parentPath) continue;
      const fromParent = this.readCompilerOptions(parentPath, visited);
      inherited = {
        baseUrl: fromParent.baseUrl ?? inherited.baseUrl,
        paths: fromParent.paths ?? inherited.paths,
      };
    }

    // تنظیمات فرزند بر والد اولویت دارد — همان قاعدهٔ خود TypeScript
    return {
      baseUrl: ownBaseUrl ?? inherited.baseUrl,
      paths: own.paths ?? inherited.paths,
    };
  }

  private resolveExtends(specifier: string, fromDir: string): string | null {
    const candidates = specifier.startsWith('.')
      ? [path.resolve(fromDir, specifier), path.resolve(fromDir, `${specifier}.json`)]
      : [
        path.resolve(fromDir, 'node_modules', specifier),
        path.resolve(fromDir, 'node_modules', `${specifier}.json`),
        path.resolve(fromDir, 'node_modules', specifier, 'tsconfig.json'),
      ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && !fs.statSync(candidate).isDirectory()) return candidate;
    }
    return null;
  }

  private patternToRegex(pattern: string): RegExp {
    // مثال: @app/* → ^@app/(.*)$
    const escaped = pattern
      .replace(/\*/g, '(.*)')
      .replace(/\//g, '\\/');
    return new RegExp(`^${escaped}$`);
  }

  private substituteTarget(target: string, match: RegExpMatchArray): string {
    let result = target;
    for (let i = 1; i < match.length; i++) {
      result = result.replace('*', match[i]!);
    }
    return result;
  }

  /**
   * اولین شکل موجودِ یک مسیر ماژول.
   *
   * SE-DEP-05: دو مشکل داشت. اول اینکه پسوندهای واقعی امروز
   * (`.mjs`, `.cjs`, `.mts`, `.cts`, `.d.ts`, `index.mjs`) در فهرست
   * نبودند. دوم اینکه هر بار تا ۹ جفت `existsSync` + `statSync` می‌زد
   * بدون هیچ کشی — و روی مخزنی با هزاران import، همان مسیرها بارها
   * پرسیده می‌شوند.
   *
   * ترتیب فهرست مهم است: پیاده‌سازی واقعی پیش از فایل اعلان می‌آید،
   * وگرنه `thing.d.ts` به‌جای `thing.ts` برنده می‌شود.
   */
  private findExistingFile(resolvedPath: string): string | null {
    const cached = this.fileCache.get(resolvedPath);
    if (cached !== undefined) return cached;

    const candidates = [
      resolvedPath,
      `${resolvedPath}.ts`,
      `${resolvedPath}.tsx`,
      `${resolvedPath}.mts`,
      `${resolvedPath}.cts`,
      `${resolvedPath}.js`,
      `${resolvedPath}.jsx`,
      `${resolvedPath}.mjs`,
      `${resolvedPath}.cjs`,
      `${resolvedPath}.d.ts`,
      path.join(resolvedPath, 'index.ts'),
      path.join(resolvedPath, 'index.tsx'),
      path.join(resolvedPath, 'index.mts'),
      path.join(resolvedPath, 'index.cts'),
      path.join(resolvedPath, 'index.js'),
      path.join(resolvedPath, 'index.jsx'),
      path.join(resolvedPath, 'index.mjs'),
      path.join(resolvedPath, 'index.cjs'),
      path.join(resolvedPath, 'index.d.ts'),
    ];

    for (const candidate of candidates) {
      this.diskProbes++;
      if (fs.existsSync(candidate) && !fs.statSync(candidate).isDirectory()) {
        const answer = normalizePath(path.relative(this.workspaceRoot, candidate));
        this.fileCache.set(resolvedPath, answer);
        return answer;
      }
    }

    // پاسخ منفی هم کش می‌شود؛ وگرنه هر import ناموفق هر بار ۱۹ بار می‌پرسد.
    this.fileCache.set(resolvedPath, null);
    return null;
  }
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}
