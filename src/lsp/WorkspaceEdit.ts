/**
 * اعمال `WorkspaceEdit` — نوشتن روی فایل‌های کاربر.
 *
 * این خطرناک‌ترین کد کل زیرسیستم LSP است: هرچیز دیگری *می‌خواند*، این
 * یکی **می‌نویسد**. پس سه قاعده بر همه‌چیز مقدم است:
 *
 * ۱. **هیچ نوشتنی بیرون از ریشهٔ workspace.** یک سرور مخرب — یا فقط
 *    یک سرور با پیکربندی عجیب — می‌تواند در `WorkspaceEdit` مسیری
 *    مثل `file:///etc/passwd` یا `../../.ssh/config` بگذارد. همان
 *    خانوادهٔ SE-SEC-01 است که فاز ۰۴ برای `GitClient` بست.
 * ۲. **همه یا هیچ.** اول کل نقشه ساخته می‌شود و اعتبارسنجی، بعد
 *    نوشتن. یک rename نیمه‌اعمال‌شده، کدبیس را در حالتی می‌گذارد که
 *    نه قبل است نه بعد — و کاربر نمی‌داند کدام فایل‌ها عوض شده‌اند.
 * ۳. **ویرایش‌ها از آخر به اول.** هر ویرایش با موقعیتِ *متن اصلی*
 *    بیان شده است. اگر از اول شروع کنیم، اولین درج، همهٔ موقعیت‌های
 *    بعدی را می‌لغزاند.
 *
 * ── چرا خودمان و نه `workspace/applyEdit` ──────────────────────────
 *
 * آن پیام برای وقتی است که سرور بخواهد ویرایشگر را وادار به تغییر
 * کند؛ ما ویرایشگر نیستیم و از فاز ۳۲ صریحاً `{applied:false}`
 * جواب می‌دهیم. اینجا جهت برعکس است: *ما* خواسته‌ایم، پس *ما* اعمال
 * می‌کنیم.
 */

import * as fs from 'fs';
import * as path from 'path';
import { RangeLike } from '../symbols/types';
import { pathOf } from './LspClient';
import { NodeFileSystem } from '../host/FileSystem';

export interface TextEditLike {
  readonly range: RangeLike;
  readonly newText: string;
}

export interface TextDocumentEditLike {
  readonly textDocument: { readonly uri: string; readonly version?: number | null };
  readonly edits: readonly TextEditLike[];
}

export interface WorkspaceEditLike {
  readonly changes?: Record<string, readonly TextEditLike[]>;
  readonly documentChanges?: readonly (TextDocumentEditLike | { readonly kind: string })[];
}

export interface PlannedFileEdit {
  /** مسیر مطلق روی دیسک. */
  readonly path: string;
  /** همان مسیر، نسبت به ریشه — چیزی که به مدل نشان داده می‌شود. */
  readonly relativePath: string;
  readonly editCount: number;
  readonly before: string;
  readonly after: string;
}

export interface WorkspaceEditPlan {
  readonly files: readonly PlannedFileEdit[];
  readonly totalEdits: number;
}

export interface PlanOptions {
  readonly rootPath: string;
  /** برای تست و برای متنی که هنوز روی دیسک نیست. */
  readonly readFile?: (filePath: string) => string;
}

/**
 * نقطه‌های تزریقِ `applyEditPlan`.
 *
 * وجودشان دو چیز است: تستِ قطعیِ «خرابی وسط نوشتن» (بدون این، تزریقِ
 * خطا فقط با monkey-patch کردن `fs` ممکن بود) و این‌که نوشتنِ اتمیکِ
 * خودِ مخزن (`host/FileSystem`) از بیرون قابل جایگزینی بماند.
 */
export interface ApplyEditOptions {
  readonly writeAtomic?: (filePath: string, content: string) => Promise<void>;
  readonly readCurrent?: (filePath: string) => Promise<string>;
}

export class WorkspaceEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceEditError';
  }
}

/*
| نوشتنِ اتمیکِ پیش‌فرض: همان `writeFileAtomic` خودِ مخزن — temp + fsync +
| rename، با پاک‌سازیِ temp وقتی rename می‌شکند. یک نمونه برای همهٔ
| نوشتن‌ها ساخته می‌شود؛ گران نیست و حالتی نگه نمی‌دارد.
*/
let fileSystemPort: NodeFileSystem | undefined;

async function defaultAtomicWrite(filePath: string, content: string): Promise<void> {
  fileSystemPort ??= new NodeFileSystem();
  await fileSystemPort.writeFileAtomic(filePath, content);
}

