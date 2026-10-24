/**
 * The MCP source tools read indexed files straight from disk. Secrets and `.git` are indexed like
 * any other file, so the tools themselves must refuse them (the scanner cannot be trusted to).
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ProjectIndexReader } from '../ProjectIndexReader';
import { ProjectIndex } from '../../core/types/project-index.types';
import { CodeReadTool, SearchTextTool } from './Phase1ReadTools';
import { StructuralSearchTool } from './Phase2StructuralTools';
import { isDeniedPath } from '../../core/contracts/fileProvider';

const SECRET = 'API_KEY=supersecret123';

function fileEntry(id: string, filePath: string, language: string) {
  return {
    id, path: filePath, language, encoding: 'utf8', size: 40, lines: 2, hash: `h-${id}`,
    modified: '2026-01-01T00:00:00.000Z', binary: false, testFile: false, generated: false,
    symbolIds: [], imports: [], exports: [], diagnostics: [], outline: [],
  };
}

function index(rootPath: string): ProjectIndex {
  return {
    schemaVersion: '2.0.0', root: 'fixture', rootPath, generatedAt: '2026-01-01T00:00:00.000Z', languages: ['typescript'],
    files: [
      fileEntry('f1', 'src/a.ts', 'typescript'),
      fileEntry('f2', '.env', 'dotenv'),
      fileEntry('f3', 'certs/server.pem', 'text'),
      fileEntry('f4', '.git/config', 'text'),
    ],
    symbols: [], graphs: { callGraph: [], typeGraph: [], dependencyGraph: [] }, diagnostics: [],
  } as unknown as ProjectIndex;
}

describe('source tools refuse secrets and .git', () => {
  let root: string;
  let reader: ProjectIndexReader;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'se-denylist-'));
    await fs.mkdir(path.join(root, 'src'));
    await fs.mkdir(path.join(root, 'certs'));
    await fs.mkdir(path.join(root, '.git'));
    await fs.writeFile(path.join(root, 'src', 'a.ts'), `export const a = 1; // ${SECRET}\n`);
    await fs.writeFile(path.join(root, '.env'), `${SECRET}\n`);
    await fs.writeFile(path.join(root, 'certs', 'server.pem'), `${SECRET}\n`);
    await fs.writeFile(path.join(root, '.git', 'config'), `${SECRET}\n`);
    reader = new ProjectIndexReader(index(root));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each(['.env', 'certs/server.pem', '.git/config'])('code_read denies %s', async target => {
    const result = await new CodeReadTool(reader, root).execute({ path: target });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain('supersecret123');
    expect(result.error).toMatch(/denied/i);
  });

  it('code_read still reads ordinary source', async () => {
    const result = await new CodeReadTool(reader, root).execute({ path: 'src/a.ts' });
    expect(result.success).toBe(true);
  });

  it('search_text never returns a match from a denied file', async () => {
    const result = await new SearchTextTool(reader, root).execute({ query: 'API_KEY' });
    const paths = result.items.map(item => item.path);
    expect(paths).toEqual(['src/a.ts']);
  });

  it('structural_search never reads a denied file', async () => {
    const result = await new StructuralSearchTool(reader, root).execute({ pattern: 'API_KEY', language: 'typescript' });
    expect(JSON.stringify(result)).not.toMatch(/\.env|server\.pem|\.git\/config/);
  });

  it('isDeniedPath handles patterns, segments and Windows separators', () => {
    expect(isDeniedPath('.env')).toBe(true);
    expect(isDeniedPath('config/.env.production')).toBe(true);
    expect(isDeniedPath('keys\\id_rsa')).toBe(true);
    expect(isDeniedPath('a/.git/HEAD')).toBe(true);
    expect(isDeniedPath('src/environment.ts')).toBe(false);
  });
});
