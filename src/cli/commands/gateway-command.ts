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
import { DEFAULT_HOST } from '../HttpGuard';
import { resolveGatewayToken } from '../../gateway/GatewayTokenStore';
import { renderBanner, withToken } from '../banner';
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
  const dataRoot = stringOption(args.options, 'dataDir')
    ? String(stringOption(args.options, 'dataDir'))
    : resolveDataRoot({ env: process.env });

  /* An explicit token wins; otherwise the stored one, so client configs stay valid across restarts. */
  const resolved = resolveGatewayToken({
    dataRoot,
    provided:
      stringOption(args.options, 'token') ??
      process.env['SEMANTIC_ENGINE_GATEWAY_TOKEN'] ??
      process.env['SEMANTIC_ENGINE_TOKEN'],
    rotate: boolOption(args.options, 'rotateToken', false),
  });
  const token = resolved.token;

  const networkFs = networkFilesystemOf(dataRoot);
  if (networkFs) context.logger.warn(networkFilesystemWarning(dataRoot, networkFs));

  const gateway = new GatewayServer({ dataRoot, port, host, token, tokenSource: resolved.source });
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

  const projects = gateway.registry.list();
  const workers = gateway.supervisor.list();
  const tokenNote: Record<string, string> = {
    provided: 'provided (--token or environment)',
    stored: `stored, stable across restarts (${resolved.file ?? 'data dir'})`,
    generated: `generated and saved to ${resolved.file ?? 'nowhere (read-only data dir)'}`,
    rotated: `rotated and saved to ${resolved.file ?? 'nowhere (read-only data dir)'}`,
  };
  process.stderr.write(
    renderBanner({
      mode: 'gateway',
      sections: [
        {
          title: 'Open',
          rows: [
            { label: 'Dashboard', value: withToken(`${info.url}/`, token) },
            { label: 'Settings', value: withToken(`${info.url}/open.html`, token) },
            { label: 'MCP (all projects)', value: withToken(`${info.url}/mcp`, token) },
            { label: 'MCP (one project)', value: `${info.url}/mcp/<project-id-or-name>?token=…` },
          ],
        },
        {
          title: 'Status',
          rows: [
            { label: 'Projects', value: `${projects.length} registered, ${workers.length} worker(s) started` },
            ...(registeredId ? [{ label: 'Registered now', value: registeredId }] : []),
            { label: 'Health', value: `${info.url}/health   metrics ${info.url}/metrics` },
            { label: 'Data dir', value: dataRoot },
            { label: 'Token', value: `${token}   [${tokenNote[resolved.source] ?? resolved.source}]` },
          ],
        },
      ],
      footer: [
        'Connect an AI once: open the dashboard and press "Connect AI" for ready-made config.',
        'One MCP entry covers every project; the AI passes the project name or id per call.',
        'Press Ctrl+C to stop.',
      ],
    })
  );

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
