/**
 * Public contract of `LspClient`: lifecycle state, options, and the error
 * classes callers catch. Kept apart from the client so tools can depend on the
 * shapes without pulling in the process/JSON-RPC machinery.
 */

import type * as cp from 'child_process';
import type { ILogger } from '../host/Logger';
import type { PublishDiagnosticsParams, ProgressParams } from './protocol';

export type LspClientState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'crashed';

export interface LspExitInfo {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** آیا ما خواسته بودیم که خارج شود؟ */
  readonly expected: boolean;
}

export interface LspClientOptions {
  /** شناسهٔ سرور — فقط برای لاگ و پیام خطا. */
  readonly id: string;
  readonly command: string;
  readonly args?: readonly string[];
  /** ریشهٔ workspace؛ هم `cwd` پروسه است هم `rootUri` دست‌دادن. */
  readonly rootPath: string;
  readonly logger?: ILogger;
  readonly env?: NodeJS.ProcessEnv;
  readonly requestTimeoutMs?: number;
  readonly initializeTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly initializationOptions?: unknown;
  /** پاسخ به `workspace/configuration`. پیش‌فرض: یک شیء خالی برای هر آیتم. */
  readonly configuration?: (section: string | undefined) => unknown;
  readonly onDiagnostics?: (params: PublishDiagnosticsParams) => void;
  readonly onProgress?: (params: ProgressParams) => void;
  readonly onExit?: (info: LspExitInfo) => void;
  /** برای تست: جایگزین `child_process.spawn`. */
  readonly spawn?: typeof cp.spawn;
}

export interface RequestOptions {
  readonly timeoutMs?: number;
}

// ── خطاها ─────────────────────────────────────────────────────────────

export class LspError extends Error {
  constructor(
    message: string,
    readonly serverId: string
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** سرور به‌موقع جواب نداد. درخواست لغو شد (`$/cancelRequest`). */
export class LspTimeoutError extends LspError {}

/** پروسه بالا نیامد — باینری نبود، یا فوراً مرد. */
export class LspStartError extends LspError {}

/** سرور در حال اجرا نیست (هنوز، یا دیگر). */
export class LspNotRunningError extends LspError {}
