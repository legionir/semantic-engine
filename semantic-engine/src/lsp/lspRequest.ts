/**
 * One JSON-RPC request with a deadline (split from LspClient.ts, behavior unchanged).
 */

import * as rpc from 'vscode-jsonrpc/node';
import {
  LspClientState, LspError, LspNotRunningError, LspStartError, LspTimeoutError,
} from './LspClientTypes';
import { describe } from './lspSpawn';

/** A request that has been sent and not answered yet. */
export interface Pending {
  reject(error: Error): void;
}

/** What a request needs from its client. */
export interface RequestContext {
  readonly serverId: string;
  readonly pending: Set<Pending>;
  connection(): rpc.MessageConnection | undefined;
  isChannelDead(): boolean;
  state(): LspClientState;
}

/**
 * یک درخواست با سررسید.
 *
 * روی timeout، `$/cancelRequest` هم می‌رود — وگرنه سرور تا آخر روی
 * کاری که دیگر کسی نمی‌خواهد وقت می‌گذارد.
 */
export async function sendRequest<T>(
  ctx: RequestContext,
  method: string,
  params: unknown,
  timeoutMs: number
): Promise<T> {
  const connection = ctx.connection();
  if (!connection || ctx.isChannelDead()) {
    throw new LspNotRunningError(
      `cannot send ${method}: server ${ctx.serverId} has no live connection`,
      ctx.serverId
    );
  }

  const source = new rpc.CancellationTokenSource();
  let timer: NodeJS.Timeout | undefined;
  let settled = false;

  const inFlight: Pending = { reject: () => undefined };

  const result = new Promise<T>((resolve, reject) => {
    inFlight.reject = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      source.cancel();
      reject(
        new LspTimeoutError(
          `${method} on server ${ctx.serverId} did not answer in ${timeoutMs}ms`,
          ctx.serverId
        )
      );
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    const sent =
      params === undefined
        ? connection.sendRequest<T>(method, source.token)
        : connection.sendRequest<T>(method, params, source.token);

    sent.then(
      value => {
        if (settled) return;
        settled = true;
        resolve(value);
      },
      error => {
        if (settled) return;
        settled = true;
        reject(translateError(ctx, method, error));
      }
    );
  });

  ctx.pending.add(inFlight);
  try {
    return await result;
  } finally {
    ctx.pending.delete(inFlight);
    if (timer) clearTimeout(timer);
    source.dispose();
  }
}

function translateError(ctx: RequestContext, method: string, error: unknown): Error {
  if (ctx.state() !== 'running' && ctx.state() !== 'starting') {
    return new LspNotRunningError(
      `${method} failed: server ${ctx.serverId} is ${ctx.state()}`,
      ctx.serverId
    );
  }
  if (ctx.state() === 'starting') {
    return new LspStartError(
      `${method} failed while starting server ${ctx.serverId}: ${describe(error)}`,
      ctx.serverId
    );
  }
  return error instanceof Error ? error : new LspError(describe(error), ctx.serverId);
}
