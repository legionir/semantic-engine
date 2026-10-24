/**
 * نوشتن خروجی‌ها — MIG-22 و SE-EXP-02.
 *
 * مسیر قبلی هر خروجی را دو بار می‌نوشت: یک‌بار `project-index.json`
 * بدون `vectorChunks` و بعد دوباره با آن. هر
 * خواننده‌ای که بین این دو نوشتن سر می‌رسید — سرور MCP،
 * `AiToolCommandHandler`، یا فقط یک `cat` — ایندکسی بدون بردار
 * می‌دید و فرض می‌کرد پروژه بردار ندارد.
 *
 * اینجا هر خروجی دقیقاً یک بار و به‌صورت اتمیک نوشته می‌شود.
 */

import * as path from 'path';
import * as crypto from 'crypto';
import { ProjectIndex } from '../core/types/project-index.types';
import { BlueprintExporter } from '../export/BlueprintExporter';
import { validateAgainstSchema } from '../export/schemaValidation';
import { FileSystemPort, NodeFileSystem } from '../host/FileSystem';
import { ILogger, silentLogger } from '../host/Logger';
import { nextIndexGeneration, parseIndexGeneration } from '../core/config/indexGeneration';
import { MANIFEST_FILE_NAME, preserveCommittedGeneration, pruneGenerations } from '../core/config/artifactManifest';

export interface OutputWriterOptions {
  readonly outputDir: string;
  readonly fileSystem?: FileSystemPort;
  readonly logger?: ILogger;
  readonly pretty?: boolean;
  readonly blueprint?: boolean;
  /**
   * سنجیدن ایندکس با `contracts/project-index.schema.json` پیش از
   * نوشتن — SE-EXP-06.
   *
   * پیش‌فرض: روشن، مگر در production. قرارداد و `ajv` از اول موجود
   * بودند ولی هیچ‌وقت در مسیر نوشتن نبودند، پس نقض قرارداد فقط وقتی
   * دیده می‌شد که کسی دستی اسکریپت اعتبارسنجی را اجرا کند.
   */
  readonly validate?: boolean;
  readonly gitCommit?: string;
  readonly driftScore?: number;
}

export interface WrittenArtifacts {
  readonly indexPath: string;
  readonly blueprintPath: string | null;
}

export const INDEX_FILE_NAME = 'project-index.json';
export const BLUEPRINT_FILE_NAME = 'blueprint.json';
// Canonical name lives in core/config/artifactManifest.ts; re-exported so
// existing pipeline consumers keep their import site.
export { MANIFEST_FILE_NAME };

export class IncoherentArtifactSetError extends Error {
  readonly code = 'INCOHERENT_ARTIFACT_SET';
  constructor(message: string) {
    super(message);
    this.name = 'IncoherentArtifactSetError';
  }
}

/**
 * Fail-closed reader for the legacy two-file layout. A writer interruption can
 * never be silently interpreted as a valid index: the manifest digest is
 * checked before JSON is exposed to a consumer. Callers should use this
 * helper (or the equivalent generation-aware reader) instead of reading the
 * two files independently.
 */
export async function readCoherentArtifactSet(
  outputDir: string,
  fileSystem: FileSystemPort = new NodeFileSystem()
): Promise<ProjectIndex> {
  const manifestPath = path.join(outputDir, MANIFEST_FILE_NAME);
  const indexPath = path.join(outputDir, INDEX_FILE_NAME);
  const manifest = JSON.parse(await fileSystem.readFile(manifestPath)) as {
    artifacts?: { index?: { path?: string; sha256?: string; bytes?: number } | null };
  };
  const expected = manifest.artifacts?.index;
  if (!expected?.sha256 || expected.path !== INDEX_FILE_NAME) {
    throw new IncoherentArtifactSetError('artifact manifest has no canonical index digest');
  }
  const raw = await fileSystem.readFile(indexPath);
  const actual = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
  if (actual !== expected.sha256 || Buffer.byteLength(raw, 'utf8') !== expected.bytes) {
    throw new IncoherentArtifactSetError(
      `manifest does not describe ${INDEX_FILE_NAME}; refusing to expose source-derived data`
    );
  }
  return JSON.parse(raw) as ProjectIndex;
}

export class OutputWriter {
  private readonly fs: FileSystemPort;
  private readonly logger: ILogger;

  constructor(private readonly options: OutputWriterOptions) {
    this.fs = options.fileSystem ?? new NodeFileSystem();
    this.logger = options.logger ?? silentLogger;
  }

