/**
 * Import-specifier -> project-file resolution for languages whose imports are
 * module/package paths rather than TS-style relative paths (Python, Go, Rust,
 * Java, Kotlin, C/C++, Ruby, PHP). Pure functions over the scanned file list.
 */

import { FileEntry } from '../core/types/project-index.types';

/**
 * زبان‌هایی که importشان مسیرِ ماژول/بسته است، نه مسیر فایلِ TS (`./x`)، و
 * لذا نمی‌توانند با TSPathResolver resolve شوند؛ هر کدام resolverِ خودشان را
 * دارند. اگر importشان به فایلِ داخل‌پروژه بخورد، محلی شمرده می‌شود.
 */
export const PROJECT_PATH_LANGUAGES: ReadonlySet<string> = new Set([
  'python', 'go', 'rust', 'java', 'kotlin', 'cpp', 'c', 'ruby', 'php',
]);

/** نگاشت import به فایلِ پروژه بر اساس زبان (TS/JS از TSPathResolver می‌روند). */
export function resolveProjectImport(
  language: string,
  spec: string,
  fromFile: string,
  files: readonly FileEntry[]
): FileEntry | undefined {
  switch (language) {
    case 'python': return resolvePythonImport(spec, fromFile, files);
    case 'go': return resolveGoImport(spec, files);
    case 'rust': return resolveRustImport(spec, fromFile, files);
    case 'java': return resolveJavaImport(spec, files);
    case 'kotlin': return resolveKotlinImport(spec, files);
    case 'cpp':
    case 'c': return resolveCxxImport(spec, fromFile, files);
    case 'ruby': return resolveRubyRelativeImport(spec, fromFile, files);
    case 'php': return resolvePhpRequire(spec, fromFile, files);
    default: return undefined;
  }
}

/**
 * PEP-328 — resolve یک import پایتون به فایلِ پروژه.
 *
 * - نسبی (نقطه‌ها): `.` = بستهٔ فعلی؛ هر نقطهٔ اضافه یک سطح بالاتر.
 * - مطلق (`models.user` / `a.b.c`): نقاط به `/` تبدیل و به‌عنوان پسوندِ
 *   مسیرِ فایل تطبیق داده می‌شود؛ `<mod>.py` یا `<mod>/__init__.py`.
 */
export function resolvePythonImport(
  spec: string,
  fromFile: string,
  files: readonly FileEntry[]
): FileEntry | undefined {
  const slashes = (p: string) => p.replace(/\\/g, '/');
  const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const up = (p: string) => dirOf(p);

  const dots = /^\.+/.exec(spec)?.[0].length ?? 0;
  const modulePath = spec.slice(dots).replace(/\./g, '/');

  if (dots === 0) {
    const asFile = modulePath + '.py';
    const asPackage = modulePath + '/__init__.py';
    return files.find(f => {
      const p = slashes(f.path);
      return (
        p === asFile || p === asPackage ||
        p.endsWith('/' + asFile) || p.endsWith('/' + asPackage)
      );
    });
  }

  let base = dirOf(slashes(fromFile));
  for (let i = 1; i < dots; i++) base = up(base);
  const joined = (base ? base + '/' : '') + modulePath;

  return files.find(f => {
    const p = slashes(f.path);
    return p === joined + '.py' || p === joined + '/__init__.py';
  });
}

/**
 * PEP — برای Go: resolve یک import مسیر-ماژولی (`module/pkg`) به فایلِ
 * بستهٔ داخل‌پروژه.
 *
 * در Go یک import به **بسته (پوشه)** اشاره می‌کند، نه یک فایل. پس طولانی‌ترین
 * پوشهٔ واقعیِ `.go`دار را پیدا می‌کنیم که انتهایِ spec است و یک فایلِ نماینده
 * (ترجیحاً `<pkg>/<pkg>.go`، وگرنه اولین فایل) برمی‌گردانیم. پکیج‌های
 * چندقلمی فقط با یک فایل وصل می‌شوند (محدودیتِ مستندِ مدلِ فایل‌به‌فایل).
 */
