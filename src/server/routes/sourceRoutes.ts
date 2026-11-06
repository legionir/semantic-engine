/**
 * sourceRoutes — REST Endpoints for Multi-Environment Source Synchronization (Domain 05).
 */

import * as fs from 'fs';
import { RouteDefinition, HttpRequestContext } from '../types';
import { ProjectInputError, ProjectService } from '../../services/ProjectService';
import { SourceSyncService, SourceValidationError } from '../../services/source/SourceSyncService';

/*
| SE-API-002 — a rejected request must be answered with its own status.
| SourceSyncService now throws SourceValidationError (status 400 by default)
| for every input/size/security rejection; without this map they would fall
| through to HttpServer's global handler and surface as HTTP 500 — a wrong
| fact for a consuming AI or client ("the server broke" vs "the request was
| invalid"). Anything else keeps its previous 500 behavior.
*/
function syncFailure(error: unknown): { status: number; json: { error: string } } {
  if (error instanceof SourceValidationError) {
    return { status: error.status, json: { error: error.message } };
  }
  throw error;
}

export function createSourceRoutes(
  projectService: ProjectService,
  sourceSyncService: SourceSyncService
): RouteDefinition[] {
  const syncGitHandler = async (ctx: HttpRequestContext) => {
    const projectId = ctx.params.id;
    const project = projectService.getProject(projectId);
    if (!project) return { status: 404, json: { error: `Project '${projectId}' not found` } };

    const body = (ctx.body || {}) as { repoUrl?: string; branch?: string; commitHash?: string };
    if (!body.repoUrl) return { status: 400, json: { error: 'repoUrl is required for Git sync' } };

    try {
      const result = await sourceSyncService.syncFromGit(projectId, project.rootPath, {
        repoUrl: body.repoUrl,
        branch: body.branch,
        commitHash: body.commitHash,
      });
      return { status: 200, json: result };
    } catch (error) {
      return syncFailure(error);
    }
  };

  const uploadHandler = async (ctx: HttpRequestContext) => {
    const projectId = ctx.params.id;
    const project = projectService.getProject(projectId);
    if (!project) return { status: 404, json: { error: `Project '${projectId}' not found` } };

    const body = (ctx.body || {}) as { files?: Record<string, string> };
    if (!body.files || Object.keys(body.files).length === 0) {
      return { status: 400, json: { error: 'files payload is required' } };
    }

    try {
      const result = await sourceSyncService.importBundle(projectId, project.rootPath, body.files);
      return { status: 200, json: result };
    } catch (error) {
      return syncFailure(error);
    }
  };

  /*
  | Registering first is what gives the bundle a root to land in, but a bundle
  | that is then rejected (path traversal, size, binary extension) must not
  | leave a registered, empty project behind.
  */
  const importBundleAsNewProject = async (
    projectId: string,
    name: string | undefined,
    files: Record<string, string>
  ): Promise<{ status: number; json: unknown }> => {
    let root: string;
    try {
      root = projectService.importRootFor(projectId);
    } catch (error) {
      if (error instanceof ProjectInputError) return { status: 400, json: { error: error.message } };
      throw error;
    }

    const existedBefore = Boolean(projectService.getProject(projectId));
    /* a registry refuses a root that does not exist yet, so the folder comes first */
    const createdRoot = !fs.existsSync(root);
    fs.mkdirSync(root, { recursive: true });
    const project = projectService.registerProject(root, projectId, name || projectId);
    try {
      const result = await sourceSyncService.importBundle(project.id, project.rootPath, files);
      return { status: 201, json: { project, syncResult: result } };
    } catch (error) {
      if (!existedBefore) projectService.removeProject(project.id);
      if (createdRoot) {
        try {
          fs.rmSync(root, { recursive: true, force: true });
        } catch {
          /* leaving an empty folder is harmless */
        }
      }
      return syncFailure(error);
    }
  };

  return [
    { method: 'POST', pattern: '/api/v1/projects/:id/source/sync', requireAuth: true, permission: 'project:write', handler: syncGitHandler },
    { method: 'POST', pattern: '/api/v2/projects/:id/source/sync-git', requireAuth: true, permission: 'project:write', handler: syncGitHandler },
    { method: 'POST', pattern: '/api/v1/projects/:id/source/upload', requireAuth: true, permission: 'project:write', handler: uploadHandler },
    { method: 'POST', pattern: '/api/v2/projects/:id/source/upload', requireAuth: true, permission: 'project:write', handler: uploadHandler },
    {
      method: 'PUT',
      pattern: '/api/v1/projects/:id/files/:filePath',
      requireAuth: true,
      permission: 'project:write',
      handler: async ctx => {
        const projectId = ctx.params.id;
        const project = projectService.getProject(projectId);
        if (!project) return { status: 404, json: { error: `Project '${projectId}' not found` } };

        const filePath = ctx.params.filePath;
        const body = (ctx.body || {}) as { content?: unknown };
        /* a body without `content` used to blank the file: `'' ` is only valid when sent on purpose */
        if (typeof body.content !== 'string') {
          return { status: 400, json: { error: 'content (string) is required' } };
        }
        const content = body.content;

        try {
          const result = await sourceSyncService.importBundle(projectId, project.rootPath, { [filePath]: content });
          return { status: 200, json: { updated: true, file: filePath, result } };
        } catch (error) {
          return syncFailure(error);
        }
      },
    },
    {
      method: 'POST',
      pattern: '/api/v1/projects/import-bundle',
      requireAuth: true,
      permission: 'project:admin',
      handler: async ctx => {
        const body = (ctx.body || {}) as { projectId?: string; name?: string; files?: Record<string, string> };
        if (!body.projectId || !body.files) {
          return { status: 400, json: { error: 'projectId and files are required' } };
        }
        return importBundleAsNewProject(body.projectId, body.name, body.files);
      },
    },
    {
      method: 'POST',
      pattern: '/api/v2/projects/import-bundle',
      requireAuth: true,
      permission: 'project:admin',
      handler: async ctx => {
        const body = (ctx.body || {}) as { projectId?: string; name?: string; files?: Record<string, string> };
        if (!body.projectId || !body.files) {
          return { status: 400, json: { error: 'projectId and files are required' } };
        }
        return importBundleAsNewProject(body.projectId, body.name, body.files);
      },
    },
  ];
}
