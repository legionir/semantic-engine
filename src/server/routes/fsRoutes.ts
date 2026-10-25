/**
 * fsRoutes — مرور فایل‌سیستم فقط‌خواندنی برای انتخاب مسیر پروژه در UI
 * (SE-UI-04).
 *
 * این یک ابزار محلی است؛ سرور به‌طور پیش‌فرض روی loopback bind می‌شود و
 * پشت token است. با این حال برای جلوگیری از پیمایش‌های ناخواسته، فقط
 * دایرکتوری‌ها را لیست می‌کند و محتوای فایل را برنمی‌گرداند.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RouteDefinition } from '../types';
import { indexPathCandidates } from '../../core/config/ProjectPaths';

interface DirEntry {
  readonly name: string;
  readonly path: string;
  readonly isDirectory: boolean;
  /** آیا این دایرکتوری ظاهراً یک پروژه است (ایندکس موجود یا نشانهٔ VCS/پکیج)؟ */
  readonly hint?: 'indexed' | 'project';
}

/*
| SE-PERF-01 — این تابع برای *هر* زیرپوشه صدا زده می‌شود و تا شش
| `existsSync` پشت سر هم می‌زد. روی یک پوشه با ۲۰۰ زیرپوشه یعنی
| ۱۲۰۰ فراخوان همگام در یک درخواست، که تا آخرینش هیچ درخواست
| دیگری — حتی `/health` — جواب نمی‌گیرد.
|
| حالا همه‌شان ناهمگام و موازی‌اند: نتیجه یکی است و event loop آزاد
| می‌ماند.
*/
async function exists(candidate: string): Promise<boolean> {
  try {
    await fs.promises.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function detectHint(dir: string): Promise<DirEntry['hint']> {
  try {
    const indexed = await Promise.all(indexPathCandidates(dir).map(exists));

    if (indexed.some(Boolean)) return 'indexed';

    const markers = await Promise.all(
      ['.git', 'package.json', 'go.mod', 'Cargo.toml', 'pyproject.toml'].map(marker =>
        exists(path.join(dir, marker))
      )
    );

    if (markers.some(Boolean)) return 'project';
  } catch {
    /* ignore */
  }
  return undefined;
}

export interface FsRoutesOptions {
  /**
   * مرور فقط داخل subtree همان ریشه. در حالت gateway-managed روشن است؛ در
   * حالت standalone خاموش، چون انتخابگر «باز کردن پروژه» در UI عمداً
   * بیرون از ریشه هم مرور می‌کند.
   */
  readonly confineToRoot?: boolean;
}

export function createFsRoutes(
  defaultRoot: string,
  options: FsRoutesOptions = {}
): RouteDefinition[] {
  return [
    {
      method: 'GET',
      pattern: '/api/v1/fs/browse',
      handler: async ctx => {
        const requested = ctx.query.path && ctx.query.path.trim().length > 0 ? ctx.query.path : defaultRoot;
        let target = path.resolve(requested);

        /*
        | SE-SEC-08 — confinement باید پیش از هر تماس با فایل‌سیستم
        | بررسی شود. شکل قبلی اول `stat` می‌زد و در خطای 404 نشانیِ
        | `cwd` و `os.homedir()` را برمی‌گرداند: یعنی یک مسیر بیرونِ
        | workspace که وجود هم نداشت، نامِ کاربر و ریشهٔ سرور را لو
        | می‌داد و هرگز به مرحلهٔ confinement نمی‌رسید. این چک
        | لغت‌شناختی است و فایل نمی‌خواند؛ چکِ `realpath` پایین‌تر هم
        | می‌ماند تا symlinkِ بیرون‌زننده گرفته شود.
        */
        if (options.confineToRoot) {
          const root = path.resolve(defaultRoot);
          if (target !== root && !target.startsWith(root + path.sep)) {
            return {
              status: 403,
              json: { error: 'path is outside this worker\'s workspace root' },
            };
          }
        }

        // اگر مسیر وجود ندارد یا فایل است، به دایرکتوری معتبر عقب برگرد.
        try {
          const stat = await fs.promises.stat(target);
          if (!stat.isDirectory()) target = path.dirname(target);
        } catch {
          return {
            status: 404,
            json: options.confineToRoot
              ? { error: 'path not found' }
              : { error: `path not found: ${target}`, cwd: defaultRoot, home: os.homedir() },
          };
        }

        /*
        | فاز ۶: در حالت managed، worker به یک پروژه bound است. مسیر پس از
        | `realpath` سنجیده می‌شود تا یک symlink نتواند از subtree بیرون بزند.
        */
        if (options.confineToRoot) {
          let realTarget = target;
          let realRoot = defaultRoot;
          try {
            realTarget = fs.realpathSync(target);
            realRoot = fs.realpathSync(defaultRoot);
          } catch {
            return { status: 403, json: { error: `path is not accessible: ${target}` } };
          }

          if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
            return {
              status: 403,
              json: { error: 'path is outside this worker\'s workspace root' },
            };
          }
        }

        let entries: DirEntry[] = [];
        try {
          const dirents = await fs.promises.readdir(target, { withFileTypes: true });
          const visible = dirents.filter(d => !d.name.startsWith('.') || d.isDirectory());

          entries = await Promise.all(
            visible.map(async d => {
              const full = path.join(target, d.name);
              const isDir = d.isDirectory();
              return {
                name: d.name,
                path: full,
                isDirectory: isDir,
                ...(isDir ? { hint: await detectHint(full) } : {}),
              } as DirEntry;
            })
          );

          entries.sort((a, b) => {
            if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
        } catch (error) {
          return { status: 403, json: { error: error instanceof Error ? error.message : String(error) } };
        }

        const parent = path.dirname(target);
        return {
          status: 200,
          json: {
            path: target,
            parent: parent === target ? null : parent,
            home: os.homedir(),
            cwd: defaultRoot,
            selfHint: await detectHint(target),
            entries,
          },
        };
      },
    },
  ];
}