/**
 * نقشه‌ای از آنچه قرار است نوشته شود — بدون نوشتن.
 *
 * همین تابع، هم مسیر `dry_run` است و هم مرحلهٔ اول مسیر واقعی. یعنی
 * چیزی که در `dry_run` دیده می‌شود، دقیقاً همان چیزی است که اعمال
 * می‌شود؛ نه یک تخمینِ جداگانه که می‌تواند واگرا شود.
 */
export function planWorkspaceEdit(
  edit: WorkspaceEditLike | null | undefined,
  options: PlanOptions
): WorkspaceEditPlan {
  const read = options.readFile ?? ((filePath: string) => fs.readFileSync(filePath, 'utf8'));
  const root = path.resolve(options.rootPath);
  const byUri = collectEdits(edit);

  const files: PlannedFileEdit[] = [];
  let totalEdits = 0;

  for (const [uri, edits] of byUri) {
    const filePath = resolveInsideRoot(uri, root);
    const before = read(filePath);
    const after = applyTextEdits(before, edits);
    files.push({
      path: filePath,
      relativePath: path.relative(root, filePath) || path.basename(filePath),
      editCount: edits.length,
      before,
      after,
    });
    totalEdits += edits.length;
  }

  // ترتیب قطعی: خروجی نباید به ترتیب کلیدهای یک شیء JSON وابسته باشد.
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { files, totalEdits };
}

/** نوشتن نقشه روی دیسک. فقط فایل‌هایی که واقعاً عوض شده‌اند. */
export async function applyEditPlan(
  plan: WorkspaceEditPlan,
  options: ApplyEditOptions = {}
): Promise<readonly string[]> {
  const writer = options.writeAtomic ?? defaultAtomicWrite;
  const read = options.readCurrent ?? ((filePath: string) => fs.promises.readFile(filePath, 'utf8'));
  const toWrite = plan.files.filter(file => file.before !== file.after);
  if (toWrite.length === 0) return [];

  /*
  | F-0025 — قاعدهٔ ۲ همین فایل («همه یا هیچ») تا این فاز فقط برای
  | *ساخت* نقشه اجرا می‌شد، نه برای *نوشتن*: نوشتن ترتیبی بود و
  | هیچ بازگشتی نداشت. یک خطای I/O روی فایل دوم، rename را وسط راه
  | ول می‌کرد — نه قبل، نه بعد — و کاربر نمی‌دانست کدام فایل عوض شده.
  |
  | دو کار قبل از هر نوشتن:
  |   ۱) نگهبانِ تازگی: اگر محتوای دیسک با همان چیزی که نقشه از آن
  |      ساخته شده فرق کند، اصلاً چیزی نوشته نمی‌شود (وگرنه ویرایشِ
  |      بقیهٔ فایل‌ها روی متنی می‌نشیند که آن‌بین تغییر کرده).
  |   ۲) هر نوشتن اتمیک است (temp + rename، همان `writeFileAtomic`
  |      خود مخزن)، پس crash وسط نوشتن فایلی را نصفه نمی‌گذارد.
  |
  | اگر باز هم نوشتنی شکست، فایل‌های نوشته‌شده با `before` خودِ نقشه
  | برمی‌گردند — snapshotِ رایگان و از پیش درست.
  */
  for (const file of toWrite) {
    let current: string | null = null;
    try {
      current = await read(file.path);
    } catch (error) {
      if (file.before === '' && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new WorkspaceEditError(
        `cannot read ${file.relativePath} before applying the edit: ` +
          (error instanceof Error ? error.message : String(error))
      );
    }
    if (current !== file.before) {
      throw new WorkspaceEditError(
        `${file.relativePath} changed on disk after it was planned; nothing was written`
      );
    }
  }

  const applied: PlannedFileEdit[] = [];
  try {
    for (const file of toWrite) {
      await writer(file.path, file.after);
      applied.push(file);
    }
  } catch (error) {
    /*
    | بازگشت به ترتیبِ برعکسِ نوشتن، و «تلاشِ حداکثری»: اگر برگرداندنِ
    | یک فایل هم شکست بخورد، نباید خطای اصلی را بپوشاند — آن فایل در
    | پیامِ خطا نام برده می‌شود تا کاربر بداند کجا نیمه‌مانده است.
    */
    const unrestored: string[] = [];
    for (const file of [...applied].reverse()) {
      try {
        await writer(file.path, file.before);
      } catch {
        unrestored.push(file.relativePath);
      }
    }
    const suffix = unrestored.length > 0
      ? `; could not restore: ${unrestored.join(', ')}`
      : '; earlier files were restored';
    throw new WorkspaceEditError(
      `applying the edit failed: ${error instanceof Error ? error.message : String(error)}${suffix}`
    );
  }

  return toWrite.map(file => file.relativePath);
}

/**
 * اعمال ویرایش‌های یک فایل.
 *
 * ویرایش‌ها به آفست تبدیل می‌شوند و بعد **از آخر به اول** اعمال — و
 * پیش از آن، هم‌پوشانی رد می‌شود. طبق پروتکل، ویرایش‌های یک سند
 * نباید هم‌پوشانی داشته باشند؛ اگر داشته باشند نتیجه به ترتیب اعمال
 * بستگی پیدا می‌کند، یعنی خروجی غیرقطعی روی کد کاربر.
 */
export function applyTextEdits(text: string, edits: readonly TextEditLike[]): string {
  if (edits.length === 0) return text;

  const starts = lineStarts(text);
  const resolved = edits.map(edit => ({
    start: offsetOf(edit.range.start, starts, text.length),
    end: offsetOf(edit.range.end, starts, text.length),
    newText: edit.newText,
  }));

  for (const item of resolved) {
    if (item.end < item.start) {
      throw new WorkspaceEditError(
        `edit range ends before it starts (${item.start}…${item.end})`
      );
    }
  }

  const ordered = [...resolved].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let index = 1; index < ordered.length; index++) {
    if (ordered[index].start < ordered[index - 1].end) {
      throw new WorkspaceEditError(
        `overlapping edits at offsets ${ordered[index - 1].start}…${ordered[index - 1].end} ` +
          `and ${ordered[index].start}…${ordered[index].end}`
      );
    }
  }

  let out = text;
  for (let index = ordered.length - 1; index >= 0; index--) {
    const item = ordered[index];
    out = out.slice(0, item.start) + item.newText + out.slice(item.end);
  }
  return out;
}