export function resolveGoImport(
  spec: string,
  files: readonly FileEntry[]
): FileEntry | undefined {
  const slashes = (p: string) => p.replace(/\\/g, '/');
  const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

  const dirs = new Map<string, FileEntry[]>();
  for (const f of files) {
    const p = slashes(f.path);
    if (!p.endsWith('.go')) continue;
    const d = dirOf(p);
    if (!d) continue;
    (dirs.get(d) ?? dirs.set(d, []).get(d)!).push(f);
  }

  let best: string | null = null;
  for (const d of dirs.keys()) {
    if (spec === d || spec.endsWith('/' + d)) {
      if (best === null || d.length > best.length) best = d;
    }
  }
  if (best === null) return undefined;

  const bestDir = best;
  const pkgFiles = (dirs.get(bestDir) ?? []).sort((a, b) => slashes(a.path).localeCompare(slashes(b.path)));
  const pkgName = bestDir.slice(bestDir.lastIndexOf('/') + 1);
  const lead = pkgFiles.find(f => slashes(f.path).slice(bestDir.length + 1).replace(/\.go$/, '') === pkgName);
  return lead ?? pkgFiles[0];
}

/**
 * Rust — resolve `mod NAME;` و `use path::to::Item` به فایلِ ماژول.
 *
 * ماژول‌های Rust روی درختِ `mod` می‌سازند: `mod x;` در فایلِ داخلِ پوشهٔ D
 * یعنی `D/x.rs` یا `D/x/mod.rs`. برای `use` هم زنجیرهٔ مسیر (`a::b`) به همان
 * شکل نگاشت می‌شود و بخشِ آخر می‌تواند نامِ آیتم باشد (نه مسیر)، پس طولانی‌ترین
 * پیشوندی که به فایلِ موجود بخورد برمی‌گردد. هرچه resolve نشود undefined
 * می‌ماند (importِ بیرونی/کریت‌های دیگر) تا حدسِ غلط نسازیم.
 */
export function resolveRustImport(
  spec: string,
  fromFile: string,
  files: readonly FileEntry[]
): FileEntry | undefined {
  const slashes = (p: string) => p.replace(/\\/g, '/');
  const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

  let rest = spec;
  let base = dirOf(slashes(fromFile));
  if (rest.startsWith('crate::')) {
    rest = rest.slice('crate::'.length);
    base = 'src'; // crate root معمولاً src/ است
  } else if (rest.startsWith('self::')) {
    rest = rest.slice('self::'.length);
  } else if (rest.startsWith('super::')) {
    rest = rest.slice('super::'.length);
    base = dirOf(base);
  }

  const segs = rest.split('::').filter(Boolean);
  if (segs.length === 0) return undefined;

  const paths = new Set(files.map(f => slashes(f.path)));
  for (let k = segs.length; k >= 1; k--) {
    const modp = segs.slice(0, k).join('/');
    const stem = base ? `${base}/${modp}` : modp;
    if (paths.has(`${stem}.rs`) || paths.has(`${stem}/mod.rs`)) {
      return files.find(f => {
        const p = slashes(f.path);
        return p === `${stem}.rs` || p === `${stem}/mod.rs`;
      });
    }
  }
  return undefined;
}

/**
 * Java — resolve `import a.b.C;` به فایلِ `<...>/a/b/C.java`.
 *
 * نامِ کلاسِ کامل‌قلم‌دار به مسیرِ فایل نگاشت می‌شود و با **پسوندمatch** پیدا
 * می‌شود تا ریشهٔ سورس (`src/main/java/`) مستقل باشد. `import a.b.*;` یک
 * بسته است → نمایندهٔ آن پوشه. `import static a.b.C.member;` با بلندترین
 * پیشوند به `C.java` می‌رسد. کتابخانهٔ استاندارد/بیرونی (`java.*`،
 * `jakarta.*`، …) هیچ فایلِ پروژه‌ای ندارد → undefined (حدس نمی‌زنیم).
 */
