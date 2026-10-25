/**
 * `semantic-engine query` — MIG-53.
 *
 * روی همان `AiToolRegistry` که سرور MCP استفاده می‌کند. هر ابزاری که
 * آن‌جا ثبت شود، این‌جا هم بدون تغییر کد در دسترس است.
 */

import * as fs from 'fs';
import { AiToolRegistry } from '../../ai/AiToolRegistry';
import { ProjectIndexReader } from '../../ai/ProjectIndexReader';
import { ProjectIndex } from '../../core/types/project-index.types';
import { EXIT, OptionValue, ParsedArgs, stringOption } from '../args';
import { CommandContext, CommandResult } from './types';
import { normalizeWorkspaceRoot, resolveProjectIndexPath, workspaceRootFromIndex } from '../../core/config/ProjectPaths';
import { migrateLegacyArtifacts } from '../../core/config/migrateLegacyArtifacts';
import { indexLookupFromArgs } from '../projectPathsFromArgs';

/** گزینه‌هایی که خودِ CLI مصرف می‌کند و پارامتر ابزار نیستند. */
const RESERVED = new Set(['index', 'json', 'root', 'help', 'version']);

/*
| SE-CLI-01 — `parseArgs` همهٔ مقادیر را **رشته** می‌دهد، اما schema
| ابزارها `integer/number/boolean/array` می‌خواهند. نتیجهٔ عملی:
| `query find_symbol --name rank --limit 5` با «limit: must be integer»
| برمی‌گشت، یعنی agent از CLI هیچ راهی برای محدود کردن حجم خروجی
| نداشت — همان اهرمی که برای کاراییِ توکن ساخته شده بود.
|
| تبدیل بر اساس خودِ schema انجام می‌شود، نه حدس از مقدار: «abc» برای
| `limit` خطایِ نام‌دار و یک‌تایی می‌دهد، نه خطایِ validationِ ابزار.
*/
export function coerceToolParams(
  schema: Record<string, unknown>,
  options: Readonly<Record<string, OptionValue>>
): { readonly params: Record<string, unknown> } | { readonly error: string } {
  const properties = (schema as { properties?: Record<string, { type?: string }> }).properties ?? {};
  const params: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(options)) {
    if (RESERVED.has(key)) continue;
    const declared = properties[key]?.type;

    // پرچم بدون مقدار (`--json` رزرو است؛ مثلاً `--strict`) یعنی true
    if (typeof value === 'boolean') {
      params[key] = declared === 'string' ? '' : value;
      continue;
    }

    if (declared === 'integer' || declared === 'number') {
      const num = Number(value);
      if (value.trim() === '' || !Number.isFinite(num)) {
        return { error: `${key}: expected ${declared}, got "${value}"` };
      }
      if (declared === 'integer' && !Number.isInteger(num)) {
        return { error: `${key}: expected integer, got "${value}"` };
      }
      params[key] = num;
      continue;
    }

    if (declared === 'boolean') {
      if (value === 'true') { params[key] = true; continue; }
      if (value === 'false') { params[key] = false; continue; }
      return { error: `${key}: expected boolean, got "${value}"` };
    }

    if (declared === 'array') {
      params[key] = value.split(',').map(item => item.trim()).filter(item => item.length > 0);
      continue;
    }

    params[key] = value;
  }

  return { params };
}

export async function runQuery(args: ParsedArgs, context: CommandContext): Promise<CommandResult> {
  const root = normalizeWorkspaceRoot(stringOption(args.options, 'root') ?? context.cwd);
  const lookup = indexLookupFromArgs(args, root);
  migrateLegacyArtifacts({
    workspaceRoot: root,
    projectId: lookup.projectId ?? '',
    location: lookup.location,
    ...(lookup.dataRoot !== undefined ? { dataRoot: lookup.dataRoot } : {}),
  });
  const indexPath = resolveProjectIndexPath(root, stringOption(args.options, 'index'), lookup);

  if (!fs.existsSync(indexPath)) {
    return {
      code: EXIT.failure,
      error:
        `index not found: ${indexPath}\n` +
        `run "semantic-engine index" first, or pass --index <path>`,
    };
  }

  let projectIndex: ProjectIndex;
  try {
    projectIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as ProjectIndex;
  } catch (error) {
    return {
      code: EXIT.failure,
      error: `index is not readable JSON: ${indexPath}\n${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  /*
  | SE-EXP-05: `rootPath` مسیر واقعی است؛ `root` فقط نام کوتاه پروژه.
  | دادنِ `root` به‌عنوان workspaceRoot یعنی هر ابزاری که فایل
  | می‌خواند، به یک مسیر بی‌معنا نگاه کند.
  */
  const workspaceRoot = stringOption(args.options, 'root')
    ? root
    : workspaceRootFromIndex(projectIndex, indexPath);

  const registry = new AiToolRegistry({
    reader: new ProjectIndexReader(projectIndex),
    workspaceRoot,
  });

  const toolName = args.positional[0];
  if (!toolName) {
    const tools = registry.list();
    return {
      code: EXIT.ok,
      json: { ok: true, tools: tools.map(tool => ({ name: tool.name, description: tool.description })) },
      text: tools.map(tool => `${tool.name.padEnd(22)} ${tool.description}`).join('\n'),
    };
  }

  const tool = registry.get(toolName);
  if (!tool) {
    const available = registry.list().map(t => t.name).join(', ');
    return {
      code: EXIT.usage,
      error: `unknown tool: ${toolName}\navailable: ${available}`,
    };
  }

  const coerced = coerceToolParams(tool.inputSchema, args.options);
  if ('error' in coerced) {
    return { code: EXIT.usage, error: `Invalid input for '${toolName}' — ${coerced.error}` };
  }
  const params = coerced.params;

  const result = await registry.execute(toolName, params);

  const payload = {
    items: result.items,
    ...(result.context !== undefined ? { context: result.context } : {}),
    ...(result.metadata !== undefined ? { metadata: result.metadata } : {}),
  };

  return {
    code: result.success ? EXIT.ok : EXIT.failure,
    json: { ok: result.success, result: payload, ...(result.error ? { error: result.error } : {}) },
    ...(result.success
      ? { text: JSON.stringify(payload, null, 2) }
      : { error: result.error ?? 'tool failed' }),
  };
}
