/**
 * BlueprintExporter — نوشتن blueprint.json روی دیسک.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ProjectIndex } from '../core/types/project-index.types';
import { Blueprint } from '../core/types/blueprint.types';
import { BlueprintGenerator, BlueprintGeneratorOptions } from '../blueprint/BlueprintGenerator';
import { writeJsonAtomic } from './schemaValidation';

export interface BlueprintExportOptions {
  readonly outputPath: string;
  readonly pretty?: boolean;
  /** Validate against the repository blueprint schema before writing. */
  readonly validate?: boolean;
  readonly generatorOptions?: BlueprintGeneratorOptions;
}

/**
 * خوانندهٔ سورس برای استخراج `apiMap` — SE-BP-02.
 *
 * blueprint پس از پایان pipeline ساخته می‌شود، جایی که نگاشتِ محتوا
 * دیگر زنده نیست (SE-EXT-09). ثبتِ مسیر هم در project-index نیست: نه
 * symbol است نه dependency. پس فایل‌های نامزد از دیسک خوانده می‌شوند.
 *
 * سه محافظ تا این کار به یک پیمایشِ کاملِ مخزن تبدیل نشود:
 * فقط JS/TS، فقط فایلِ کوچک‌تر از سقف، و شکستِ خواندن بی‌صدا رد
 * می‌شود (فایل ممکن است بین ایندکس و اینجا حذف شده باشد).
 */
const MAX_SOURCE_BYTES = 512 * 1024;

function diskSourceReader(rootPath: string | undefined) {
  if (!rootPath) return undefined;

  return (file: { path: string; size: number; language: string | null }): string | undefined => {
    if (!/\.(m|c)?[jt]sx?$/.test(file.path)) return undefined;
    if (file.size > MAX_SOURCE_BYTES) return undefined;
    try {
      return fs.readFileSync(path.join(rootPath, file.path), 'utf8');
    } catch {
      return undefined;
    }
  };
}

export class BlueprintExporter {
  async export(
    projectIndex: ProjectIndex,
    options: BlueprintExportOptions
  ): Promise<void> {
    const generator = new BlueprintGenerator(
      this.withSourceReader(projectIndex, options.generatorOptions)
    );
    const blueprint = generator.generate(projectIndex);
    await writeJsonAtomic({
      outputPath: options.outputPath,
      value: blueprint,
      schema: 'blueprint',
      validate: options.validate !== false,
      pretty: options.pretty,
    });
  }

  /**
   * blueprint به‌همراه نگاشتِ فایل به ماژول — SE-DATA-04.
   *
   * فراخوان به این نگاشت نیاز دارد تا `FileEntry.blueprintRef` را پر
   * کند، و آن نگاشت فقط حین ساختِ blueprint وجود دارد.
   */
  buildWithRefs(
    projectIndex: ProjectIndex,
    options?: BlueprintGeneratorOptions
  ): { blueprint: Blueprint; moduleRefs: ReadonlyMap<string, string> } {
    const generator = new BlueprintGenerator(this.withSourceReader(projectIndex, options));
    const blueprint = generator.generate(projectIndex);
    return { blueprint, moduleRefs: generator.moduleRefs() };
  }

  /** نوشتنِ یک blueprintِ از پیش ساخته‌شده. */
  async write(
    blueprint: Blueprint,
    options: { outputPath: string; pretty?: boolean; validate?: boolean }
  ): Promise<void> {
    await writeJsonAtomic({
      outputPath: options.outputPath,
      value: blueprint,
      schema: 'blueprint',
      validate: options.validate !== false,
      pretty: options.pretty,
    });
  }

  buildBlueprint(projectIndex: ProjectIndex, options?: BlueprintGeneratorOptions): Blueprint {
    const generator = new BlueprintGenerator(this.withSourceReader(projectIndex, options));
    return generator.generate(projectIndex);
  }

  private withSourceReader(
    projectIndex: ProjectIndex,
    options?: BlueprintGeneratorOptions
  ): BlueprintGeneratorOptions {
    if (options?.sourceOf) return options;
    const reader = diskSourceReader(projectIndex.rootPath);
    return reader ? { ...(options ?? {}), sourceOf: reader } : (options ?? {});
  }
}
