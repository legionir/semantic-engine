import { filesystemTypeFromMounts, networkFilesystemOf, networkFilesystemWarning } from './networkFilesystem';

const MOUNTS = [
  'overlay / overlay rw 0 0',
  'srv:/export /mnt/shared nfs4 rw 0 0',
  '/dev/sda1 /mnt/shared/local ext4 rw 0 0',
  '//nas/team /mnt/with\\040space cifs rw 0 0',
].join('\n');

describe('networkFilesystem', () => {
  it('picks the longest matching mount point', () => {
    expect(filesystemTypeFromMounts(MOUNTS, '/mnt/shared/data')).toBe('nfs4');
    expect(filesystemTypeFromMounts(MOUNTS, '/mnt/shared/local/data')).toBe('ext4');
    expect(filesystemTypeFromMounts(MOUNTS, '/home/u/data')).toBe('overlay');
  });

  it('does not treat a sibling with the same prefix as inside the mount', () => {
    expect(filesystemTypeFromMounts(MOUNTS, '/mnt/shared2/x')).toBe('overlay');
  });

  it('reports only network types', () => {
    expect(networkFilesystemOf('/mnt/shared/data', MOUNTS)).toBe('nfs4');
    expect(networkFilesystemOf('/mnt/shared/local/data', MOUNTS)).toBeNull();
    expect(networkFilesystemOf('/mnt/with space/data', MOUNTS)).toBe('cifs');
  });

  it('never throws when /proc/mounts is unavailable', () => {
    expect(networkFilesystemOf('/nonexistent/dir')).toBeNull();
    expect(networkFilesystemWarning('/d', 'nfs4')).toContain('one host per data directory');
  });
});