  get indexPath(): string {
    return path.join(this.options.outputDir, INDEX_FILE_NAME);
  }

  get blueprintPath(): string {
    return path.join(this.options.outputDir, BLUEPRINT_FILE_NAME);
  }

  async write(index: ProjectIndex): Promise<WrittenArtifacts> {
    /*
    | SE-EXP-06: پیش از هر نوشتنی. یک فایل نامعتبر روی دیسک بدتر از
    | نبودِ فایل است — مصرف‌کننده می‌خواندش و به‌طور نامعلوم شکست
    | می‌خورد، آن هم دور از جایی که خرابی ساخته شد.
    */
    const shouldValidate = this.options.validate ?? process.env['NODE_ENV'] !== 'production';
    if (shouldValidate) {
      const errors = validateAgainstSchema('project-index', index);
      if (errors.length > 0) {
        throw new Error(
          `project-index does not match its schema (${errors.length} violation(s)):\n  ` +
            errors.slice(0, 10).join('\n  ')
        );
      }
      this.logger.debug('index validated against contract');
    }

    await this.fs.mkdirp(this.options.outputDir);
    const pretty = this.options.pretty !== false;

    /*
    | ایندکس *کامل* — با بردارها اگر داشته باشد — یک بار نوشته می‌شود.
    | ترکیب کردنش اینجا اتفاق نمی‌افتد: کار pipeline است که یک مقدار
    | تمام‌شده تحویل بدهد.
    */
    /*
    | SE-DATA-04 — blueprint **پیش از** نوشتنِ ایندکس ساخته می‌شود.
    |
    | `blueprintRef` نگاشتِ فایل به ماژول است و آن نگاشت فقط داخل
    | blueprint وجود دارد. اگر ایندکس اول نوشته شود، این فیلد همیشه
    | خالی می‌ماند — که همان دلیلی است که سال‌ها خالی مانده بود.
    */
    let blueprintPath: string | null = null;
    let indexToWrite = index;

    if (this.options.blueprint !== false) {
      const exporter = new BlueprintExporter();
      const generatorOptions = {
        gitCommit: this.options.gitCommit,
        driftScore: this.options.driftScore,
      };

      const { blueprint, moduleRefs } = exporter.buildWithRefs(index, generatorOptions);
      indexToWrite = {
        ...index,
        files: index.files.map(file => {
          const moduleId = moduleRefs.get(file.id);
          return moduleId ? { ...file, blueprintRef: { moduleId } } : file;
        }),
      };

      await exporter.write(blueprint, { outputPath: this.blueprintPath, pretty });
      blueprintPath = this.blueprintPath;
      this.logger.debug('wrote blueprint', { path: blueprintPath });
    }

    /* D-0014: keep the committed generation readable while the pair is being replaced. */
    preserveCommittedGeneration(this.indexPath);
    await this.fs.writeJsonAtomic(this.indexPath, indexToWrite, { pretty });
    this.logger.debug('wrote index', {
      path: this.indexPath,
      files: indexToWrite.files.length,
    });

    const manifestPath = path.join(this.options.outputDir, MANIFEST_FILE_NAME);
    let previousGeneration = 0;
    try {
      previousGeneration = parseIndexGeneration(JSON.parse(await this.fs.readFile(manifestPath)));
    } catch {
      /* اولین نوشتن، یا manifest ناقص: از صفر شروع می‌شود. */
    }

    const manifest = {
      version: 1,
      generation: crypto.randomUUID(),
      indexGeneration: nextIndexGeneration(previousGeneration),
      committedAt: new Date().toISOString(),
      artifacts: {
        index: await this.artifactDigest(this.indexPath),
        blueprint: blueprintPath ? await this.artifactDigest(this.blueprintPath) : null,
      },
    };
    await this.fs.writeJsonAtomic(manifestPath, manifest, { pretty });
    pruneGenerations(this.indexPath, manifest.artifacts.index.sha256);

    return { indexPath: this.indexPath, blueprintPath };
  }

  private async artifactDigest(filePath: string): Promise<{ path: string; sha256: string; bytes: number }> {
    /* Raw bytes when the port offers them: no 47 MB decode followed by a re-encode just to hash it. */
    const content = this.fs.readBuffer ? await this.fs.readBuffer(filePath) : await this.fs.readFile(filePath);
    return {
      path: path.basename(filePath),
      sha256: crypto.createHash('sha256').update(content).digest('hex'),
      bytes: typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.length,
    };
  }
}
