/**
 * SimulateMutationTool — AI-facing tool for virtual refactoring and impact simulation before disk mutation.
 */

import { AiTool, AiToolInput, AiToolOutput } from './types';
import { ProjectIndexReader } from '../ProjectIndexReader';
import { buildIndexGraph, describeNode } from '../../services/analysis/buildIndexGraph';
import { MutationSimulator, MutationAction } from '../../services/analysis/MutationSimulator';
import { resolveSymbolId } from './resolveIndexEntity';

export class SimulateMutationTool implements AiTool {
  readonly name = 'simulate_mutation';
  readonly description = 'Simulates a virtual code refactoring action and identifies broken references before changes are written to disk.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      actionType: { type: 'string', enum: ['rename_symbol', 'delete_symbol', 'move_symbol'], description: 'The type of mutation to simulate' },
      targetSymbolId: { type: 'string', description: 'The symbol ID or fully qualified path::symbol name to mutate' },
      newName: { type: 'string', description: 'New symbol name if actionType is rename_symbol' },
      newPath: { type: 'string', description: 'New file path if actionType is move_symbol' },
    },
    required: ['actionType', 'targetSymbolId'],
  };

  constructor(private readonly reader: ProjectIndexReader) {}

  async execute(input: AiToolInput): Promise<AiToolOutput> {
    const actionType = input.actionType as MutationAction['type'];
    const requestedTarget = input.targetSymbolId as string;
    if (!['rename_symbol', 'delete_symbol', 'move_symbol'].includes(actionType)) return { success: false, error: `Unsupported mutation action: ${String(input.actionType)}`, items: [] };
    if (typeof input.targetSymbolId !== 'string' || input.targetSymbolId.trim().length === 0) return { success: false, error: 'targetSymbolId is required and must be a non-empty string', items: [] };
    if (actionType === 'rename_symbol' && (typeof input.newName !== 'string' || input.newName.trim().length === 0)) return { success: false, error: 'newName is required and must be a non-empty string for rename_symbol', items: [] };
    if (actionType === 'move_symbol' && (typeof input.newPath !== 'string' || input.newPath.trim().length === 0)) return { success: false, error: 'newPath is required and must be a non-empty string for move_symbol', items: [] };
    const targetSymbolId = resolveSymbolId(this.reader, requestedTarget);
    if (!targetSymbolId) return { success: false, error: `No symbol found for id or fully-qualified name: ${requestedTarget}`, items: [] };
    const graph = buildIndexGraph(this.reader, { callEdges: true, referenceEdges: true });
    const diff = new MutationSimulator().simulate(graph, { type: actionType, targetSymbolId, newName: input.newName as string | undefined, newPath: input.newPath as string | undefined });

    /*
    | SE-AI-11 — یک سطر به‌ازای **فایل**، نه به‌ازای هر یال.
    |
    | شکل قبلی برای rename متدی با ۲۵ فراخوانی در یک فایل، ۲۵ آیتم
    | تقریباً یکسان می‌داد (۱۲٫۵ کیلوبایت) و در excerpt شناسهٔ هشِ
    | سمبل را می‌نوشت: «relation 'calls' to '426800b63627a7eb'». agent
    | آن را «۲۵ ارجاع شکسته در ۲۵ جای مبهم» می‌خواند، درحالی‌که
    | واقعیت «۲۵ سطرِ فراخوان در یک فایل» است. حالا شمارش، سطرهای
    | فراخوان و نامِ خوانای سمبلِ هدف می‌آید؛ دادهٔ خامِ diff هم در
    | metadata دست‌نخورده می‌ماند.
    */
    const targetLabel = graph.getNode(targetSymbolId)?.label ?? describeNode(graph, targetSymbolId);
    const byFile = new Map<string, { count: number; lines: number[]; symbols: Set<string>; relations: Set<string> }>();
    for (const broken of diff.brokenReferences) {
      const group = byFile.get(broken.callerFile) ?? { count: 0, lines: [] as number[], symbols: new Set<string>(), relations: new Set<string>() };
      group.count++;
      if (typeof broken.callerLine === 'number') group.lines.push(broken.callerLine);
      const callerLabel = graph.getNode(broken.callerId)?.label;
      if (callerLabel) group.symbols.add(callerLabel);
      group.relations.add(broken.relation);
      byFile.set(broken.callerFile, group);
    }

    const items = [...byFile.entries()].map(([file, group]) => {
      const lines = [...new Set(group.lines)].sort((a, b) => a - b);
      const head = lines.length > 0 ? `${file}:${lines[0]}` : file;
      return {
        id: file,
        name: file,
        kind: 'broken_reference',
        path: file,
        source: 'mutation-simulator',
        /*
        | excerpt فقط «کجا و چندتا» را می‌گوید؛ لیست کاملِ سطرهای فراخوان در
        | `metadata.lines` است، پس در پیام تکرار نمی‌شود.
        */
        excerpt: `${head} — ${group.count} call site(s) to \`${targetLabel}\` would break`,
        metadata: {
          brokenReferenceCount: group.count,
          lines,
          relations: [...group.relations],
          callerSymbols: [...group.symbols],
        },
      };
    });

    return {
      success: true,
      metadata: { diff, affectedFiles: byFile.size },
      items,
      context: diff.isSafe
        ? 'Simulation complete: Mutation is safe with 0 broken references.'
        : `Mutation creates ${diff.brokenReferences.length} broken call site(s) across ${byFile.size} file(s).`,
    };
  }
}
