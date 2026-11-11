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
| A clone of a private repository would otherwise stop at a username prompt and
| sit there until the 120 s timeout, holding the request open.
*/
const gitEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
  GCM_INTERACTIVE: 'never',
});

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

/** First useful line of git's stderr, with any `user:password@` in the URL removed. */
function describeGitFailure(error: unknown, repo: URL): string {
  const err = error as { killed?: boolean; stderr?: string; message?: string };
  if (err.killed) return 'timed out';
  const text = String(err.stderr || err.message || 'unknown error');
  const line = text.split('\n').map(l => l.trim()).find(l => l !== '' && !l.startsWith('Cloning into')) ?? 'unknown error';
  const bare = new URL(repo.href);
  const secret = [repo.username, repo.password].filter(v => v !== '');
  bare.username = '';
  bare.password = '';
  let out = line.split(repo.href).join(bare.href);
  for (const value of secret) out = out.split(value).join('***');
  return out.slice(0, 300);
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
        /* no redirects (the host was vetted, a 302 target was not), no credential prompt, no file:// submodule tricks */
        '-c', 'http.followRedirects=false',
        '-c', 'protocol.file.allow=never',
        '-c', 'core.hooksPath=/dev/null',
        'clone',
        '--no-tags',
        ...(options.shallow === false ? [] : ['--depth', '1']),
        ...(options.branch ? ['--branch', options.branch] : []),
        '--',
        options.repoUrl,
        cloneDir,
      ];

      try {
        await execFileAsync('git', cloneArgs, {
          timeout,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true,
          env: gitEnv(),
        });
      } catch (error) {
        /* the remote refused, was unreachable or needs credentials: an upstream failure, not a server bug */
        throw new SourceValidationError(`git clone failed: ${describeGitFailure(error, repo)}`, 502);
      }

      if (options.commitHash) {
        await execFileAsync('git', ['-c', 'http.followRedirects=false', '-C', cloneDir, 'fetch', '--depth', '1', 'origin', options.commitHash], {
          timeout,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true,
          env: gitEnv(),
        });
        await execFileAsync('git', ['-C', cloneDir, 'checkout', '--detach', options.commitHash], {
          timeout,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true,
          env: gitEnv(),
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
