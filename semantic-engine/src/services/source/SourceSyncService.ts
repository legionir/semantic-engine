/**
 * SourceSyncService — Manages synchronization with Git repositories, remote ZIP bundles, and Object Storage.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { SourceSecurityGuard } from './SourceSecurityGuard';
import { assertResolvedFetchableUrl } from '../providers/EmbeddingProviderService';

const execFileAsync = promisify(execFile);

/*
| SE-API-002 — a rejected request is a client error, not a server fault.
| The service used to throw plain `Error` for bad input (invalid repoUrl,
| unsupported protocol, malformed commitHash, oversized bundle, path-traversal
| file names); the route did not catch them, so HttpServer's global handler
| answered HTTP 500. A 500 tells a consuming AI / client "the server broke",
| which is the wrong fact — the request was simply invalid, and the correct
| response is 400. This error carries the intended status so the route can
| honour it instead of masking a validation failure as an infrastructure
| failure (§15: an error must not be presented as a different result).
*/
export class SourceValidationError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'SourceValidationError';
    this.status = status;
  }
}

export interface GitSyncOptions {
  readonly repoUrl: string;
  readonly branch?: string;
  readonly shallow?: boolean;
  readonly commitHash?: string;
}

export interface SyncResult {
  readonly projectId: string;
  readonly source: 'local' | 'git' | 'bundle';
  readonly filesSynced: number;
  readonly totalBytes: number;
  readonly timestamp: number;
  readonly commitHash?: string;
}

export class SourceSyncService {
  private readonly guard = new SourceSecurityGuard();

  async syncFromLocal(projectId: string, projectRoot: string): Promise<SyncResult> {
    if (!fs.existsSync(projectRoot)) {
      throw new Error(`Project root does not exist: ${projectRoot}`);
    }

    let filesSynced = 0;
    let totalBytes = 0;

    const traverse = (dir: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue;
        const fullPath = path.join(dir, entry.name);
        const rel = path.relative(projectRoot, fullPath);

        const check = this.guard.validateRelativePath(projectRoot, rel);
        if (!check.ok) continue;

        if (entry.isDirectory()) {
          traverse(fullPath);
        } else if (entry.isFile()) {
          const stat = fs.statSync(fullPath);
          if (this.guard.validateFileSize(stat.size).ok) {
            filesSynced++;
            totalBytes += stat.size;
          }
        }
      }
    };

    traverse(projectRoot);

