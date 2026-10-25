/**
 * Band 8 — LSP Isolation across workers and projects — بند ۸ چک‌لیست پذیرش (§۶).
 *
 * Dedicated tests proving that language server processes (LSP) running for
 * different workers/projects are fully isolated:
 *
 *   1. Process & Instance Isolation: each worker spawns and manages its own
 *      distinct LSP child process (different PIDs, independent lifecycles).
 *   2. Document & URI Scope Isolation: documents and change events opened in
 *      Project A are seen only by Server A; Server B never sees Project A's
 *      files or URIs.
 *   3. Extraction, Diagnostics & Interactive Ops Isolation: symbols, diagnostics,
 *      and interactive operations are project-scoped.
 *   4. Fault & Crash Isolation: crashing or degrading Server A leaves Server B
 *      100% healthy, responsive, and untouched.
 *   5. Resource Management & Reap Isolation: memory enforcement or idle reaping
 *      in Worker A does not affect Worker B.
 *   6. Lifecycle & Teardown Isolation: disposing Worker A stops only Server A;
 *      Server B stays alive until Worker B is disposed.
 *   7. Concurrent Pipeline Isolation: two concurrent IndexPipelines with LSP
 *      extractors run in parallel without crosstalk or lock contention.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LspClient } from '../lsp/LspClient';
import { LspServerManager } from '../lsp/LspServerManager';
import { LspServerRegistry, LspServerSpec } from '../lsp/registry';
import { LspSymbolExtractor } from '../symbols/lsp/LspSymbolExtractor';
import { DiagnosticsProvider } from '../lsp/DiagnosticsProvider';
import { InteractiveOps } from '../lsp/InteractiveOps';
import { createExtractors } from '../pipeline/ExtractorFactory';
import { IndexPipeline } from '../pipeline/IndexPipeline';
import { CapabilityProbe } from '../lsp/CapabilityProbe';

const FAKE_SERVER = path.join(__dirname, '..', 'lsp', '__fixtures__', 'fakeLspServer.js');

interface FakeServerState {
  counts: Record<string, number>;
  initialized: boolean;
  openDocuments: { uri: string; version: number; languageId: string }[];
  closed: string[];
}

describe('Band 8 — LSP Isolation across workers and projects (بند ۸ — جداسازی LSP)', () => {
  let baseDir: string;
  let rootA: string;
  let rootB: string;
  let fileA: string;
  let fileB: string;
  let managers: LspServerManager[];

  const FAKE_SPEC_A: LspServerSpec = {
    id: 'fake-ts-a',
    languages: ['typescript'],
    binaries: ['fake-lsp'],
    args: [],
    install: 'imaginary server for worker A',
    rootMarkers: [],
    needsWarmup: false,
  };

  const FAKE_SPEC_B: LspServerSpec = {
    id: 'fake-ts-b',
    languages: ['typescript'],
    binaries: ['fake-lsp'],
    args: [],
    install: 'imaginary server for worker B',
    rootMarkers: [],
    needsWarmup: false,
  };

  const makeManager = (
    workspaceRoot: string,
    spec: LspServerSpec,
    overrides: Record<string, unknown> = {},
    serverArgs: string[] = []
  ): LspServerManager => {
    const manager = new LspServerManager({
      workspaceRoot,
      registry: new LspServerRegistry({
        specs: [spec],
        exists: () => true,
        env: { PATH: '/nowhere' },
      }),
      maintenanceIntervalMs: 0,
      createClient: () =>
        new LspClient({
          id: spec.id,
          command: process.execPath,
          args: [FAKE_SERVER, ...serverArgs],
          rootPath: workspaceRoot,
          requestTimeoutMs: 5000,
          initializeTimeoutMs: 5000,
          shutdownTimeoutMs: 2000,
        }),
      ...overrides,
    });
    managers.push(manager);
    return manager;
  };

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-lsp-iso-'));
    rootA = path.join(baseDir, 'client-a', 'app');
    rootB = path.join(baseDir, 'client-b', 'app');
    fs.mkdirSync(path.join(rootA, 'src'), { recursive: true });
    fs.mkdirSync(path.join(rootB, 'src'), { recursive: true });

    fileA = path.join(rootA, 'src', 'alpha.ts');
    fileB = path.join(rootB, 'src', 'beta.ts');

    fs.writeFileSync(fileA, 'export class AlphaService {\n  run(): void {}\n}\n', 'utf8');
    fs.writeFileSync(fileB, 'export function betaHandler(): string {\n  return "ok";\n}\n', 'utf8');

    managers = [];
  });

  afterEach(async () => {
    for (const manager of managers) {
      await manager.disposeAll().catch(() => undefined);
    }
    if (baseDir && fs.existsSync(baseDir)) {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  describe('1. Process & Instance Isolation', () => {
    it('two workers spawn two distinct LSP server processes with different PIDs', async () => {
      const managerA = makeManager(rootA, FAKE_SPEC_A);
      const managerB = makeManager(rootB, FAKE_SPEC_B);

      const clientA = await managerA.acquire('typescript');
      const clientB = await managerB.acquire('typescript');

      expect(clientA).not.toBeNull();
      expect(clientB).not.toBeNull();
      expect(clientA).not.toBe(clientB);

      const pidA = clientA!.processId;
      const pidB = clientB!.processId;

      expect(typeof pidA).toBe('number');
      expect(typeof pidB).toBe('number');
      expect(pidA).toBeGreaterThan(0);
      expect(pidB).toBeGreaterThan(0);
      expect(pidA).not.toBe(pidB);

      expect(isAlive(pidA!)).toBe(true);
      expect(isAlive(pidB!)).toBe(true);

      const statusA = managerA.status();
      const statusB = managerB.status();
      expect(statusA).toHaveLength(1);
      expect(statusB).toHaveLength(1);
      expect(statusA[0].pid).toBe(pidA);
      expect(statusB[0].pid).toBe(pidB);
      expect(statusA[0].state).toBe('running');
      expect(statusB[0].state).toBe('running');
    });
  });

  describe('2. Document & URI Scope Isolation', () => {
    it('documents opened in Worker A are never visible to Worker B language server', async () => {
      const managerA = makeManager(rootA, FAKE_SPEC_A);
      const managerB = makeManager(rootB, FAKE_SPEC_B);

      const clientA = (await managerA.acquire('typescript'))!;
      const clientB = (await managerB.acquire('typescript'))!;

      const contentA = fs.readFileSync(fileA, 'utf8');
      const contentB = fs.readFileSync(fileB, 'utf8');

      // Worker A opens fileA
      clientA.openDocument(fileA, 'typescript', contentA);

      // Worker B opens fileB
      clientB.openDocument(fileB, 'typescript', contentB);

      const stateA = await clientA.request<FakeServerState>('test/state', {});
      const stateB = await clientB.request<FakeServerState>('test/state', {});

      const urisA = stateA.openDocuments.map(d => d.uri);
      const urisB = stateB.openDocuments.map(d => d.uri);

      // Server A sees only fileA
      expect(urisA.some(u => u.includes('alpha.ts'))).toBe(true);
      expect(urisA.some(u => u.includes('beta.ts'))).toBe(false);

      // Server B sees only fileB
      expect(urisB.some(u => u.includes('beta.ts'))).toBe(true);
      expect(urisB.some(u => u.includes('alpha.ts'))).toBe(false);

      // didChange on A only increments version on Server A
      clientA.changeDocument(fileA, `${contentA}\nexport const EXTRA_A = 1;\n`);

      const stateAAfter = await clientA.request<FakeServerState>('test/state', {});
      const stateBAfter = await clientB.request<FakeServerState>('test/state', {});

      const docA = stateAAfter.openDocuments.find(d => d.uri.includes('alpha.ts'));
      expect(docA?.version).toBe(2);

      const docB = stateBAfter.openDocuments.find(d => d.uri.includes('beta.ts'));
      expect(docB?.version).toBe(1);

      // Close document on A
      clientA.closeDocument(fileA);
      expect(clientA.openDocumentCount).toBe(0);
      expect(clientB.openDocumentCount).toBe(1);

      clientB.closeDocument(fileB);
      expect(clientB.openDocumentCount).toBe(0);
    });
  });

  describe('3. Symbol Extraction, Diagnostics & Interactive Ops Isolation', () => {
    it('symbol extractors return only project-specific symbols via their own LSP servers', async () => {
      const managerA = makeManager(rootA, FAKE_SPEC_A);
      const managerB = makeManager(rootB, FAKE_SPEC_B);

      const extractorA = new LspSymbolExtractor({
        acquire: () => managerA.acquire('typescript'),
        probe: new CapabilityProbe(),
      });
      const extractorB = new LspSymbolExtractor({
        acquire: () => managerB.acquire('typescript'),
        probe: new CapabilityProbe(),
      });

      const contentA = fs.readFileSync(fileA, 'utf8');
      const contentB = fs.readFileSync(fileB, 'utf8');

      const resA = await extractorA.extract('fA', fileA, contentA, 'typescript');
      const resB = await extractorB.extract('fB', fileB, contentB, 'typescript');

      expect(resA.ok).toBe(true);
      expect(resB.ok).toBe(true);

      if (resA.ok && resB.ok) {
        expect(resA.value.source).toBe('lsp');
        expect(resA.value.symbols.map(s => s.name)).toContain('AlphaService');
        expect(resA.value.symbols.map(s => s.name)).not.toContain('betaHandler');

        expect(resB.value.source).toBe('lsp');
        expect(resB.value.symbols.map(s => s.name)).toContain('betaHandler');
        expect(resB.value.symbols.map(s => s.name)).not.toContain('AlphaService');
      }
    });

    it('diagnostics provider isolates errors to the respective project workspace', async () => {
      const diagFileA = path.join(rootA, 'src', 'errors.ts');
      const diagFileB = path.join(rootB, 'src', 'clean.ts');

      const contentDiagA = 'ERROR: syntax error in project A\n';
      const contentDiagB = 'INFO: all good in project B\n';
      fs.writeFileSync(diagFileA, contentDiagA, 'utf8');
      fs.writeFileSync(diagFileB, contentDiagB, 'utf8');

      const managerA = makeManager(rootA, FAKE_SPEC_A);
      const managerB = makeManager(rootB, FAKE_SPEC_B);

      const diagA = new DiagnosticsProvider({ acquire: () => managerA.acquire('typescript') });
      const diagB = new DiagnosticsProvider({ acquire: () => managerB.acquire('typescript') });

      const reportA = await diagA.diagnosticsFor(diagFileA, 'typescript', contentDiagA, 'fDiagA');
      const reportB = await diagB.diagnosticsFor(diagFileB, 'typescript', contentDiagB, 'fDiagB');

      expect(reportA).toHaveLength(1);
      expect(reportA[0].message).toBe('syntax error in project A');
      expect(reportA[0].severity).toBe('error');

      expect(reportB).toHaveLength(1);
      expect(reportB[0].message).toBe('all good in project B');
      expect(reportB[0].severity).toBe('info');
    });

    it('interactive rename operations in Project A do not cross into Project B', async () => {
      const managerA = makeManager(rootA, FAKE_SPEC_A);
      const managerB = makeManager(rootB, FAKE_SPEC_B);

      const opsA = new InteractiveOps({
        acquire: () => managerA.acquire('typescript'),
        rootPath: rootA,
      });
      const opsB = new InteractiveOps({
        acquire: () => managerB.acquire('typescript'),
        rootPath: rootB,
      });

      const clientA = (await managerA.acquire('typescript'))!;
      const clientB = (await managerB.acquire('typescript'))!;

      clientA.openDocument(fileA, 'typescript', fs.readFileSync(fileA, 'utf8'));
      clientB.openDocument(fileB, 'typescript', fs.readFileSync(fileB, 'utf8'));

      const renameResultA = await opsA.rename(
        fileA,
        'typescript',
        { line: 1, column: 15 },
        'RenamedAlpha',
        { dryRun: true, content: fs.readFileSync(fileA, 'utf8') }
      );
      expect(renameResultA.ok).toBe(true);
      if (renameResultA.ok) {
        expect(renameResultA.files.map(f => f.path)).toContain(path.relative(rootA, fileA));
      }

      // Project B's file content on disk is unmodified
      expect(fs.readFileSync(fileB, 'utf8')).toContain('betaHandler');

      clientA.closeDocument(fileA);
      clientB.closeDocument(fileB);
    });
  });

  describe('4. Fault & Crash Isolation', () => {
    it('crash of Worker A language server leaves Worker B language server healthy and responsive', async () => {
      let clock = 100_000;
      const managerA = makeManager(rootA, FAKE_SPEC_A, { now: () => clock, maxRestarts: 3 });
      const managerB = makeManager(rootB, FAKE_SPEC_B, { now: () => clock, maxRestarts: 3 });

      const clientA = (await managerA.acquire('typescript'))!;
      const clientB = (await managerB.acquire('typescript'))!;

      const pidA = clientA.processId!;
      const pidB = clientB.processId!;

      expect(isAlive(pidA)).toBe(true);
      expect(isAlive(pidB)).toBe(true);

      // Crash Server A
      clientA.notify('test/crash', {});
      await waitFor(() => !isAlive(pidA));

      expect(managerA.status()[0].failures).toBe(1);

      // Server B is still alive, responsive and intact
      expect(isAlive(pidB)).toBe(true);
      expect(clientB.isRunning).toBe(true);

      // Query Server B — works normally
      const symbolsB = await clientB.withDocument(
        fileB,
        'typescript',
        () => clientB.documentSymbol(fileB),
        fs.readFileSync(fileB, 'utf8')
      );
      expect(symbolsB).toBeDefined();
      expect(managerB.status()[0].failures).toBe(0);
      expect(managerB.status()[0].pid).toBe(pidB);

      // Crash Server A repeatedly until it is degraded
      clock += 60_000;
      const clientA2 = (await managerA.acquire('typescript'))!;
      expect(clientA2).not.toBeNull();
      clientA2.notify('test/crash', {});
      await waitFor(() => !clientA2.isRunning);

      clock += 60_000;
      const clientA3 = (await managerA.acquire('typescript'))!;
      expect(clientA3).not.toBeNull();
      clientA3.notify('test/crash', {});
      await waitFor(() => !clientA3.isRunning);

      clock += 600_000;
      expect(await managerA.acquire('typescript')).toBeNull();
      expect(managerA.isDegraded('typescript')).toBe(true);
      expect(managerA.status()[0].state).toBe('degraded');

      // Worker B is still 100% healthy, NOT degraded, and answers acquire
      expect(managerB.isDegraded('typescript')).toBe(false);
      const activeB = await managerB.acquire('typescript');
      expect(activeB).not.toBeNull();
      expect(activeB!.processId).toBe(pidB);
      expect(managerB.status()[0].state).toBe('running');
    });
  });

  describe('5. Resource Management & Reap Isolation', () => {
    it('idle reap in Worker A does not stop an active language server in Worker B', async () => {
      let clock = 500_000;
      const managerA = makeManager(rootA, FAKE_SPEC_A, {
        now: () => clock,
        idleTimeoutMs: 10_000,
        minLifetimeMs: 0,
      });
      const managerB = makeManager(rootB, FAKE_SPEC_B, {
        now: () => clock,
        idleTimeoutMs: 60_000,
        minLifetimeMs: 0,
      });

      const clientA = (await managerA.acquire('typescript'))!;
      const clientB = (await managerB.acquire('typescript'))!;
      const pidA = clientA.processId!;
      const pidB = clientB.processId!;

      clock += 15_000;

      // Reap idle servers on manager A
      const reapedA = await managerA.reapIdle();
      expect(reapedA).toEqual(['fake-ts-a']);
      expect(await died(pidA)).toBe(true);
      expect(managerA.status()[0].state).toBe('stopped');

      // Server B was NOT reaped and is still running
      expect(isAlive(pidB)).toBe(true);
      expect(managerB.status()[0].state).toBe('running');

      // Manager A can restart its server on new request without affecting B
      const clientA2 = await managerA.acquire('typescript');
      expect(clientA2).not.toBeNull();
      expect(clientA2!.processId).not.toBe(pidA);
      expect(clientB.processId).toBe(pidB);
    });
  });

  describe('6. Lifecycle & Teardown Isolation', () => {
    it('disposing Worker A stops only Server A and leaves Server B intact', async () => {
      const managerA = makeManager(rootA, FAKE_SPEC_A);
      const managerB = makeManager(rootB, FAKE_SPEC_B);

      const clientA = (await managerA.acquire('typescript'))!;
      const clientB = (await managerB.acquire('typescript'))!;

      const pidA = clientA.processId!;
      const pidB = clientB.processId!;

      expect(isAlive(pidA)).toBe(true);
      expect(isAlive(pidB)).toBe(true);

      // Dispose manager A
      await managerA.disposeAll();

      expect(await died(pidA)).toBe(true);
      expect(managerA.status()).toEqual([]);

      // Server B is untouched and still alive
      expect(isAlive(pidB)).toBe(true);
      expect(clientB.isRunning).toBe(true);

      const pingB = await clientB.request<FakeServerState>('test/state', {});
      expect(pingB.initialized).toBe(true);

      // Now dispose manager B
      await managerB.disposeAll();
      expect(await died(pidB)).toBe(true);
      expect(managerB.status()).toEqual([]);
    });
  });

  describe('7. Concurrent Pipeline Isolation with LSP', () => {
    it('two parallel IndexPipelines with LSP extractors produce isolated indexes without crosstalk', async () => {
      const extractorsA = createExtractors({
        workspaceRoot: rootA,
        treeSitter: false,
        lsp: true,
        lspServers: {
          typescript: {
            command: process.execPath,
            args: [FAKE_SERVER],
          },
        },
      });

      const extractorsB = createExtractors({
        workspaceRoot: rootB,
        treeSitter: false,
        lsp: true,
        lspServers: {
          typescript: {
            command: process.execPath,
            args: [FAKE_SERVER],
          },
        },
      });

      const outA = path.join(baseDir, 'data', 'projects', 'proj-a', 'project-index.json');
      const outB = path.join(baseDir, 'data', 'projects', 'proj-b', 'project-index.json');
      fs.mkdirSync(path.dirname(outA), { recursive: true });
      fs.mkdirSync(path.dirname(outB), { recursive: true });

      const [resA, resB] = await Promise.all([
        new IndexPipeline({
          workspaceRoot: rootA,
          outputPath: outA,
          symbolExtractors: extractorsA.symbols,
          dependencyExtractors: extractorsA.dependencies,
        }).run(),
        new IndexPipeline({
          workspaceRoot: rootB,
          outputPath: outB,
          symbolExtractors: extractorsB.symbols,
          dependencyExtractors: extractorsB.dependencies,
        }).run(),
      ]);

      expect(resA.stats.files).toBe(1);
      expect(resB.stats.files).toBe(1);

      const symbolNamesA = resA.projectIndex.symbols.map(s => s.name);
      const symbolNamesB = resB.projectIndex.symbols.map(s => s.name);

      expect(symbolNamesA).toContain('AlphaService');
      expect(symbolNamesA).not.toContain('betaHandler');

      expect(symbolNamesB).toContain('betaHandler');
      expect(symbolNamesB).not.toContain('AlphaService');

      extractorsA.dispose();
      extractorsB.dispose();
    });
  });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function died(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return !isAlive(pid);
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('waitFor condition timed out');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
