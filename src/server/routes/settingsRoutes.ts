/**
 * settingsRoutes — the user config file (`<dataRoot>/config.json`) over HTTP.
 *
 * The panel reads its defaults from here and writes them back, so a value set
 * in the UI is the same value `semantic-engine start` uses next time. Secrets
 * are never accepted: the file only names the environment variable that holds
 * an API key.
 */

import { RouteDefinition, PlatformConfig } from '../types';
import {
  globalConfigPath,
  loadGlobalConfig,
  modelsDirFor,
  saveGlobalConfig,
} from '../../core/config/GlobalConfig';
import { apiKeyEnvVarProblem } from '../../core/security/apiKeyEnvPolicy';
import { assertResolvedFetchableUrl } from '../../services/providers/EmbeddingProviderService';

/** Endpoints the server will later call; same SSRF rules as the jobs route. */
const URL_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ['embedding', 'baseUrl'],
  ['chat', 'baseUrl'],
  ['models', 'hubUrl'],
];
const ENV_NAME_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ['embedding', 'apiKeyEnvVar'],
  ['chat', 'apiKeyEnvVar'],
];

function section(body: unknown, name: string): Record<string, unknown> | null {
  const value = (body as Record<string, unknown> | null | undefined)?.[name];
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

async function validatePatch(body: unknown): Promise<string | null> {
  for (const [sec, key] of URL_FIELDS) {
    const value = section(body, sec)?.[key];
    if (typeof value !== 'string' || value === '') continue;
    try {
      await assertResolvedFetchableUrl(value);
    } catch (error) {
      return `${sec}.${key}: ${(error as Error).message}`;
    }
  }
  for (const [sec, key] of ENV_NAME_FIELDS) {
    const value = section(body, sec)?.[key];
    if (typeof value === 'string' && value !== '') {
      const problem = apiKeyEnvVarProblem(value);
      if (problem) return `${sec}.${key}: ${problem}`;
    }
  }
  return null;
}

export function createSettingsRoutes(platformConfig: PlatformConfig): RouteDefinition[] {
  const dataRoot = platformConfig.dataRoot;

  const view = (): Record<string, unknown> => {
    const loaded = loadGlobalConfig(dataRoot!);
    return {
      configPath: globalConfigPath(dataRoot!),
      configFileExists: loaded.exists,
      dataRoot,
      modelsDir: modelsDirFor(dataRoot!, loaded.config),
      artifactLocation: platformConfig.artifactLocation ?? loaded.config.artifacts.location,
      workspaceRoot: platformConfig.projectsRoot ?? null,
      config: loaded.config,
      warnings: loaded.warnings,
    };
  };

  const unavailable = {
    status: 503,
    json: { error: 'settings are not persisted: the server was started without a data directory' },
  };

  return [
    {
      method: 'GET',
      pattern: '/api/v1/settings',
      requireAuth: true,
      permission: 'config:read',
      handler: async () => (dataRoot ? { status: 200, json: view() } : unavailable),
    },
    {
      method: 'PUT',
      pattern: '/api/v1/settings',
      requireAuth: true,
      permission: 'config:write',
      schema: { type: 'object' },
      handler: async ctx => {
        if (!dataRoot) return unavailable;
        const invalid = await validatePatch(ctx.body);
        if (invalid) return { status: 400, json: { error: invalid } };
        const { warnings } = saveGlobalConfig(dataRoot, ctx.body ?? {});
        return { status: 200, json: { saved: true, ...view(), warnings } };
      },
    },
  ];
}
