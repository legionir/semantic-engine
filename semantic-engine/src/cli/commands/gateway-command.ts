/**
 * `semantic-engine gateway` — فاز ۱۰.
 *
 * The public entry point: one port, many single-project workers. It is what
 * the plan's §۱۷ shows (`semantic-engine gateway --port 4000 --token …`) and
 * what the cross-package integration harness starts.
 *
 * The URL and the token go to **stderr**, like every other diagnostic in this
 * CLI, so `--json` on stdout stays parseable.
 */

import { networkFilesystemOf, networkFilesystemWarning } from '../../host/networkFilesystem';
import { EXIT, ParsedArgs, boolOption, stringOption } from '../args';
import { CommandContext, CommandResult } from './types';
import { GatewayServer, DEFAULT_GATEWAY_PORT } from '../../gateway/GatewayServer';
import { DEFAULT_HOST, generateToken } from '../HttpGuard';
import { resolveDataRoot } from '../../core/config/DataRootResolver';

export async function runGateway(
  args: ParsedArgs,
  context: CommandContext
): Promise<CommandResult> {
  const rawPort = stringOption(args.options, 'port');
  const port = rawPort === undefined ? DEFAULT_GATEWAY_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return { code: EXIT.usage, error: '--port must be a number between 0 and 65535' };
  }

  const host = stringOption(args.options, 'host') ?? DEFAULT_HOST;
  const token =
    stringOption(args.options, 'token') ??
    process.env['SEMANTIC_ENGINE_GATEWAY_TOKEN'] ??
    process.env['SEMANTIC_ENGINE_TOKEN'] ??
    generateToken();
  const dataRoot = stringOption(args.options, 'dataDir')
    ? String(stringOption(args.options, 'dataDir'))
    : resolveDataRoot({ env: process.env });

  const networkFs = networkFilesystemOf(dataRoot);
  if (networkFs) context.logger.warn(networkFilesystemWarning(dataRoot, networkFs));

  const gateway = new GatewayServer({ dataRoot, port, host, token });
  const info = await gateway.start();

  /* پروژهٔ اختیاری از خط فرمان؛ بقیه از API ثبت می‌شوند. */
  const projectPath = stringOption(args.options, 'project');
  let registeredId: string | undefined;
  if (projectPath) {
    const registered = gateway.registry.register({
      rootPath: projectPath,
      name: stringOption(args.options, 'name') ?? undefined,
      ...(stringOption(args.options, 'projectId')
        ? { id: String(stringOption(args.options, 'projectId')) }
        : {}),
    });
    registeredId = registered.id;
    if (boolOption(args.options, 'autoStart', true)) {
      await gateway.supervisor.start(
        gateway.configForProject(registered.id, registered.rootPath, registered.name)
      );
    }
  }

  context.logger.info('gateway listening', {
    url: info.url,
    dataRoot,
    projects: gateway.registry.list().length,
    ...(registeredId ? { projectId: registeredId } : {}),
  });
  /* برای harnessها: یک خط قابل parse روی stderr. */
  process.stderr.write(`gateway url=${info.url} token=${token}\n`);

  await new Promise<void>(resolve => {
    const onSignal = (): void => resolve();
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  });

  await gateway.stop();
  context.logger.info('gateway stopped', { url: info.url });

  return {
    code: EXIT.ok,
    json: { ok: true, url: info.url, dataRoot },
    text: 'gateway stopped',
  };
}
