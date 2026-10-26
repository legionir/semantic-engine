/**
 * One MCP endpoint for every project: `POST /mcp`.
 *
 * `/mcp/:projectId` needs one client entry per project. This endpoint is the
 * single entry an AI client configures once: it answers `initialize` and
 * `tools/list` itself, adds a `project` argument (id, name or folder name) to
 * every project tool, and forwards `tools/call` to that project's worker. The
 * workers' MCP servers are stateless, so no session has to be tracked here.
 *
 * Added tool: `list_projects` — what the gateway serves and which are ready.
 */

import * as http from 'http';
import { GatewayAuth } from './GatewayAuth';
import { ProjectRegistry } from '../core/config/ProjectRegistry';
import { WorkerSupervisor } from './WorkerSupervisor';
import { targetConnectOptions } from './workerTarget';
import { packageVersion } from '../host/version';

const PROTOCOL_VERSION = '2025-03-26';
const LIST_PROJECTS = 'list_projects';

type JsonObject = Record<string, unknown>;
type AuthRecord = NonNullable<ReturnType<GatewayAuth['verify']>['record']>;

export interface GatewayMcpDeps {
  readonly registry: ProjectRegistry;
  readonly supervisor: WorkerSupervisor;
  readonly auth: GatewayAuth;
}

interface ToolDefinition extends JsonObject {
  name: string;
  inputSchema?: JsonObject;
}

/** Matches a project by id, then by name, then by root folder name — all case-insensitive. */
export function resolveProject(
  projects: readonly { id: string; name: string; rootPath: string }[],
  query: string
): { id: string; name: string; rootPath: string } | { error: string } {
  const wanted = query.trim().toLowerCase();
  const base = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop()?.toLowerCase() ?? '';
  for (const matches of [
    (p: { id: string; name: string; rootPath: string }) => p.id.toLowerCase() === wanted,
    (p: { id: string; name: string; rootPath: string }) => p.name.toLowerCase() === wanted,
    (p: { id: string; name: string; rootPath: string }) => base(p.rootPath) === wanted,
  ]) {
    const found = projects.filter(matches);
    if (found.length === 1) return found[0]!;
    if (found.length > 1) {
      return { error: `project "${query}" is ambiguous; use one of the ids: ${found.map(p => p.id).join(', ')}` };
    }
  }
  const known = projects.map(p => `${p.id} (${p.name})`).join(', ') || 'none registered';
  return { error: `unknown project "${query}". Known projects: ${known}. Call ${LIST_PROJECTS} first.` };
}

export class GatewayMcp {
  private toolCache: { at: number; tools: ToolDefinition[] } | undefined;

  constructor(private readonly deps: GatewayMcpDeps) {}

