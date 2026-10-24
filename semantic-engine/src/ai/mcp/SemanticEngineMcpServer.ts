/**
 * SemanticEngineMcpServer — MCP server با استفاده از SDK رسمی @modelcontextprotocol/sdk.
 *
 * Transport: stdio (default) یا SSE (future).
 * قابلیت‌ها:
 * - tools/list
 * - tools/call
 *
 * برای استفاده در CLI:
 *   node dist/ai/mcp/SemanticEngineMcpServer.js <path-to-project-index.json>
 */

import * as fs from 'fs';
import * as path from 'path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  CallToolResult,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ProjectIndexReader } from '../ProjectIndexReader';
import { AiToolRegistry } from '../AiToolRegistry';
import type { BlueprintIndex } from '../discovery/BlueprintIndex';
import { AiToolInput } from '../tools/types';
import { ProjectIndex } from '../../core/types/project-index.types';
import { resolveProjectIndexPath } from '../../core/config/ProjectPaths';
import { parseIndexGeneration } from '../../core/config/indexGeneration';
import { MANIFEST_FILE_NAME, readCommittedIndexBytes } from '../../core/config/artifactManifest';
import { loadBlueprintBeside } from '../discovery/loadBlueprint';

export interface McpServerOptions {
  readonly projectIndex: ProjectIndex;
  readonly workspaceRoot?: string;
  /**
   * شناسهٔ پروژه و مسیر ایندکس، برای `structuredContent` پاسخ‌ها (فاز ۷).
   * `indexPath` همان‌جایی است که manifest کنارش نوشته می‌شود.
   */
  readonly projectId?: string;
  readonly indexPath?: string;
  /**
   * blueprint، اگر کنار project-index پیدا شد.
   *
   * SE-BP-06 — تا فاز ۴۳ blueprint نوشته می‌شد و هرگز خوانده
   * نمی‌شد. حالا `discover_context` از آن به‌عنوان منبع دومِ دانه
   * استفاده می‌کند.
   */
  readonly blueprint?: BlueprintIndex;
  /**
   * Phase 2 transactional edits stay disabled unless the host explicitly
   * opts in. This is the MCP-side switch for `AiToolRegistryOptions`
   * (`enablePhase2Edits` + `phase2JournalDirectory`); without it the edit
   * tools are registered but fail closed with DISABLED.
   */
  readonly enablePhase2Edits?: boolean;
  readonly phase2JournalDirectory?: string;
  /**
   * Experimental Phase 3/4 capabilities. Only the named capabilities are
   * registered (`semantic-graph`, `controlled-expansion`); anything else
   * stays unlisted. Absent by default.
   */
  readonly experimental?: Readonly<Record<string, boolean>>;
}

export class SemanticEngineMcpServer {
  private readonly server: Server;
  private registry: AiToolRegistry;
  private readonly workspaceRoot?: string;
  private transport?: StdioServerTransport;
  private indexWatcher?: fs.FSWatcher;
  private reloadTimer?: NodeJS.Timeout;
  private watchedIndexPath?: string;
  private readonly projectId?: string;
  private indexPath?: string;
  private generation: number = 0;
  private readonly enablePhase2Edits?: boolean;
  private readonly phase2JournalDirectory?: string;
  private readonly experimental?: Readonly<Record<string, boolean>>;

  constructor(options: McpServerOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.projectId = options.projectId;
    this.indexPath = options.indexPath;
    this.enablePhase2Edits = options.enablePhase2Edits;
    this.phase2JournalDirectory = options.phase2JournalDirectory;
    this.experimental = options.experimental;
    this.registry = this.createRegistry(options.projectIndex, options.blueprint);
    if (options.indexPath) this.refreshGeneration(options.indexPath);

    this.server = new Server(
      {
        name: 'semantic-engine',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.registerHandlers();
  }

  private createRegistry(projectIndex: ProjectIndex, blueprint?: BlueprintIndex): AiToolRegistry {
    const reader = new ProjectIndexReader(projectIndex);
    return new AiToolRegistry({
      reader,
      workspaceRoot: this.workspaceRoot,
      projectHash: projectIndex.generatedAt,
      enableCache: true,
      ...(blueprint ? { blueprint } : {}),
      ...(this.enablePhase2Edits === true ? { enablePhase2Edits: true as const } : {}),
      ...(this.phase2JournalDirectory !== undefined ? { phase2JournalDirectory: this.phase2JournalDirectory } : {}),
      ...(this.experimental !== undefined ? { experimental: this.experimental } : {}),
    });
  }

  /**
   * تعویض snapshot داخل سرور بدون قطع transport.
   */
  reload(projectIndex: ProjectIndex, blueprint?: BlueprintIndex): void {
    this.registry = this.createRegistry(projectIndex, blueprint);
    /* ایندکس عوض شده، پس generation هم باید دوباره خوانده شود. */
    if (this.indexPath) this.refreshGeneration(this.indexPath);
  }

  /**
   * دنبال‌کردن آرتیفکت‌های watch شده. نوشتن OutputWriter اتمیک است و
   * ممکن است ابتدا rename فایل موقت و سپس تغییر فایل نهایی را گزارش
   * کند؛ debounce کوتاه اجازه می‌دهد هر دو رویداد یک reload شوند.
   */
  watchIndexFile(indexPath = resolveProjectIndexPath(this.workspaceRoot ?? process.cwd())): void {
    const absoluteIndexPath = path.resolve(indexPath);
    this.indexPath = absoluteIndexPath;
    this.refreshGeneration(absoluteIndexPath);
    if (this.indexWatcher || !fs.existsSync(path.dirname(absoluteIndexPath))) return;

    this.watchedIndexPath = absoluteIndexPath;
    const directory = path.dirname(absoluteIndexPath);
    const indexName = path.basename(absoluteIndexPath);

    try {
      this.indexWatcher = fs.watch(directory, (event, filename) => {
        const changed = filename ? String(filename) : '';
        if (!changed || changed === indexName || changed === 'blueprint.json' || changed === 'project-artifacts.manifest.json') {
          this.scheduleReload();
        }
      });
      this.indexWatcher.on('error', () => {
        /* شکست watcher نباید transport MCP را از کار بیندازد. */
      });
    } catch {
      this.indexWatcher = undefined;
    }
  }

  private scheduleReload(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined;
      this.reloadFromDisk();
    }, 75);
    this.reloadTimer.unref?.();
  }