// ── درون ──────────────────────────────────────────────────────────────

function collectEdits(
  edit: WorkspaceEditLike | null | undefined
): Map<string, readonly TextEditLike[]> {
  const byUri = new Map<string, TextEditLike[]>();
  if (!edit) return byUri;

  const add = (uri: string, edits: readonly TextEditLike[]): void => {
    const existing = byUri.get(uri);
    if (existing) existing.push(...edits);
    else byUri.set(uri, [...edits]);
  };

  for (const [uri, edits] of Object.entries(edit.changes ?? {})) add(uri, edits);

  for (const change of edit.documentChanges ?? []) {
    /*
    | `documentChanges` می‌تواند ساخت/حذف/تغییرنامِ فایل هم باشد.
    | پیاده نکردنشان یک تصمیم است: rename و organizeImports هیچ‌کدام
    | لازمشان ندارند، و نادیده گرفتن بی‌صدای یک «فایل را پاک کن»
    | بدترین حالت ممکن است.
    */
    if ('kind' in change) {
      throw new WorkspaceEditError(
        `workspace edit asks for a "${change.kind}" file operation, which is not supported`
      );
    }
    add(change.textDocument.uri, change.edits);
  }

  return byUri;
}

/**
 * URI → مسیر، با اطمینان از اینکه داخل ریشه است.
 *
 * `path.relative` تنها سنجهٔ قابل اتکاست: مقایسهٔ رشته‌ای با پیشوند،
 * `root-sibling/` را هم داخل `root` می‌بیند.
 */
export function resolveInsideRoot(uri: string, rootPath: string): string {
  if (!uri.startsWith('file:')) {
    throw new WorkspaceEditError(`refusing a non-file URI: ${uri}`);
  }

  let filePath: string;
  try {
    filePath = path.resolve(pathOf(uri));
  } catch (error) {
    throw new WorkspaceEditError(`could not read the URI ${uri}: ${(error as Error).message}`);
  }

  const root = path.resolve(rootPath);
  const relative = path.relative(root, filePath);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new WorkspaceEditError(
      `refusing to edit ${filePath}: it is outside the workspace root ${root}`
    );
  }
  return filePath;
}

/** آفست شروع هر خط. `\r\n` و `\r` تنها هم خط‌شکن‌اند. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '\n') {
      starts.push(index + 1);
    } else if (char === '\r') {
      if (text[index + 1] === '\n') index++;
      starts.push(index + 1);
    }
  }
  return starts;
}

/**
 * موقعیت LSP → آفست رشته.
 *
 * `character` در واحد UTF-16 است (سرور `positionEncoding: "utf-16"`
 * اعلام کرد) و رشتهٔ جاوااسکریپت هم همان است، پس جمع مستقیم درست
 * است — برای ایموجی هم، که در هر دو دو واحد است.
 *
 * موقعیت بیرون از متن به مرز نزدیک بریده می‌شود: سرورها برای «انتهای
 * فایل» گاهی خطی می‌دهند که وجود ندارد.
 */
function offsetOf(
  position: { line: number; character: number },
  starts: readonly number[],
  length: number
): number {
  if (position.line < 0) return 0;
  if (position.line >= starts.length) return length;
  return Math.min(starts[position.line] + Math.max(0, position.character), length);
}
