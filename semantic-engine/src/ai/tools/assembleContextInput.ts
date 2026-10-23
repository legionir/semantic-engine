/**
 * Input validation of the assemble_context tool (split from AssembleContextTool.ts, unchanged).
 */

import type { AssembleContextInput } from './AssembleContextTool';

export function validateAssembleInput(input: AssembleContextInput): string | null {
  if (typeof input.task !== 'string' || input.task.trim().length === 0) return 'task is required and must be a non-empty string';
  if (input.targetFiles !== undefined && (!Array.isArray(input.targetFiles) || input.targetFiles.some(file => typeof file !== 'string'))) return 'targetFiles must be an array of strings';
  if (input.targetSymbols !== undefined && (!Array.isArray(input.targetSymbols) || input.targetSymbols.some(symbol => typeof symbol !== 'string'))) return 'targetSymbols must be an array of strings';
  if (input.maxTokens !== undefined && (!Number.isInteger(input.maxTokens) || input.maxTokens < 1)) return 'maxTokens must be a positive integer';
  if (input.dependencyDepth !== undefined && (!Number.isInteger(input.dependencyDepth) || input.dependencyDepth < 1)) return 'dependencyDepth must be a positive integer';
  if (input.includeTests !== undefined && typeof input.includeTests !== 'boolean') return 'includeTests must be a boolean';
  if (input.includeRecentChanges !== undefined && typeof input.includeRecentChanges !== 'boolean') return 'includeRecentChanges must be a boolean';
  if (input.explain !== undefined && typeof input.explain !== 'boolean') return 'explain must be a boolean';
  return null;
}