export function resolveJavaImport(
  spec: string,
  files: readonly FileEntry[]
): FileEntry | undefined {
  const slashes = (p: string) => p.replace(/\\/g, '/');
  const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

  if (spec.endsWith('.*')) {
    const dirPath = spec.slice(0, -2).replace(/\./g, '/');
    const inDir = files
      .filter(f => {
        const d = dirOf(slashes(f.path));
        return d === dirPath || d.endsWith('/' + dirPath);
      })
      .sort((a, b) => slashes(a.path).localeCompare(slashes(b.path)));
    return inDir[0];
  }

  const segs = spec.split('.').filter(Boolean);
  for (let k = segs.length; k >= 1; k--) {
    const suffix = segs.slice(0, k).join('/') + '.java';
    const hit = files.find(f => {
      const p = slashes(f.path);
      return p === suffix || p.endsWith('/' + suffix);
    });
    if (hit) return hit;
  }
  return undefined;
}

/** الحاقِ یک مسیرِ نسبی به پوشهٔ مبدأ، با حلِ `.`/`..`. */
function relJoin(dir: string, rel: string): string {
  const segs = (dir ? dir.split('/') : []).concat(rel.split('/'));
  const out: string[] = [];
  for (const s of segs) {
    if (s === '' || s === '.') continue;
    if (s === '..') out.pop();
    else out.push(s);
  }
  return out.join('/');
}

/** اولین نامزدِ مسیری که به فایلِ پروژه بخورد (دقیق یا پسوند). */
function firstExistingFile(candidates: string[], files: readonly FileEntry[]): FileEntry | undefined {
  for (const c of candidates) {
    if (!c) continue;
    const hit = files.find(f => {
      const p = f.path.replace(/\\/g, '/');
      return p === c || p.endsWith('/' + c);
    });
    if (hit) return hit;
  }
  return undefined;
}

/**
 * C/C++ — resolve `#include "x.h"`/`"../a/b.hpp"` (نقلی‌محور = local) به فایل.
 * مسیرِ نسبی به پوشهٔ فایل مبدأ حل می‌شود؛ اگر نشد، با پسوندِ نامِ فایل.
 * `#include <...>` (سیستمی) هرگز به اینجا نمی‌رسد (type builtin).
 */
function resolveCxxImport(spec: string, fromFile: string, files: readonly FileEntry[]): FileEntry | undefined {
  const norm = (p: string) => p.replace(/\\/g, '/');
  const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const rel = norm(spec);
  return firstExistingFile([relJoin(dirOf(norm(fromFile)), rel), rel], files);
}

/** Ruby — resolve `require_relative 'x'` به `x.rb` نسبیِ فایل مبدأ. */
function resolveRubyRelativeImport(spec: string, fromFile: string, files: readonly FileEntry[]): FileEntry | undefined {
  const norm = (p: string) => p.replace(/\\/g, '/');
  const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  let rel = norm(spec);
  if (!rel.endsWith('.rb')) rel += '.rb';
  return firstExistingFile([relJoin(dirOf(norm(fromFile)), rel), rel], files);
}

/** PHP — resolve `require`/`include`ِ نسبیِ مسیر‌دار به فایل `.php`. */
function resolvePhpRequire(spec: string, fromFile: string, files: readonly FileEntry[]): FileEntry | undefined {
  const norm = (p: string) => p.replace(/\\/g, '/');
  const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  let rel = norm(spec);
  if (!/\.[A-Za-z0-9]+$/.test(rel)) rel += '.php';
  return firstExistingFile([relJoin(dirOf(norm(fromFile)), rel), rel], files);
}

/**
 * Kotlin — `import a.b.C` به `a/b/C.kt` (پسوندمatch، ریشهٔ سورس مستقل).
 * اگر کلاسِ top-level در فایلِ هم‌نام نباشد، resolve نمی‌شود (حدس نمی‌زنیم).
 */
function resolveKotlinImport(spec: string, files: readonly FileEntry[]): FileEntry | undefined {
  const norm = (p: string) => p.replace(/\\/g, '/');
  const segs = spec.split('.').filter(Boolean);
  for (let k = segs.length; k >= 1; k--) {
    const suffix = segs.slice(0, k).join('/') + '.kt';
    const hit = files.find(f => {
      const p = norm(f.path);
      return p === suffix || p.endsWith('/' + suffix);
    });
    if (hit) return hit;
  }
  return undefined;
}
