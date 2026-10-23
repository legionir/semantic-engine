/**
 * Shared types and error of the host config (split from Config.ts, unchanged).
 */

export const KEY_PREFIX = 'semanticEngine.';

export interface SchemaProperty {
  type?: string | string[];
  default?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  description?: string;
}

export interface ConfigSchema {
  properties: Record<string, SchemaProperty>;
}

/**
 * خطای پیکربندی با فهرست کامل مشکلات.
 *
 * چند مشکل هم‌زمان جمع می‌شوند: کسی که سه مقدار را اشتباه گذاشته نباید
 * سه بار اجرا کند تا سه پیام ببیند.
 */
export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(issues.length === 1 ? issues[0] : `Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}
