/**
 * فاز ۷, گام ۳/۴ — `indexGeneration` across the package boundary.
 *
 * The consumer already implemented its half of this protocol:
 * `structured-ai/agent/mcp/SemanticClient.js` reads `indexGeneration` from an
 * unpacked tool result and drops its whole cache when it changes. Until now the
 * engine emitted nothing, so the value was always `null` and caching stayed off.
 *
 * These tests run both halves for real:
 *
 *   1. `OutputWriter` bumps a monotonic counter in the artifact manifest;
 *   2. `SemanticEngineMcpServer` publishes it (and `projectId`) in
 *      `structuredContent`, leaving `content` untouched;
 *   3. the shipped `unpackToolResult` + `trackGeneration` from the *other*
 *      package see it and invalidate their cache.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MANIFEST_FILE_NAME } from '../../pipeline/OutputWriter';
import { SemanticEngineMcpServer } from './SemanticEngineMcpServer';
import { parseIndexGeneration } from '../../core/config/indexGeneration';
import { ProjectIndex } from '../../core/types/project-index.types';
import { parseArgs } from '../../cli/args';
import { createLoggerFromEnv } from '../../host/Logger';
import { runIndex } from '../../cli/commands/index-command';

/*
| The consumer package lives in a different repository. `STRUCTURED_AI_ROOT` points at
| its `structured-ai` folder (CI checks the repository out beside this one); without it
| the old monorepo layout is tried, and the suite skips when nothing is found.
*/
const CONSUMER_ROOT =
  process.env['STRUCTURED_AI_ROOT'] || path.join(__dirname, '..', '..', '..', '..', 'structured-ai');
const codecPath = path.join(CONSUMER_ROOT, 'agent', 'mcp', 'protocol', 'JsonRpcCodec.js');
const clientPath = path.join(CONSUMER_ROOT, 'agent', 'mcp', 'SemanticClient.js');
const codecAvailable = fs.existsSync(codecPath);
const clientAvailable = fs.existsSync(clientPath);

const codec = codecAvailable
  ? (require(codecPath) as { unpackToolResult: (result: unknown) => unknown })
  : null;
const semanticClient = clientAvailable
  ? (require(clientPath) as {
      prototype: { trackGeneration: (this: unknown, result: unknown) => void };
    })
  : null;

/**
 * یک ایندکس واقعی، از خودِ `runIndex` — نه یک آبجکت دست‌ساز، چون
 * `OutputWriter` خروجی را با schema می‌سنجد و یک نمونهٔ ناقص یعنی تستی که
 * چیز دیگری را اندازه می‌گیرد.
 */
async function indexOnce(root: string, dataDir: string): Promise<void> {
  const result = await runIndex(
    parseArgs(['index', '--root', root, '--no-git', '--data-dir', dataDir, '--project-id', 'prj-app-12345678']),
    { cwd: root, logger: createLoggerFromEnv({ SEMANTIC_ENGINE_LOG_LEVEL: 'error' }, { stdio: true }) }
  );
  if (result.code !== 0) throw new Error(`index failed: ${result.error ?? result.code}`);
}

const describeIfConsumer = codecAvailable && clientAvailable ? describe : describe.skip;

