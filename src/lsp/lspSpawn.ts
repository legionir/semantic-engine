/**
 * Spawning of the language-server process (split from LspClient.ts, behavior unchanged).
 */

import * as cp from 'child_process';
import { LspClientOptions, LspStartError } from './LspClientTypes';

export function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export interface SpawnedServer {
  readonly child: cp.ChildProcess;
  /** Resolves when the child exits. */
  readonly childExit: Promise<void>;
  /** Rejects when the process fails to spawn (asynchronously, e.g. ENOENT). */
  readonly spawnFailure: Promise<never>;
}

export interface SpawnHooks {
  /** Called as soon as the child object exists, before the `spawn` event. */
  onChild(child: cp.ChildProcess): void;
  onExit(code: number | null, signal: NodeJS.Signals | null): void;
}

export async function spawnServer(options: LspClientOptions, hooks: SpawnHooks): Promise<SpawnedServer> {
  const spawn = options.spawn ?? cp.spawn;
  const args = [...(options.args ?? [])];

  let child: cp.ChildProcess;
  try {
    child = spawn(options.command, args, {
      cwd: options.rootPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options.env ?? process.env,
    });
  } catch (error) {
    throw new LspStartError(
      `could not spawn ${options.command}: ${(error as Error).message}`,
      options.id
    );
  }
  hooks.onChild(child);

  /*
  | خطای spawn (مثلاً ENOENT) ناهمگام می‌آید. تا وقتی start تمام
  | نشده، باید به رد شدن آن ترجمه شود؛ بعد از آن، یک کرش است.
  */
  const spawnFailure = new Promise<never>((_, reject) => {
    child.once('error', error => {
      reject(
        new LspStartError(
          `could not spawn ${options.command}: ${(error as Error).message}`,
          options.id
        )
      );
    });
  });
  spawnFailure.catch(() => undefined);

  const childExit = new Promise<void>(resolve => {
    child.once('exit', (code, signal) => {
      hooks.onExit(code, signal);
      resolve();
    });
  });

  /*
  | صبر برای رویداد `spawn` پیش از ساختن اتصال.
  |
  | بدون آن، وقتی باینری وجود ندارد، `initialize` روی یک stdin که
  | همان لحظه نابود می‌شود نوشته می‌شود و `vscode-jsonrpc` داخل یک
  | executor ناهمگام هم reject می‌کند و هم throw — یعنی یک
  | unhandled rejection که به *تست بعدی* می‌چسبد. یک‌بار دقیقاً
  | همین اتفاق افتاد و تست اشتباهی را قرمز کرد.
  */
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  } catch (error) {
    throw new LspStartError(
      `could not spawn ${options.command}: ${describe(error)}`,
      options.id
    );
  }

  return { child, childExit, spawnFailure };
}

/** Waits for the child to exit; `false` when it is still alive after `timeoutMs`. */
export async function waitForChildExit(
  child: cp.ChildProcess | undefined,
  childExit: Promise<void> | undefined,
  timeoutMs: number
): Promise<boolean> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>(resolve => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    return await Promise.race([childExit!.then(() => true), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** SIGKILL the child if it is still alive, and give it two seconds to be reaped. */
export async function killChild(child: cp.ChildProcess, childExit: Promise<void> | undefined): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await Promise.race([
      childExit,
      new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 2000);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
  }
}
