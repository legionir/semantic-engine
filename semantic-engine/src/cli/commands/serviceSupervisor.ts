/**
 * Child-process supervision shared by `start` and `worker`: spawn a CLI
 * service, wait for its ready marker, stop it cleanly, and hold the parent
 * open until SIGINT/SIGTERM.
 */

import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';

export interface StartedChild {
  readonly child: ChildProcess;
  readonly ready: Promise<void>;
  readonly output: () => string;
}

/** Start one child and mirror its stderr so both services remain observable. */
export function spawnService(
  args: readonly string[],
  marker: RegExp,
  root: string
): StartedChild {
  const cli = path.resolve(__dirname, '../../..', 'bin', 'semantic-engine.js');
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  let settled = false;
  let output = '';
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;

  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  child.stderr?.on('data', chunk => {
    const text = String(chunk);
    output += text;
    process.stderr.write(text);
    if (!settled && marker.test(output)) {
      settled = true;
      resolveReady();
    }
  });

  /*
  | A child that neither prints its ready marker nor exits (a port that
  | accepts but never answers, a watcher stuck on a lock) would leave `start`
  | waiting forever with no message. Fail with what the child said.
  */
  const requestedMs = Number(process.env['SEMANTIC_ENGINE_START_TIMEOUT_MS']);
  const startupMs = Number.isFinite(requestedMs) && requestedMs >= 1000 ? requestedMs : 180_000;
  const startupTimer = setTimeout(() => {
    if (settled) return;
    settled = true;
    /* A child that never became ready must not outlive the failed start. */
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    rejectReady(new Error(
      `semantic-engine service did not become ready within ${Math.round(startupMs / 1000)}s ` +
      `(${args[0] ?? 'service'}); last output:\n${output.split('\n').slice(-8).join('\n')}`
    ));
  }, startupMs);
  startupTimer.unref?.();
  void ready.then(() => clearTimeout(startupTimer), () => clearTimeout(startupTimer));

  child.once('error', error => {
    if (!settled) {
      settled = true;
      rejectReady(error instanceof Error ? error : new Error(String(error)));
    }
  });

  child.once('exit', code => {
    if (!settled) {
      settled = true;
      rejectReady(new Error(`semantic-engine service exited before ready (code ${code})`));
    }
  });

  return { child, ready, output: () => output };
}

export async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  await new Promise<void>(resolve => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      finish();
    }, 5000);

    child.once('exit', finish);
    child.kill('SIGTERM');
  });
}


/**
 * ماندن تا SIGINT/SIGTERM، بعد خاموشی تمیز.
 *
 * بدون این، `Ctrl+C` پروسه را وسط کار می‌کشد و سوکت‌های باز و — در
 * حالت watch — یک batch نیمه‌نوشته جا می‌ماند.
 */
export function waitForShutdown(cleanup: () => Promise<void>): Promise<void> {
  return new Promise<void>(resolve => {
    let closing = false;

    const stop = (signal: string): void => {
      if (closing) return;
      closing = true;
      process.stderr.write(`\nreceived ${signal}, shutting down…\n`);
      void cleanup().then(
        () => resolve(),
        () => resolve()
      );
    };

    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
  });
}