describe('indexGeneration — written, published, consumed', () => {
  let base: string;
  let artifactRoot: string;

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-generation-')));
    fs.mkdirSync(path.join(base, 'workspace', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(base, 'workspace', 'src', 'a.ts'),
      'export function a(): number { return 1; }\n'
    );
    artifactRoot = path.join(base, 'data', 'projects', 'prj-app-12345678');
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  const workspace = (): string => path.join(base, 'workspace');

  const writeOnce = async (): Promise<void> => {
    await indexOnce(workspace(), path.join(base, 'data'));
  };

  const readManifest = (): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(path.join(artifactRoot, MANIFEST_FILE_NAME), 'utf8')) as Record<
      string,
      unknown
    >;

  it('starts at 1 and increments on every write', async () => {
    await writeOnce();
    expect(parseIndexGeneration(readManifest())).toBe(1);

    await writeOnce();
    expect(parseIndexGeneration(readManifest())).toBe(2);

    await writeOnce();
    expect(parseIndexGeneration(readManifest())).toBe(3);
  });

  it('publishes projectId and indexGeneration without changing content', async () => {
    await writeOnce();
    const indexPath = path.join(artifactRoot, 'project-index.json');
    const projectIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as ProjectIndex;

    const server = new SemanticEngineMcpServer({
      projectIndex,
      workspaceRoot: workspace(),
      projectId: 'prj-app-12345678',
      indexPath,
    });

    expect(server.indexGeneration).toBe(1);

    const result = await server.callTool('find_symbol', { name: 'a' });
    const text = JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;
    const structured = result.structuredContent as Record<string, unknown>;

    /* content is exactly what it always was … */
    expect(text['success']).toBe(true);
    /* … and structuredContent carries the same payload plus the two markers. */
    expect(structured['success']).toBe(true);
    expect(structured['projectId']).toBe('prj-app-12345678');
    expect(structured['indexGeneration']).toBe(1);
    expect(structured['items']).toEqual(text['items']);

    await server.close();
  });

  it('falls back to generation 0 for an index that predates this phase', async () => {
    await writeOnce();
    const indexPath = path.join(artifactRoot, 'project-index.json');
    /* manifest حذف می‌شود تا ایندکسِ پیش از فاز ۷ شبیه‌سازی شود. */
    fs.rmSync(path.join(artifactRoot, MANIFEST_FILE_NAME));

    const server = new SemanticEngineMcpServer({
      projectIndex: JSON.parse(fs.readFileSync(indexPath, 'utf8')) as ProjectIndex,
      workspaceRoot: workspace(),
      projectId: 'prj-app-12345678',
      indexPath,
    });

    expect(server.indexGeneration).toBe(0);
    await server.close();
  });

  describeIfConsumer('the shipped consumer understands it', () => {
    it('unpacks structuredContent and invalidates its cache when the generation moves', async () => {
      await writeOnce();
      const indexPath = path.join(artifactRoot, 'project-index.json');
      const server = new SemanticEngineMcpServer({
        projectIndex: JSON.parse(fs.readFileSync(indexPath, 'utf8')) as ProjectIndex,
        workspaceRoot: workspace(),
        projectId: 'prj-app-12345678',
        indexPath,
      });

      const first = await server.callTool('find_symbol', { name: 'a' });

      /* The consumer's real codec: structuredContent wins over the text. */
      const unpacked = codec!.unpackToolResult(first) as Record<string, unknown>;
      expect(unpacked['indexGeneration']).toBe(1);
      expect(unpacked['projectId']).toBe('prj-app-12345678');

      /*
      | The consumer's real `trackGeneration`, called on a stand-in `this` so
      | the test does not have to construct a whole MCP client. The function
      | body is the shipped one; only its three fields are provided.
      */
      const consumerThis = {
        indexGeneration: null as number | null,
        resultCache: new Map<string, unknown>([['cached', { stale: true }]]),
        client: { toolsLoadedAt: 12345 as number | null },
      };

      semanticClient!.prototype.trackGeneration.call(consumerThis, unpacked);
      expect(consumerThis.indexGeneration).toBe(1);
      /* First sighting only records the generation; the cache was already empty
         of anything belonging to it. */
      expect(consumerThis.resultCache.size).toBe(0);

      consumerThis.resultCache.set('cached-again', { stale: true });
      consumerThis.client.toolsLoadedAt = 999;

      /*
      | The whole loop, for real: the writer bumps the manifest counter, the
      | server reloads (as its file watcher would) and republishes the new
      | generation, and the consumer drops everything it had cached.
      */
      await writeOnce();
      expect(parseIndexGeneration(readManifest())).toBe(2);

      server.reload(JSON.parse(fs.readFileSync(indexPath, 'utf8')) as ProjectIndex);
      expect(server.indexGeneration).toBe(2);

      const after = await server.callTool('find_symbol', { name: 'a' });
      const unpackedAfter = codec!.unpackToolResult(after) as Record<string, unknown>;
      expect(unpackedAfter['indexGeneration']).toBe(2);

      semanticClient!.prototype.trackGeneration.call(consumerThis, unpackedAfter);
      expect(consumerThis.indexGeneration).toBe(2);
      expect(consumerThis.resultCache.size).toBe(0);
      expect(consumerThis.client.toolsLoadedAt).toBeNull();

      await server.close();
    });
  });
});
