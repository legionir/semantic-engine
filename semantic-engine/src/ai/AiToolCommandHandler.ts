/**
 * AiToolCommandHandler — اجرای ابزارهای AI روی یک ایندکس موجود.
 *
 * قبلاً یک handler برای commandهای VS Code بود: خطا را با
 * `showErrorMessage` نشان می‌داد و نتیجه را در یک `OutputChannel`
 * می‌ریخت. حالا نتیجه را *برمی‌گرداند* و لاگ را به لاگر می‌دهد؛ نمایش
 * دادن، کار فراخوان است. تنظیمات هم از `Config` میزبان می‌آید، نه از
 * `vscode.workspace.getConfiguration`.
 */

import * as fs from 'fs';
import { ProjectIndexReader } from './ProjectIndexReader';
import { AiToolRegistry } from './AiToolRegistry';
import { AiToolInput } from './tools/types';
import { VectorStoreOptions } from '../vector/VectorStore';
import { ILogger, defaultLogger } from '../host/Logger';
import { Config } from '../host/Config';
import { normalizeWorkspaceRoot, resolveProjectIndexPath } from '../core/config/ProjectPaths';

export interface AiToolCommandHandlerOptions {
  readonly logger?: ILogger;
  /** اگر داده نشود، از env و فایل پیکربندی خوانده می‌شود. */
  readonly config?: Config;
}

export class AiToolCommandHandler {
  private registry: AiToolRegistry | null = null;
  private readonly logger: ILogger;

  private readonly workspaceRoot: string;

  constructor(
    workspaceRoot: string,
    private readonly options: AiToolCommandHandlerOptions = {}
  ) {
    this.workspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
    this.logger = options.logger ?? defaultLogger;
  }

  private loadedStamp: string | undefined;
  private loads = 0;

  /** چند بار ایندکس واقعاً از دیسک خوانده شد. برای اثباتِ «کش کار می‌کند». */
  get indexLoadCount(): number {
    return this.loads;
  }

  /**
   * امضای ارزانِ کهنگی: زمان تغییر و اندازه.
   *
   * دقتِ نانوثانیه (`bigint: true`) استفاده می‌شود چون
   * `mtimeMs` روی دو نوشتنِ پشت‌سرهم در یک میلی‌ثانیه یکسان
   * می‌ماند — و ایندکسِ عوض‌شده با اندازهٔ یکسان، همان حالتی است که
   * اگر از قلم بیفتد دوباره SE-AI-02 می‌شود.
   *
   * هش کردنِ محتوا قطعی‌تر بود ولی یعنی خواندنِ کلِ فایل در هر
   * فراخوانی — همان هزینه‌ای که این کش برای حذفش هست.
   */
  private stampOf(indexPath: string): string | undefined {
    try {
      const stat = fs.statSync(indexPath, { bigint: true });
      return `${stat.mtimeNs}:${stat.size}`;
    } catch {
      return undefined;
    }
  }

  async executeTool(name: string, input: AiToolInput): Promise<unknown> {
    await this.ensureRegistry();
    if (!this.registry) {
      const error = 'Index not found';
      this.logger.error('semantic engine index not found', { workspaceRoot: this.workspaceRoot });
      return { success: false, error, items: [] };
    }

    const result = await this.registry.executeWithValidation(name, input);
    this.logger.debug('ai tool executed', { tool: name, input });

    return result;
  }

  async listTools(): Promise<{ name: string; description: string }[]> {
    await this.ensureRegistry();
    return this.registry?.list().map(t => ({ name: t.name, description: t.description })) ?? [];
  }

  /**
   * SE-AI-02 — رجیستری وقتی ایندکس عوض شود، دوباره ساخته می‌شود.
   *
   * قبلاً `if (this.registry) return;` بود، یعنی پس از اولین
   * بارگذاری تا پایان عمر پروسه همان ایندکس سرو می‌شد. روی یک
   * ویرایشگر که همیشه باز است، مدل روی تصویری از کد کار می‌کرد که
   * ساعت‌ها پیش گرفته شده بود.
   *
   * تشخیص کهنگی از `mtime` و اندازهٔ فایل می‌آید — نه از خواندن و
   * هش کردنِ کلِ فایل، که خودش همان هزینه‌ای است که کش قرار بود
   * حذفش کند.
   */
  private async ensureRegistry(): Promise<void> {
    const indexPath = resolveProjectIndexPath(this.workspaceRoot);

    if (!fs.existsSync(indexPath)) {
      // ایندکس حذف شده؛ نتیجهٔ کهنه هم نباید سرو شود.
      this.registry = null;
      this.loadedStamp = undefined;
      return;
    }

    const stamp = this.stampOf(indexPath);
    if (this.registry && stamp !== undefined && stamp === this.loadedStamp) return;

    try {
      const content = await fs.promises.readFile(indexPath, 'utf8');
      const projectIndex = JSON.parse(content);
      const reader = new ProjectIndexReader(projectIndex);
      const config = this.options.config
        ?? Config.load({ env: process.env, cwd: this.workspaceRoot });

      const vectorStoreOptions: VectorStoreOptions = {
        backend: config.get<'auto' | 'brute-force' | 'usearch'>('vectorSearch.backend'),
        usearchThreshold: config.get<number>('vectorSearch.usearchThreshold'),
      };

      this.registry = new AiToolRegistry({
        reader,
        workspaceRoot: this.workspaceRoot,
        vectorStoreOptions,
        projectHash: projectIndex.generatedAt,
      });
      this.loadedStamp = stamp;
      this.loads++;
    } catch (error) {
      this.logger.error('failed to load project index for AI tools', { cause: error });
    }
  }
}
