import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  canonicalIndexPath,
  indexPathCandidates,
  normalizeWorkspaceRoot,
  resolveProjectIndexPath,
  workspaceRootFromIndex,
  workspaceRootFromIndexPath,
} from './ProjectPaths';

describe('ProjectPaths — one canonical workspace/artifact layout', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'se-project-paths-'));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('normalizes runtime and artifact directories to the project root', () => {
    expect(normalizeWorkspaceRoot(workspace)).toBe(workspace);
    expect(normalizeWorkspaceRoot(path.join(workspace, '.agent'))).toBe(workspace);
    expect(normalizeWorkspaceRoot(path.join(workspace, '.semantic-engine'))).toBe(workspace);
    expect(normalizeWorkspaceRoot(path.join(workspace, '.agent', 'semantic'))).toBe(workspace);
  });

  it('uses .semantic-engine as the only new output location', () => {
    expect(canonicalIndexPath(workspace)).toBe(
      path.join(workspace, '.semantic-engine', 'project-index.json')
    );
    expect(indexPathCandidates(workspace)[0]).toBe(canonicalIndexPath(workspace));

    expect(normalizeWorkspaceRoot(path.join(workspace, 'semantic'))).toBe(
      path.join(workspace, 'semantic')
    );
  });

  it('finds a legacy index without changing the canonical destination', () => {
    const legacy = path.join(workspace, '.agent', 'semantic');
    fs.mkdirSync(legacy, { recursive: true });
    const legacyIndex = path.join(legacy, 'project-index.json');
    fs.writeFileSync(legacyIndex, '{}');

    expect(resolveProjectIndexPath(workspace)).toBe(legacyIndex);
    expect(canonicalIndexPath(workspace)).not.toBe(legacyIndex);

    fs.rmSync(legacy, { recursive: true, force: true });
    const flat = path.join(workspace, 'semantic');
    fs.mkdirSync(flat, { recursive: true });
    const flatIndex = path.join(flat, 'project-index.json');
    fs.writeFileSync(flatIndex, '{}');
    expect(resolveProjectIndexPath(workspace)).toBe(flatIndex);
    expect(normalizeWorkspaceRoot(flat)).toBe(workspace);
  });

  it('recovers the root from canonical and legacy index paths', () => {
    const canonical = canonicalIndexPath(workspace);
    const legacy = path.join(workspace, '.agent', 'semantic', 'project-index.json');

    expect(workspaceRootFromIndexPath(canonical)).toBe(workspace);
    expect(workspaceRootFromIndexPath(legacy)).toBe(workspace);
    expect(workspaceRootFromIndex({ rootPath: path.join(workspace, '.agent') }, canonical)).toBe(workspace);
  });
});
