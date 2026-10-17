/**
 * Handlers for what a language server asks of its client: configuration,
 * capability registration, progress and diagnostics notifications, and the
 * connection-close bookkeeping. Every server request gets an answer; silence
 * would leave the server waiting forever.
 */

import * as rpc from 'vscode-jsonrpc/node';
import type { ILogger } from '../host/Logger';
import { LspClientOptions, LspClientState, LspNotRunningError } from './LspClientTypes';
import { CLIENT_NAME } from './lspInitializeParams';
import type { ProgressParams, PublishDiagnosticsParams } from './protocol';

/** What the handlers need from the owning client — no more. */
export interface ClientHandlerContext {
  readonly options: LspClientOptions;
  readonly logger: ILogger;
  readonly diagnosticsListeners: readonly ((params: PublishDiagnosticsParams) => void)[];
  state(): LspClientState;
  markCrashed(): void;
  dispatchNotification(method: string, params: unknown): void;
  rejectPending(error: Error): void;
}

export function registerClientHandlers(connection: rpc.MessageConnection, ctx: ClientHandlerContext): void {
  const configuration = ctx.options.configuration ?? (() => ({}));

  /*
  | این سه، اجباری‌اند. probe نشان داد `tsgo` دوتای اول را واقعاً
  | می‌فرستد و منتظر جواب می‌ماند.
  */
  connection.onRequest('workspace/configuration', (params: { items?: { section?: string }[] }) =>
    (params?.items ?? []).map(item => configuration(item?.section))
  );
  connection.onRequest('client/registerCapability', () => null);
  connection.onRequest('client/unregisterCapability', () => null);
  connection.onRequest('window/workDoneProgress/create', () => null);
  connection.onRequest('window/showMessageRequest', () => null);
  // ویرایش فایل کار ما نیست؛ «نپذیرفتم» صادقانه‌تر از سکوت است.
  connection.onRequest('workspace/applyEdit', () => ({ applied: false }));

  /*
  | هر درخواست دیگری هم باید *جوابی* بگیرد. سکوت یعنی سرور تا ابد
  | منتظر می‌ماند و هیچ‌جا خطایی ثبت نمی‌شود.
  */
  connection.onRequest((method: string) => {
    ctx.logger.debug('unhandled server request', { method });
    return new rpc.ResponseError(rpc.ErrorCodes.MethodNotFound, `${CLIENT_NAME} does not implement ${method}`);
  });

  connection.onNotification('$/progress', (params: ProgressParams) => {
    ctx.options.onProgress?.(params);
    ctx.dispatchNotification('$/progress', params);
  });
  connection.onNotification(
    'textDocument/publishDiagnostics',
    (params: PublishDiagnosticsParams) => {
      ctx.dispatchNotification('textDocument/publishDiagnostics', params);
      ctx.options.onDiagnostics?.(params);
      for (const listener of ctx.diagnosticsListeners) {
        try {
          listener(params);
        } catch (error) {
          ctx.logger.debug('diagnostics listener threw', { error: String(error) });
        }
      }
    }
  );
  connection.onNotification((method: string, ...params: unknown[]) => {
    ctx.logger.debug('server notification', { method });
    ctx.dispatchNotification(method, params[0]);
  });

  connection.onError(([error]) => {
    ctx.logger.debug('connection error', { error: String(error) });
  });
  connection.onClose(() => {
    ctx.logger.debug('connection closed');
    /*
    | کتابخانه در پرواز‌ها را روی close رد نمی‌کند (فقط روی
    | dispose). بدون این، مرگ سرور یعنی هر فراخوان تا سررسید
    | timeout خودش معلق می‌ماند.
    */
    if (ctx.state() !== 'stopping' && ctx.state() !== 'stopped') {
      /*
      | اتصال که بسته شد، سرور رفته است — رویداد `exit` پروسه یک تیک
      | بعد می‌آید. اگر تا آن لحظه حالت را «در حال اجرا» نگه داریم،
      | فراخوان بعدی درخواستی می‌فرستد که هیچ‌وقت جواب نمی‌گیرد.
      */
      if (ctx.state() === 'running' || ctx.state() === 'starting') {
        ctx.markCrashed();
      }
      ctx.rejectPending(
        new LspNotRunningError(
          `server ${ctx.options.id} closed the connection`,
          ctx.options.id
        )
      );
    }
  });
}
