/**
 * Phase 0 — the MCP serve path is fail-closed on the committed artifact pair.
 *
 * Publication writes `project-index.json` and `project-artifacts.manifest.json`
 * as two independent files, so a crash between them leaves a NEW index beside
 * an OLD digest. The HTTP path already refused to serve that pair; the MCP
 * path parsed it silently (SE-P0-PUB-01's consumer-visible half). This suite
 * drives the shipped server through the real read loop:
 *
 *   1. a coherent pair is served;
 *   2. a byte-drifting but VALID index whose digest no longer matches the
 *      committed manifest is never served — the last good snapshot stays
 *      active and `indexGeneration` does not move;
 *   3. a coherent republish (real `runIndex`, new generation) is picked up.
 *
 * `reloadFromDisk` is invoked directly rather than through the fs watcher:
 * the watcher has a 75ms debounce and depends on OS event delivery, both of
 * which make a failure look like a pass on a busy machine. The watcher→
 * scheduleReload wiring is unchanged; what is under test here is the read
 * gate itself.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SemanticEngineMcpServer } from './SemanticEngineMcpServer';
import { ProjectIndex } from '../../core/types/project-index.types';
import { parseArgs } from '../../cli/args';
import { runIndex } from '../../cli/commands/index-command';
import { createLoggerFromEnv } from '../../host/Logger';

interface FindSymbolAnswer {
  success: boolean;
  items: Array<{ name: string }>;
  indexGeneration?: number;
}

let base: string;
let workspace: string;
let dataDir: string;
let indexPath: string;

async function indexOnce(): Promise<void> {
  const result = await runIndex(
    parseArgs(['index', '--root', workspace, '--no-git', '--data-dir', dataDir, '--project-id', 'prj-app-12345678']),
    { cwd: workspace, logger: createLoggerFromEnv({ SEMANTIC_ENGINE_LOG_LEVEL: 'error' }, { stdio: true }) }
  );
  if (result.code !== 0) throw new Error(`index failed: ${result.error ?? result.code}`);
}

function loadIndex(): ProjectIndex {
  return JSON.parse(fs.readFileSync(indexPath, 'utf8')) as ProjectIndex;
}

function serverOn(projectIndex: ProjectIndex): SemanticEngineMcpServer {
  const server = new SemanticEngineMcpServer({
    projectIndex,
    workspaceRoot: workspace,
    projectId: 'prj-app-12345678',
    indexPath,
  });
  /*
  | reloadFromDisk از watchedIndexPath می‌خواند که فقط اینجا مقدار می‌گیرد؛
  | بدون این، reload یک no-op است و تست هیچ دری را ورزش نمی‌دهد.
  */
  server.watchIndexFile(indexPath);
  return server;
}

function reload(server: SemanticEngineMcpServer): void {
  (server as unknown as { reloadFromDisk(): void }).reloadFromDisk();
}

async function findSymbol(server: SemanticEngineMcpServer, name: string): Promise<FindSymbolAnswer> {
  const result = await server.callTool('find_symbol', { name } as never);
  return result.structuredContent as unknown as FindSymbolAnswer;
}

beforeEach(async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-mcp-integrity-')));
  workspace = path.join(base, 'workspace');
  dataDir = path.join(base, 'data');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'a.ts'), 'export function alpha(): number { return 1; }\n');
  fs.writeFileSync(
    path.join(workspace, 'src', 'b.ts'),
    "import { alpha } from './a';\nexport function beta(): number { return alpha(); }\n"
  );
  indexPath = path.join(dataDir, 'projects', 'prj-app-12345678', 'project-index.json');
  await indexOnce();
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('Phase 0 — MCP serve path never exposes a byte-mismatched index', () => {
  test('coherent pair served → torn pair refused → coherent republish picked up', async () => {
    const server = serverOn(loadIndex());
    try {
      const before = await findSymbol(server, 'beta');
      expect(before.success).toBe(true);
      expect(before.items.map(item => item.name)).toContain('beta');
      expect(server.indexGeneration).toBe(1);

      /*
      | کرشِ فرضی بین دو نوشتن: ایندکسِ جدیدِ معتبر (JSON قابل parse)
      | کنار manifestِ قدیمی. اگر مسیر MCP فقط parse می‌کرد، symbolِ
      | اسم‌عوض‌شده serve می‌شد.
      */
      const corrupted = loadIndex() as unknown as { symbols: Array<{ name: string }>; generatedAt: string };
      expect(corrupted.symbols.some(symbol => symbol.name === 'beta')).toBe(true);
      for (const symbol of corrupted.symbols) {
        if (symbol.name === 'beta') symbol.name = 'beta_corrupt';
      }
      corrupted.generatedAt = '2000-01-01T00:00:00.000Z';
      fs.writeFileSync(indexPath, JSON.stringify(corrupted));

      reload(server);

      const stillOld = await findSymbol(server, 'beta');
      expect(stillOld.items.map(item => item.name)).toContain('beta');
      const corruptServed = await findSymbol(server, 'beta_corrupt');
      expect(corruptServed.items).toHaveLength(0);
      expect(server.indexGeneration).toBe(1);

      /* انتشارِ سازگار بعدی: نسل ۲ با digest جدید — باید برداشته شود. */
      fs.writeFileSync(path.join(workspace, 'src', 'c.ts'), 'export function gamma(): number { return 3; }\n');
      await indexOnce();
      reload(server);

      const after = await findSymbol(server, 'gamma');
      expect(after.items.map(item => item.name)).toContain('gamma');
      expect(after.items.map(item => item.name)).not.toContain('beta_corrupt');
      expect(server.indexGeneration).toBe(2);
    } finally {
      await server.close();
    }
  });
});
