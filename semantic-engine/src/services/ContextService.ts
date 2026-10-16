/**
 * ContextService — Token-budgeted context assembly for AI agents.
 */

import { ManagedProject } from './ProjectService';
import { AssembleContextTool } from '../ai/tools/AssembleContextTool';

export interface ContextRequestOptions {
  readonly task: string;
  readonly files?: string[];
  readonly maxTokens?: number;
}

export class ContextService {
  /**
   * تجمیع هوشمند کانتکست با رتبه‌بندی و سقف بودجه توکن.
   */
  async assembleContext(project: ManagedProject, options: ContextRequestOptions): Promise<unknown> {
    if (!project.reader) {
      throw new Error(`Project ${project.id} has no valid index loaded.`);
    }

    const tool = new AssembleContextTool(project.reader, undefined, {
      workspaceRoot: project.rootPath,
      ...(project.blueprint ? { blueprint: project.blueprint } : {}),
    });

    const result = await tool.execute({
      task: options.task,
      // AssembleContextTool contract uses targetFiles.
      targetFiles: options.files,
      maxTokens: options.maxTokens,
    });

    if (!result.success) {
      throw new Error(result.error || 'Context assembly failed');
    }

    const firstItem = result.items[0];
    // maxTokens is a budget, not an estimate; use measured tool metadata.
    const tokenEstimate = result.metadata?.estimatedTokens ?? 0;
    return {
      task: options.task,
      tokenEstimate,
      summary: firstItem?.excerpt || `Assembled context with ${result.items.length} items`,
      items: [...result.items],
    };
  }
}
