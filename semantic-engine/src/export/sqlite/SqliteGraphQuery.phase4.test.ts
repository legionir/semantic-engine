/** فاز ۴ — parity قراردادهای پیش‌فرض graph و سقف traversal. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SQLiteExporter } from '../SQLiteExporter';
import { openSqlite, SqliteDriver } from './SqliteDriver';
import { SqliteGraphQuery } from './SqliteGraphQuery';
import { ProjectIndex } from '../../core/types/project-index.types';
import { provenanceFor } from '../../graphs/EdgeProvenance';

let directory: string;
let db: SqliteDriver | null = null;

function fixture(): ProjectIndex {
  const edge = (from: string, to: string) => ({
    from,
    to,
    kind: 'import' as const,
    provenance: {
      ...provenanceFor('import-resolved', 'typescript-api', { file: `${from}.ts`, line: 1 }),
      confidence: 90,
    },
  });
  return {
    schemaVersion: '2.0.0',
    root: 'phase4',
    rootPath: '/tmp/phase4',
    generatedAt: new Date().toISOString(),
    languages: ['typescript'],
    files: [],
    symbols: [],
    graphs: {
      dependencyGraph: [edge('a', 'b'), edge('b', 'c')],
      callGraph: [],
      typeGraph: [],
      reverseDependencyGraph: [],
    },
    diagnostics: [],
    metrics: { totalFiles: 0, totalLoc: 0, totalSymbols: 0, avgCyclomaticComplexity: 0, languageBreakdown: {} },
  } as unknown as ProjectIndex;
}

beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'se-graph-phase4-')); });
afterEach(async () => {
  if (db) await db.close();
  db = null;
  fs.rmSync(directory, { recursive: true, force: true });
});

async function openQuery(): Promise<SqliteGraphQuery> {
  const dbPath = path.join(directory, 'index.sqlite');
  await new SQLiteExporter().export(fixture(), { outputPath: dbPath });
  db = await openSqlite(dbPath);
  return new SqliteGraphQuery(db);
}

describe('SqliteGraphQuery — phase 4 defaults and bounds', () => {
  it('uses the same default direction as GraphQueryEngine', async () => {
    const query = await openQuery();
    expect((await query.neighbors('b')).nodes.map(node => node.id)).toEqual(['c']);
    expect(await query.path('b', 'a')).toEqual({ path: null, confident: false, weakestLink: 0 });
  });

  it('enforces maxNodes and reports truncation at zero', async () => {
    const query = await openQuery();
    const result = await query.neighbors('a', { maxNodes: 0, minConfidence: 0 });
    expect(result.nodes).toEqual([]);
    expect(result.truncated).toBe(true);
  });

  it('rejects invalid traversal bounds instead of generating unbounded SQL', async () => {
    const query = await openQuery();
    await expect(query.neighbors('a', { maxNodes: -1 })).rejects.toThrow(/maxNodes/);
    await expect(query.path('a', 'b', { depth: -1 })).rejects.toThrow(/depth/);
  });
});
