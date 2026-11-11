/**
 * Renders the tool catalogue (what a model is shown over MCP) as Markdown.
 * One renderer feeds docs/AI-TOOLS.md and the Claude Code skill, so neither can
 * drift from the registry; `toolDocs.test.ts` fails when a checked-in file does.
 */

import { TOOL_DOCS } from './toolDocs';

export interface ListedTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

type Prop = Record<string, unknown>;

const GROUP_TITLES: Readonly<Record<string, string>> = {
  project: 'Orientation',
  search: 'Finding things',
  navigate: 'Navigating symbols and dependencies',
  understand: 'Understanding code',
  read: 'Reading source',
  impact: 'Impact, risk and history',
  edit: 'Guarded edits (opt-in)',
  experimental: 'Experimental (opt-in)',
};
const GROUP_ORDER = ['project', 'search', 'navigate', 'understand', 'read', 'impact', 'edit', 'experimental'];

function typeOf(prop: Prop): string {
  if (Array.isArray(prop['enum'])) return (prop['enum'] as unknown[]).map(v => JSON.stringify(v)).join(' \\| ');
  const options = (prop['oneOf'] ?? prop['anyOf']) as Prop[] | undefined;
  if (options) return options.map(typeOf).join(' \\| ');
  const type = String(prop['type'] ?? 'any');
  if (type === 'array') return `${typeOf((prop['items'] ?? {}) as Prop)}[]`;
  return type;
}

function constraints(prop: Prop): string {
  const parts: string[] = [];
  if (prop['minimum'] !== undefined) parts.push(`min ${String(prop['minimum'])}`);
  if (prop['maximum'] !== undefined) parts.push(`max ${String(prop['maximum'])}`);
  if (prop['minLength'] !== undefined) parts.push(`min length ${String(prop['minLength'])}`);
  if (prop['maxLength'] !== undefined) parts.push(`max length ${String(prop['maxLength'])}`);
  if (prop['default'] !== undefined) parts.push(`default ${JSON.stringify(prop['default'])}`);
  return parts.join(', ');
}

/** "path | fileId" style groups from `anyOf: [{required:[…]}…]`. */
function oneOfRequired(schema: Record<string, unknown>): string[] {
  const any = schema['anyOf'] as Array<{ required?: string[] }> | undefined;
  return (any ?? []).flatMap(entry => entry.required ?? []);
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function paramTable(tool: ListedTool): string {
  const props = (tool.inputSchema['properties'] ?? {}) as Record<string, Prop>;
  const names = Object.keys(props);
  if (names.length === 0) return '_No parameters._\n';
  const required = new Set((tool.inputSchema['required'] as string[] | undefined) ?? []);
  const alternatives = new Set(oneOfRequired(tool.inputSchema));
  const rows = names.map(name => {
    const prop = props[name]!;
    const need = required.has(name) ? 'required' : alternatives.has(name) ? 'one of*' : 'optional';
    const extra = constraints(prop);
    return `| \`${name}\` | ${typeOf(prop)} | ${need} | ${cell(String(prop['description'] ?? ''))}${extra ? ` _(${extra})_` : ''} |`;
  });
  const note = alternatives.size > 0 ? `\n\\* give at least one of: ${[...alternatives].map(n => `\`${n}\``).join(', ')}.\n` : '';
  return `| Parameter | Type | Need | Meaning |\n|---|---|---|---|\n${rows.join('\n')}\n${note}`;
}

function grouped(tools: readonly ListedTool[]): Array<[string, ListedTool[]]> {
  const byGroup = new Map<string, ListedTool[]>();
  for (const tool of tools) {
    const group = TOOL_DOCS[tool.name]?.group ?? 'experimental';
    byGroup.set(group, [...(byGroup.get(group) ?? []), tool]);
  }
  return GROUP_ORDER.filter(g => byGroup.has(g)).map(g => [g, byGroup.get(g)!]);
}

/** Full reference: every tool with use, parameters and result shape. */
export function renderToolReference(tools: readonly ListedTool[]): string {
  const out: string[] = [];
  for (const [group, list] of grouped(tools)) {
    out.push(`## ${GROUP_TITLES[group] ?? group}\n`);
    for (const tool of list) {
      const doc = TOOL_DOCS[tool.name];
      out.push(`### \`${tool.name}\`\n`);
      out.push(`${doc?.use ?? tool.description}\n`);
      out.push(paramTable(tool));
      if (doc) out.push(`**Returns.** ${doc.returns}\n`);
    }
  }
  return out.join('\n');
}
