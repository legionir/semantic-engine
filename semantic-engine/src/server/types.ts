/**
 * Platform Core V1 — Server Types & Route Contracts.
 */

import type { ArtifactLocation } from '../core/config/DataRootResolver';
import * as http from 'http';
import { AuthContext, PermissionScope } from '../security/rbac/types';
import type { EdgeBasis } from '../graphs/EdgeProvenance';

export interface HttpRequestContext {
  readonly req: http.IncomingMessage;
  readonly res: http.ServerResponse;
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string>;
  readonly params: Record<string, string>;
  readonly body?: unknown;
  readonly token?: string;
  readonly authenticated: boolean;
  readonly auth: AuthContext;
}

export type RouteHandler = (context: HttpRequestContext) => Promise<void | HttpResponseData>;

export interface HttpResponseData {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly json?: unknown;
  readonly text?: string;
}

export interface RouteDefinition {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';
  readonly pattern: string; // e.g. '/api/v1/projects/:id/symbols/:symbolId'
  readonly handler: RouteHandler;
  /**
   * آیا این مسیر توکن می‌خواهد؟
   *
   * ── چرا حالا پیش‌فرضش `true` است ─────────────────────────────────
   *
   * قبلاً این فیلد opt-in بود: هر مسیری که یادش می‌رفت بنویسدش، باز
   * می‌ماند. شمرده شد: ۲۵ مسیر در ۷ فایل بدون احراز هویت بودند —
   * از جمله `/api/v1/fs/browse` که کل فایل‌سیستم ماشین را لیست
   * می‌کرد، و `/api/v1/providers/models` که به هر URL دلخواه درخواست
   * می‌زد.
   *
   * فراموش کردن یک فیلد نباید به «بدون احراز هویت» ترجمه شود، پس
   * حالا نبودنش یعنی `true` و باز گذاشتن یک مسیر باید صریح باشد.
   */
  readonly requireAuth?: boolean;
  /** Permission required after authentication. Omitted routes use a conservative method default. */
  readonly permission?: PermissionScope;
  readonly schema?: object;
}

export interface PlatformConfig {
  readonly port: number;
  readonly host: string;
  readonly token?: string;
  readonly allowRemote?: boolean;
  readonly maxBodyBytes?: number;
  readonly projectsRoot?: string;
  /** شناسهٔ artifact پروژهٔ اصلی (`--project-id`)؛ بدون آن از ریشه ساخته می‌شود. */
  readonly projectId?: string;
  readonly staticDir?: string;
  /**
   * data root برای registry دائمی پروژه‌ها (`registry.json` و manifest هر
   * پروژه). وقتی داده نشود، registry فقط در حافظه نگه داشته می‌شود و چیزی
   * روی دیسک نوشته نمی‌شود — که برای تست‌ها رفتار درست است.
   */
  readonly dataRoot?: string;
  /**
   * کجا artifact نوشته/خوانده شود: `in-root` (پیش‌فرض فعلی) یا `external`.
   * از `SEMANTIC_ENGINE_ARTIFACT_LOCATION` توسط CLI پر می‌شود.
   */
  readonly artifactLocation?: ArtifactLocation;
  /**
   * Worker پشت Gateway (فاز ۶): هیچ سطح بدون توکن ندارد، روت‌های registry
   * بسته‌اند، و هیچ `path`/`rootPath` از request پذیرفته نمی‌شود.
   */
  readonly gatewayManaged?: boolean;
  /**
   * به proxy بودن Gateway اعتماد شود: `Origin` قضاوت نمی‌شود (Gateway آن را
   * حذف می‌کند) ولی نبودِ `X-Forwarded-*` نشانهٔ درخواست مستقیم است و رد
   * می‌شود. پیش‌فرض، همان `gatewayManaged` است.
   */
  readonly trustedGateway?: boolean;
  /** مسیر Unix socket؛ وقتی ست باشد سرور روی socket گوش می‌دهد نه TCP. */
  readonly socketPath?: string;
  /**
   * F-0021 — مدل embedding پیکربندی‌شده که واقعاً در این پروسه استفاده
   * می‌شود. `/config` دیگر یک مقدارِ ثابتِ حدسی (`Qwen3-Embedding-0.6B`) را
   * گزارش نمی‌کند؛ یا مدل واقعی از caller (CLI/worker که embedding را resolve
   * می‌کنند) اینجا ریخته می‌شود، یا `null` می‌ماند و صادقانه «ناشناخته»
   * گزارش می‌شود. نبودش هیچ‌وقت مجوز اختراع یک مدل نیست.
   */
  readonly embeddingModel?: string | null;
  /**
   * هندلر رویداد `upgrade` برای WebSocket (فاز ۱۱). بدون آن هر upgrade رد
   * می‌شود، چون handshake نیمه‌انجام‌شده از نبودِ WebSocket بدتر است:
   * کلاینت منتظر `101` می‌ماند.
   */
  readonly upgradeHandler?: (
    req: http.IncomingMessage,
    socket: import('stream').Duplex,
    head: Buffer
  ) => void;
}

// ── Graph View Model Types ───────────────────────────────────────────────

export type NodeType =
  | 'project'
  | 'module'
  | 'file'
  | 'class'
  | 'function'
  | 'method'
  | 'interface'
  | 'struct'
  | 'trait'
  | 'api'
  | 'workflow'
  | 'business_entity';

export interface GraphNode {
  readonly id: string;
  readonly type: NodeType;
  readonly label: string;
  readonly parentId?: string;
  readonly metadata: {
    readonly path?: string;
    readonly line?: number;
    readonly endLine?: number;
    readonly language?: string;
    readonly role?: string;
    readonly complexity?: number;
    readonly importance?: number;
    readonly referencesCount?: number;
    readonly isEntryPoint?: boolean;
  };
}

export type EdgeRelation =
  | 'contains'
  | 'imports'
  | 'calls'
  | 'references'
  | 'extends'
  | 'implements'
  | 'depends_on'
  | 'uses'
  | 'executes';

export interface GraphEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly relation: EdgeRelation;
  readonly metadata: {
    readonly confidence: number;
    /*
    | واژگانِ basis باید همان واژگانِ canonical لایهٔ گراف باشد
    | (EdgeBasis در EdgeProvenance.ts) — پیش از این یک زیرمجموعهٔ
    | کهنه نگه داشته می‌شد و یال‌های واقعیِ pipeline با
    | basis:'import-resolved' همین‌جا بی‌صدا کنار گذاشته می‌شدند.
    | 'transitive'/'blueprint' برای سازگاری و 'index' برای یال‌های
    | لایه‌بندی‌شده (LayeredGraph) باقی‌اند.
    */
    readonly basis: EdgeBasis | 'transitive' | 'blueprint' | 'index';
    readonly sourceKind: 'compiler' | 'tree-sitter' | 'heuristic' | 'inferred';
    readonly line?: number;
  };
}

export type VisualizationState = 'ready' | 'empty' | 'failed' | 'unavailable';

export interface SubgraphResponse {
  readonly level: 'architecture' | 'module' | 'file' | 'symbol' | 'neighborhood' | 'workflow';
  readonly state?: VisualizationState;
  readonly reason?: string;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly summary: {
    readonly totalNodes: number;
    readonly totalEdges: number;
    readonly confidentRatio: number;
  };
}

export interface IndexJobStatus {
  readonly jobId: string;
  readonly projectId: string;
  readonly status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  readonly phase: string;
  readonly progress: number;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly error?: string;
  readonly result?: unknown;
}