  /**
   * خواندن `indexGeneration` از manifest کنار ایندکس. نبودِ manifest یعنی
   * ایندکسِ پیش از فاز ۷، که `0` می‌گیرد و مصرف‌کننده را به رفتار قبلی
   * (بدون کش) برمی‌گرداند.
   */
  private refreshGeneration(indexPath: string): void {
    try {
      const manifestPath = path.join(path.dirname(indexPath), MANIFEST_FILE_NAME);
      this.generation = parseIndexGeneration(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
    } catch {
      this.generation = 0;
    }
  }

  /** generation فعلی؛ برای تست و برای `/internal/status`. */
  get indexGeneration(): number {
    return this.generation;
  }

  private reloadFromDisk(): void {
    const indexPath = this.watchedIndexPath;
    if (!indexPath || !fs.existsSync(indexPath)) return;

    try {
      /*
      | fail-closed روی جفتِ artifact: انتشارِ index و manifest دو فایلِ
      | مستقل است و crash میان آن‌ها indexِ جدید را کنار manifestِ قدیمی
      | می‌گذارد. پیش از این، JSON معتبرِ ناسازگار بدون هیچ علامتی serve
      | می‌شد؛ حالا تا سازگارشدن digest، آخرین snapshot سالم فعال می‌ماند
      | و reload بعدی دوباره تلاش می‌کند.
      */
      const indexBytes = readCommittedIndexBytes(indexPath);
      const projectIndex = JSON.parse(indexBytes.toString('utf8')) as ProjectIndex;
      this.refreshGeneration(indexPath);
      const loaded = loadBlueprintBeside(indexPath);
      this.reload(projectIndex, loaded.index ?? undefined);
    } catch {
      /* هنگام تعویض اتمیک فایل ممکن است snapshot موقتاً ناقص باشد. */
      this.scheduleReload();
    }
  }

  private registerHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools: Tool[] = this.registry.list().map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Tool['inputSchema'],
      }));
      return { tools };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async request =>
      this.callTool(request.params.name, (request.params.arguments ?? {}) as AiToolInput)
    );
  }

  /**
   * ساخت پاسخ `tools/call`.
   *
   * `content` دقیقاً همان متن قبلی است؛ `structuredContent` افزودهٔ فاز ۷ است
   * و همان خروجی ابزار را به‌علاوهٔ `projectId` و `indexGeneration` می‌برد.
   * مصرف‌کننده‌ای که `structuredContent` را unpack می‌کند
   * (`structured-ai/agent/mcp/protocol/JsonRpcCodec.js`) همان آبجکت را
   * می‌بیند و `trackGeneration` روی همان `indexGeneration` کار می‌کند؛ بقیهٔ
   * کلاینت‌ها متن قبلی را.
   */
  async callTool(toolName: string, args: AiToolInput): Promise<CallToolResult> {
    try {
      const result = await this.registry.executeWithValidation(toolName, args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: {
          ...result,
          ...(this.projectId !== undefined ? { projectId: this.projectId } : {}),
          indexGeneration: this.generation,
        },
        isError: !result.success,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = { success: false, error: message, items: [] };
      return {
        content: [{ type: 'text', text: JSON.stringify(failed) }],
        structuredContent: {
          ...failed,
          ...(this.projectId !== undefined ? { projectId: this.projectId } : {}),
          indexGeneration: this.generation,
        },
        isError: true,
      };
    }
  }

  /**
   * شروع server روی stdio.
   */
  async start(): Promise<void> {
    this.transport = new StdioServerTransport();
    await this.server.connect(this.transport);
  }

  /**
   * اتصال server به یک transport سفارشی (مثل HTTP/SSE).
   */
  async connectTransport(transport: Transport): Promise<void> {
    this.transport = transport as StdioServerTransport;
    await this.server.connect(transport);
  }

  async close(): Promise<void> {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = undefined;
    }
    this.indexWatcher?.close();
    this.indexWatcher = undefined;
    await this.server.close();
  }
}