    return {
      projectId,
      source: 'local',
      filesSynced,
      totalBytes,
      timestamp: Date.now(),
    };
  }

  async syncFromGit(projectId: string, targetDir: string, options: GitSyncOptions): Promise<SyncResult> {
    let repo: URL;
    try {
      repo = new URL(options.repoUrl);
    } catch {
      throw new SourceValidationError('repoUrl must be a valid HTTPS or HTTP URL.');
    }

    if (!['https:', 'http:'].includes(repo.protocol)) {
      throw new SourceValidationError(`Unsupported Git URL protocol: ${repo.protocol}`);
    }

    if (options.branch && !/^[A-Za-z0-9._/-]+$/.test(options.branch)) {
      throw new SourceValidationError('branch contains unsupported characters.');
    }

    if (options.commitHash && !/^[0-9a-f]{7,64}$/i.test(options.commitHash)) {
      throw new SourceValidationError('commitHash must be a hexadecimal Git commit id.');
    }

    /*
    | F-0024: repoUrl is request-supplied and git-http reaches the network. The
    | protocol allowlist above already blocks ext::/file::/ssh RCE; additionally
    | resolve the host and reject link-local/private/cloud-metadata (localhost is
    | allowed) so a clone can't be aimed at internal endpoints. This mirrors the
    | egress guard used for providers/chat.
    */
    await assertResolvedFetchableUrl(options.repoUrl);

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const checkoutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-git-'));
    const cloneDir = path.join(checkoutDir, 'checkout');
    const timeout = 120_000;

    try {
      const cloneArgs = [
        'clone',
        '--no-tags',
        ...(options.shallow === false ? [] : ['--depth', '1']),
        ...(options.branch ? ['--branch', options.branch] : []),
        options.repoUrl,
        cloneDir,
      ];

      await execFileAsync('git', cloneArgs, {
        timeout,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      });

      if (options.commitHash) {
        await execFileAsync('git', ['-C', cloneDir, 'fetch', '--depth', '1', 'origin', options.commitHash], {
          timeout,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true,
        });
        await execFileAsync('git', ['-C', cloneDir, 'checkout', '--detach', options.commitHash], {
          timeout,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true,
        });
      }

      const head = await execFileAsync('git', ['-C', cloneDir, 'rev-parse', 'HEAD'], {
        timeout: 15_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      });
      const commitHash = head.stdout.trim();

      const backupDir = path.join(checkoutDir, 'target-backup');
      const backups = new Map<string, string>();
      const committed: string[] = [];
      const sourceEntries = fs.readdirSync(cloneDir)
        .filter(name => !['.git', '.agent', '.semantic-engine'].includes(name));
      const syncData = {
        projectId,
        repoUrl: options.repoUrl,
        branch: options.branch || null,
        syncedAt: Date.now(),
        commitHash,
      };

      try {
        for (const name of sourceEntries) {
          const source = path.join(cloneDir, name);
          const destination = path.join(targetDir, name);
          if (fs.existsSync(destination)) {
            const backup = path.join(backupDir, name);
            fs.mkdirSync(path.dirname(backup), { recursive: true });
            fs.cpSync(destination, backup, { recursive: true, dereference: false });
            backups.set(destination, backup);
          }
          fs.rmSync(destination, { recursive: true, force: true });
          fs.cpSync(source, destination, { recursive: true, force: true, dereference: false });
          committed.push(destination);
        }

        const metaFile = path.join(targetDir, '.git_sync_meta.json');
        const previousMeta = path.join(backupDir, '.git_sync_meta.json');
        if (fs.existsSync(metaFile)) {
          fs.mkdirSync(backupDir, { recursive: true });
          fs.copyFileSync(metaFile, previousMeta);
          backups.set(metaFile, previousMeta);
        }
        fs.writeFileSync(metaFile, JSON.stringify(syncData, null, 2), 'utf8');
        committed.push(metaFile);
      } catch (error) {
        for (const destination of committed.reverse()) {
          try {
            fs.rmSync(destination, { recursive: true, force: true });
            const backup = backups.get(destination);
            if (backup && fs.existsSync(backup)) {
              fs.cpSync(backup, destination, { recursive: true, dereference: false });
            }
          } catch {
            /* retain the original failure; caller must alert on rollback failure */
          }
        }
        throw error;
      }

      let filesSynced = 1;
      let totalBytes = Buffer.byteLength(JSON.stringify(syncData), 'utf8');
      const countFiles = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (['.git', '.agent', '.semantic-engine'].includes(entry.name)) continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) countFiles(full);
          else if (entry.isFile()) {
            filesSynced++;
            totalBytes += fs.statSync(full).size;
          }
        }
      };
      countFiles(targetDir);

      return {
        projectId,
        source: 'git',
        filesSynced,
        totalBytes,
        timestamp: Date.now(),
        commitHash,
      };
    } finally {
      fs.rmSync(checkoutDir, { recursive: true, force: true });
    }
  }

  async importBundle(projectId: string, targetDir: string, files: Record<string, string>): Promise<SyncResult> {
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const entries = Object.entries(files);
    if (entries.length === 0) {
      throw new SourceValidationError('Bundle must contain at least one file.');
    }

    const prepared: Array<{ relPath: string; content: string; dest: string }> = [];
    let totalBytes = 0;

    /* Validate every path and the whole payload before changing the target. */
    for (const [relPath, content] of entries) {
      if (typeof content !== 'string') {
        throw new SourceValidationError(`Bundle file '${relPath}' must contain text content.`);
      }

      const check = this.guard.validateRelativePath(targetDir, relPath);
      if (!check.ok) {
        throw new SourceValidationError(`Security violation for bundle file '${relPath}': ${check.reason}`);
      }

      const bytes = Buffer.byteLength(content, 'utf8');
      const fileLimit = this.guard.validateFileSize(bytes);
      if (!fileLimit.ok) {
        throw new SourceValidationError(`Security violation for bundle file '${relPath}': ${fileLimit.reason}`);
      }

      totalBytes += bytes;
      prepared.push({ relPath, content, dest: check.resolvedPath! });
    }

    const totalLimit = this.guard.validateTotalSize(totalBytes);
    if (!totalLimit.ok) {
      throw new SourceValidationError(`Security violation for bundle: ${totalLimit.reason}`);
    }

    const stageDir = fs.mkdtempSync(path.join(targetDir, '.source-sync-'));
    const backups = new Map<string, string>();
    const committed: string[] = [];

    try {
      for (const item of prepared) {
        const staged = path.join(stageDir, item.relPath);
        const stagedParent = path.dirname(staged);
        fs.mkdirSync(stagedParent, { recursive: true });
        fs.writeFileSync(staged, item.content, 'utf8');
      }

      for (const item of prepared) {
        const staged = path.join(stageDir, item.relPath);
        const parentDir = path.dirname(item.dest);
        fs.mkdirSync(parentDir, { recursive: true });

        if (fs.existsSync(item.dest)) {
          const backup = path.join(stageDir, `${item.relPath}.backup`);
          fs.mkdirSync(path.dirname(backup), { recursive: true });
          fs.copyFileSync(item.dest, backup);
          backups.set(item.dest, backup);
        }

        fs.renameSync(staged, item.dest);
        committed.push(item.dest);
      }
    } catch (error) {
      /* Best-effort rollback keeps a failed bundle from leaving a half update. */
      for (const dest of committed.reverse()) {
        const backup = backups.get(dest);
        try {
          if (backup && fs.existsSync(backup)) {
            fs.renameSync(backup, dest);
          } else if (fs.existsSync(dest)) {
            fs.unlinkSync(dest);
          }
        } catch {
          /* surface the original error; recovery is reported by the caller */
        }
      }
      throw error;
    } finally {
      fs.rmSync(stageDir, { recursive: true, force: true });
    }

    return {
      projectId,
      source: 'bundle',
      filesSynced: prepared.length,
      totalBytes,
      timestamp: Date.now(),
    };
  }
}
