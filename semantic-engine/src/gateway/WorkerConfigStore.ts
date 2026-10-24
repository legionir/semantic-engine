/**
 * Per-project worker config persistence and validation (SE-F-057).
 *
 * Split out of `GatewayServer` so the HTTP routing and the config rules can be
 * read — and tested — on their own. Everything here is synchronous file I/O
 * beside the registry manifest, never inside a project's source root.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ProjectRegistry } from '../core/config/ProjectRegistry';
import { createWorkerConfig, validateWorkerConfig } from './WorkerConfigSchema';
import { ProjectWorkerConfig } from './types';
import { isPathSafeProjectId } from '../core/config/ProjectIdentity';

export class WorkerConfigStore {
  constructor(private readonly registry: ProjectRegistry) {}

  /*
  | SE-F-057 — the dashboard form edits the project's WHOLE worker config, not
  | only path/name/autoStart. The config therefore has to be persisted per
  | project (beside the registry manifest, never inside the source root) and
  | fed back into every start path — hydration, POST, PATCH, lifecycle start —
  | otherwise an edit "saves" in the UI and evaporates on the next start.
  */

  /** مسیر فایل config پایدار یک پروژه (خارج از source root). */
  workerConfigPath(projectId: string): string {
    if (!isPathSafeProjectId(projectId)) {
      throw new Error(`project id is not usable as a directory name: ${projectId}`);
    }
    return path.join(this.registry.projectDataDir(projectId), 'worker-config.json');
  }

  /** config پایدار یک پروژه؛ `undefined` یعنی هیچ config سفارشی ثبت نشده. */
  loadStoredWorkerConfig(projectId: string): ProjectWorkerConfig | undefined {
    if (!isPathSafeProjectId(projectId)) return undefined;
    let raw: string;
    try {
      raw = fs.readFileSync(this.workerConfigPath(projectId), 'utf8');
    } catch {
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const validation = validateWorkerConfig(parsed as never, { checkFileSystem: false });
      /* A stored config that no longer validates is treated as absent — and
         the answer stays HONEST: the default config is used, never a half-
         applied custom one. (The file itself is left for inspection.) */
      return validation.ok ? validation.config : undefined;
    } catch {
      return undefined;
    }
  }

  storeWorkerConfig(config: ProjectWorkerConfig): void {
    const target = this.workerConfigPath(config.projectId);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    /* temp + rename: a crash can never leave a half-written config that a
       later hydration would parse as "no config" or, worse, as a truncated
       object. */
    const tmp = path.join(
      path.dirname(target),
      `.worker-config.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
    );
    fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, target);
  }

  /**
   * SE-F-057 — validate a worker-config change from an incoming payload
   * WITHOUT writing anything. Callers persist only after every other field
   * also validated, so a rejected edit can never corrupt the stored config.
   *
   * Merge semantics, deliberately documented for API consumers:
   *   - a payload with NO config keys (the legacy registration shape: only
   *     path/name/id/autoStart) requests no config change;
   *   - every config key the payload DOES carry is applied — plain objects
   *     merge per leaf, `null` clears a field back to its default;
   *   - identity (projectId/name/rootPath) and `autoStart` always come from
   *     the registry record, never from the config body.
   */
  validateIncomingWorkerConfig(
    record: { id: string; name: string; rootPath: string; autoStart: boolean },
    body: Record<string, unknown>
  ):
    | { readonly changed: false }
    | { readonly changed: true; readonly config: ProjectWorkerConfig }
    | { readonly changed: true; readonly error: string } {
    const CONFIG_KEYS = [
      'dataDir',
      'outOverride',
      'artifactLocation',
      'watch',
      'scan',
      'diagnostics',
      'cache',
      'indexing',
      'watchOptions',
      'service',
      'security',
      'embedding',
    ] as const;

    /* secrets must never reach the stored config, not even as a stray key */
    if ('token' in body || 'apiKey' in body) {
      return {
        changed: true,
        error:
          'a secret must not be part of the worker config; pass security.tokenEnvVar or embedding.apiKeyEnvVar instead',
      };
    }

    const provided = CONFIG_KEYS.filter(key => body[key] !== undefined);
    if (provided.length === 0) return { changed: false };

    const stored = this.loadStoredWorkerConfig(record.id);
    const base = createWorkerConfig({
      projectId: record.id,
      name: record.name,
      rootPath: record.rootPath,
      autoStart: record.autoStart,
      ...(stored ? (stored as never) : {}),
    } as never) as unknown as Record<string, unknown>;

    const merged: Record<string, unknown> = {
      ...base,
      projectId: record.id,
      name: record.name,
      rootPath: record.rootPath,
      autoStart: record.autoStart,
    };

    for (const key of provided) {
      const incoming = body[key];
      if (incoming === null) {
        delete merged[key];
        continue;
      }
      const current = merged[key];
      if (
        incoming !== null &&
        typeof incoming === 'object' &&
        !Array.isArray(incoming) &&
        current !== null &&
        typeof current === 'object' &&
        !Array.isArray(current)
      ) {
        const leaf: Record<string, unknown> = { ...(current as Record<string, unknown>) };
        for (const [k, v] of Object.entries(incoming as Record<string, unknown>)) {
          if (v === null) delete leaf[k];
          else leaf[k] = v;
        }
        merged[key] = leaf;
      } else {
        merged[key] = incoming;
      }
    }

    /* validate BEFORE storing: an invalid edit must leave the existing,
       working configuration intact. checkFileSystem:false because the
       registry already owns a canonical, existing root; a socket path
       inside that root is still rejected by the schema rules. */
    const validation = validateWorkerConfig(merged as never, { checkFileSystem: false });
    if (!validation.ok) {
      return { changed: true, error: validation.errors.join('; ') };
    }
    return { changed: true, config: validation.config };
  }

  configFor(projectId: string, rootPath: string, name: string): ProjectWorkerConfig {
    const stored = this.loadStoredWorkerConfig(projectId);
    if (stored) {
      /* identity always comes from the registry — a stored config can never
         redirect a project's worker to a different root or id. */
      const rebuilt = createWorkerConfig({ ...stored, projectId, name, rootPath });
      const validation = validateWorkerConfig(rebuilt as never, { checkFileSystem: true });
      if (validation.ok) return validation.config;
      /* the stored config became invalid against this root — fall through to
         the default so the worker still starts honestly. */
    }
    const config = createWorkerConfig({
      projectId,
      name,
      rootPath,
      watch: true,
      watchOptions: { skipInitialIndex: false },
    } as never);
    const validation = validateWorkerConfig(config as never, { checkFileSystem: true });
    if (!validation.ok) {
      throw new Error(validation.errors.join('; '));
    }
    return validation.config;
  }
}