  async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: unknown,
    record: AuthRecord
  ): Promise<void> {
    if (Array.isArray(body)) {
      const replies = (await Promise.all(body.map(item => this.dispatch(item, record)))).filter(
        (reply): reply is JsonObject => reply !== undefined
      );
      if (replies.length === 0) return this.accepted(res);
      return this.json(res, replies);
    }
    const reply = await this.dispatch(body, record);
    if (reply === undefined) return this.accepted(res);
    return this.json(res, reply);
  }

  private accepted(res: http.ServerResponse): void {
    res.writeHead(202);
    res.end();
  }

  private json(res: http.ServerResponse, payload: unknown): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  }

  private visibleProjects(record: AuthRecord) {
    return this.deps.registry
      .list()
      .filter(entry => this.deps.auth.canAccessProject(record, entry.id));
  }

  private async dispatch(message: unknown, record: AuthRecord): Promise<JsonObject | undefined> {
    const request = (message ?? {}) as JsonObject;
    const id = request['id'];
    const method = request['method'];
    const isNotification = id === undefined || id === null;
    if (typeof method !== 'string') {
      return isNotification ? undefined : this.failure(id, -32600, 'invalid request');
    }
    if (isNotification) return undefined;

    try {
      switch (method) {
        case 'initialize': {
          const asked = (request['params'] as JsonObject | undefined)?.['protocolVersion'];
          return this.success(id, {
            protocolVersion: typeof asked === 'string' ? asked : PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'semantic-gateway', version: packageVersion() },
            instructions:
              'This gateway serves many projects. Call list_projects, then pass "project" ' +
              '(id or name) to every other tool.',
          });
        }
        case 'ping':
          return this.success(id, {});
        case 'tools/list':
          return this.success(id, { tools: await this.listTools(record) });
        case 'tools/call':
          return await this.callTool(id, (request['params'] ?? {}) as JsonObject, record);
        default:
          return this.failure(id, -32601, `method not found: ${method}`);
      }
    } catch (error) {
      return this.failure(id, -32603, error instanceof Error ? error.message : String(error));
    }
  }

  private success(id: unknown, result: unknown): JsonObject {
    return { jsonrpc: '2.0', id, result };
  }

  private failure(id: unknown, code: number, message: string): JsonObject {
    return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
  }

  private toolResult(id: unknown, text: string, isError = false): JsonObject {
    return this.success(id, { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });
  }

  /* ── tools ─────────────────────────────────────────────────────────── */

  private async listTools(record: AuthRecord): Promise<ToolDefinition[]> {
    const own: ToolDefinition = {
      name: LIST_PROJECTS,
      description:
        'List the projects this gateway serves with their id, name, root path and worker state. ' +
        'Call this first; pass an id or name as "project" to the other tools.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    };
    return [own, ...(await this.projectTools(record))];
  }

  /** The tool catalogue is the same for every project, so any ready worker supplies it. */
  private async projectTools(record: AuthRecord): Promise<ToolDefinition[]> {
    if (this.toolCache && Date.now() - this.toolCache.at < 60_000) return this.toolCache.tools;

    const projects = this.visibleProjects(record);
    let tried = 0;
    let lastError = '';
    for (const project of projects) {
      const worker = this.deps.supervisor.get(project.id);
      if (!worker || worker.pid === null || worker.exitCode !== null) continue;
      tried += 1;
      let reply: JsonObject | undefined;
      try {
        reply = await this.workerRpc(project.id, { jsonrpc: '2.0', id: 'tools', method: 'tools/list', params: {} });
      } catch (error) {
        lastError = `${project.id}: ${error instanceof Error ? error.message : String(error)}`;
        continue;
      }
      const tools = (reply?.['result'] as JsonObject | undefined)?.['tools'];
      if (!Array.isArray(tools)) {
        lastError = `${project.id}: no tools in the answer`;
        continue;
      }

      const decorated = (tools as ToolDefinition[]).map(tool => {
        const schema = (tool.inputSchema ?? { type: 'object', properties: {} }) as JsonObject;
        const properties = { ...((schema['properties'] as JsonObject | undefined) ?? {}) };
        const required = Array.isArray(schema['required']) ? (schema['required'] as string[]) : [];
        return {
          ...tool,
          inputSchema: {
            ...schema,
            properties: {
              project: {
                type: 'string',
                description: 'Project id or name (see list_projects). Optional when only one project is registered.',
              },
              ...properties,
            },
            required,
          },
        };
      });
      this.toolCache = { at: Date.now(), tools: decorated };
      return decorated;
    }
    /*
    | Workers are running but none could list its tools: say so. Returning only
    | list_projects would look like a healthy gateway with a tiny tool set.
    */
    if (tried > 0) {
      throw new Error(`no running project could list its tools (${lastError}). Reindex or restart that project from the dashboard.`);
    }
    return [];
  }

  private async callTool(id: unknown, params: JsonObject, record: AuthRecord): Promise<JsonObject> {
    const name = params['name'];
    if (typeof name !== 'string') return this.failure(id, -32602, 'tools/call needs a tool name');

    const projects = this.visibleProjects(record);
    if (name === LIST_PROJECTS) {
      const workers = new Map(this.deps.supervisor.list().map(w => [w.projectId, w]));
      const listing = projects.map(p => ({
        id: p.id,
        name: p.name,
        rootPath: p.rootPath,
        state: workers.get(p.id)?.state ?? 'stopped',
      }));
      return this.toolResult(id, JSON.stringify({ total: listing.length, projects: listing }, null, 2));
    }

    const args = { ...((params['arguments'] as JsonObject | undefined) ?? {}) };
    const requested = args['project'];
    delete args['project'];

    let target: { id: string } | { error: string };
    if (typeof requested === 'string' && requested.trim() !== '') {
      target = resolveProject(projects, requested);
    } else if (projects.length === 1) {
      target = projects[0]!;
    } else {
      target = { error: `"project" is required because this gateway serves ${projects.length} projects. Call ${LIST_PROJECTS}.` };
    }
    if ('error' in target) return this.toolResult(id, target.error, true);

    const worker = this.deps.supervisor.get(target.id);
    if (!worker || worker.pid === null || worker.exitCode !== null) {
      return this.toolResult(id, `project ${target.id} has no running worker; start it from the dashboard`, true);
    }

    const reply = await this.workerRpc(target.id, {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { ...params, arguments: args },
    });
    return reply ?? this.failure(id, -32603, `project ${target.id} returned no answer`);
  }

  /* ── worker transport ──────────────────────────────────────────────── */

  /**
   * One JSON-RPC request to a worker's `/mcp`. The worker answers JSON or an
   * SSE stream depending on its transport; both are reduced to the one reply.
   */
  private workerRpc(projectId: string, payload: JsonObject): Promise<JsonObject | undefined> {
    const worker = this.deps.supervisor.get(projectId);
    const token = this.deps.supervisor.workerToken(projectId);
    if (!worker || worker.pid === null || worker.exitCode !== null) {
      return Promise.reject(new Error(`worker ${projectId} is not running`));
    }
    const data = JSON.stringify(payload);

    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          ...targetConnectOptions(worker.target),
          path: '/mcp',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'Content-Length': Buffer.byteLength(data),
            Authorization: `Bearer ${token ?? ''}`,
            /* a gateway-managed worker rejects requests that do not look proxied */
            'x-forwarded-for': '127.0.0.1',
            'x-forwarded-proto': 'http',
            'x-forwarded-host': 'gateway',
          },
        },
        upstream => {
          const chunks: Buffer[] = [];
          upstream.on('data', chunk => chunks.push(chunk as Buffer));
          upstream.on('error', reject);
          upstream.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if ((upstream.statusCode ?? 0) >= 400) {
              reject(new Error(`worker ${projectId} answered ${upstream.statusCode}: ${text.slice(0, 200)}`));
              return;
            }
            resolve(parseRpcReply(text));
          });
        }
      );
      request.on('error', reject);
      request.setTimeout(120_000, () => request.destroy(new Error(`worker ${projectId} timed out`)));
      request.write(data);
      request.end();
    });
  }
}

/** Accepts a plain JSON body or an SSE body whose `data:` lines carry the reply. */
export function parseRpcReply(text: string): JsonObject | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  if (trimmed.startsWith('{')) return JSON.parse(trimmed) as JsonObject;

  let last: JsonObject | undefined;
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const value = line.slice(5).trim();
    if (value === '') continue;
    try {
      last = JSON.parse(value) as JsonObject;
    } catch {
      /* a partial event is skipped */
    }
  }
  return last;
}
