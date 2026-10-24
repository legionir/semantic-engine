/**
 * Detects whether a directory lives on a network file system (Linux: /proc/mounts).
 *
 * The data directory is protected by exclusive-create lock files and atomic renames. Those hold on a
 * local disk; on NFS/SMB and friends they are not guaranteed across hosts, so the supported
 * topology is one host per data directory (D-0031). This only warns — it never blocks.
 */

import * as fs from 'fs';
import * as path from 'path';

const NETWORK_FS_TYPES: ReadonlySet<string> = new Set([
  'nfs', 'nfs3', 'nfs4', 'cifs', 'smb', 'smb3', 'smbfs', 'afs', 'ceph', 'glusterfs', '9p',
  'fuse.sshfs', 'fuse.glusterfs', 'fuse.cephfs',
]);

/** The file system type holding `dir` according to a `/proc/mounts` body, or `null` when unknown. */
export function filesystemTypeFromMounts(mounts: string, dir: string): string | null {
  let best: { mountPoint: string; type: string } | null = null;
  for (const line of mounts.split('\n')) {
    const fields = line.split(' ');
    if (fields.length < 3) continue;
    const mountPoint = fields[1]!.replace(/\\040/g, ' ');
    const inside = dir === mountPoint || dir.startsWith(mountPoint.endsWith('/') ? mountPoint : `${mountPoint}/`);
    if (inside && (!best || mountPoint.length >= best.mountPoint.length)) {
      best = { mountPoint, type: fields[2]! };
    }
  }
  return best ? best.type : null;
}

/** Returns the network file system type of `dir` (e.g. `nfs4`), or `null` for local/unknown. */
export function networkFilesystemOf(dir: string, mountsText?: string): string | null {
  try {
    const mounts = mountsText ?? fs.readFileSync('/proc/mounts', 'utf8');
    let resolved = path.resolve(dir);
    try { resolved = fs.realpathSync(resolved); } catch { /* not created yet: use the lexical path */ }
    const type = filesystemTypeFromMounts(mounts, resolved);
    return type && NETWORK_FS_TYPES.has(type) ? type : null;
  } catch {
    return null;
  }
}

export function networkFilesystemWarning(dir: string, type: string): string {
  return `data directory ${dir} is on a network file system (${type}); lock files and atomic renames are not guaranteed across hosts — use a local disk and one host per data directory`;
}
