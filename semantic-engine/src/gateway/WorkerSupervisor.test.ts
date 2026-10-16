/**
 * WorkerSupervisor — فاز ۸, measured with real worker processes.
 *
 * The acceptance criteria that only real processes can prove:
 *
 *   - crashing worker A does not stop worker B;
 *   - two simultaneous starts for one project produce one worker;
 *   - a crash loop ends in `degraded` instead of restarting forever;
 *   - stopping the Gateway stops every worker and leaves no lock behind.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CapacityError, LockHeldError, WorkerSupervisor } from './WorkerSupervisor';
import { createWorkerConfig } from './WorkerConfigSchema';
import { ProjectWorkerConfig } from './types';
import { acquireLock } from './ProjectLock';

const PACKAGE_ROOT = path.join(__dirname, '..', '..');
const built = fs.existsSync(path.join(PACKAGE_ROOT, 'dist', 'cli', 'main.js'));
const describeIfBuilt = built ? describe : describe.skip;

function makeProject(base: string, name: string): string {
  const root = path.join(base, name);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export function a(): number { return 1; }\n');
  return root;
}

function configFor(root: string, projectId: string): ProjectWorkerConfig {
  const validation = createWorkerConfig({
    projectId,
    name: path.basename(root),
    rootPath: root,
    watch: false,
    watchOptions: { skipInitialIndex: false },
  } as never);
  return validation;
}

describeIfBuilt('WorkerSupervisor', () => {
  let base: string;
  let dataRoot: string;
  let supervisor: WorkerSupervisor | null = null;

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-supervisor-')));
    dataRoot = path.join(base, 'data');
  });

  /* خاموشی graceful هر worker تا `shutdownGraceMs` طول می‌کشد. */
  afterEach(async () => {
    if (supervisor) await supervisor.stopAll();
    supervisor = null;
    fs.rmSync(base, { recursive: true, force: true });
  }, 120_000);

  const create = (options: Partial<ConstructorParameters<typeof WorkerSupervisor>[0]> = {}) => {
    supervisor = new WorkerSupervisor({
      dataRoot,
      workerStartupTimeoutMs: 45_000,
      pollIntervalMs: 150,
      shutdownGraceMs: 5_000,
      killAfterMs: 2_000,
      ...options,
    });
    return supervisor;
  };

  it('starts one worker per project, and only one', async () => {
    const sup = create();
    const rootA = makeProject(base, 'app-a');
    const config = configFor(rootA, 'prj-app-a-00000001');

    /* Two starts racing for the same project. */
    const [first, second] = await Promise.all([sup.start(config), sup.start(config)]);

    expect(first.pid).not.toBeNull();
    expect(second.pid).toBe(first.pid);
    expect(sup.list()).toHaveLength(1);
    expect(sup.isRunning(config.projectId)).toBe(true);

    const health = await sup.health(config.projectId);
    expect(health?.indexState).toBe('fresh');
  }, 180_000);

  it('refuses a project whose lock another live process holds', async () => {
    const sup = create();
    const rootA = makeProject(base, 'app-a');
    const config = configFor(rootA, 'prj-app-a-00000002');

    const lockPath = path.join(dataRoot, 'projects', config.projectId, 'locks', 'worker.lock');
    const held = acquireLock(lockPath, config.projectId, 'worker', { pid: process.pid });
    expect(held.ok).toBe(true);

    await expect(sup.start(config)).rejects.toBeInstanceOf(LockHeldError);
    if (held.ok) held.release();
  }, 60_000);

  it('refuses to exceed maxWorkers', async () => {
    const sup = create({ maxWorkers: 1 });
    const first = await sup.start(configFor(makeProject(base, 'app-a'), 'prj-app-a-00000003'));
    expect(first.pid).not.toBeNull();

    await expect(
      sup.start(configFor(makeProject(base, 'app-b'), 'prj-app-b-00000003'))
    ).rejects.toBeInstanceOf(CapacityError);
  }, 180_000);

  it('restarts a crashed worker and leaves its neighbour alone', async () => {
    const sup = create({ restartPolicy: { delaysMs: [1, 1, 1], maxRestarts: 3 } });
    const workerA = await sup.start(configFor(makeProject(base, 'app-a'), 'prj-app-a-00000004'));
    const workerB = await sup.start(configFor(makeProject(base, 'app-b'), 'prj-app-b-00000004'));

    const pidB = workerB.pid;
    expect(workerA.pid).not.toBeNull();
    expect(pidB).not.toBeNull();

    /* Kill A the hard way: no graceful shutdown, just a dead process. */
    process.kill(workerA.pid as number, 'SIGKILL');
    await new Promise(resolve => setTimeout(resolve, 500));

    const results = await sup.checkAll();
    const aResult = results.find(r => r.projectId === workerA.projectId);
    const bResult = results.find(r => r.projectId === workerB.projectId);

    expect(aResult?.action).toBe('restart');
    expect(bResult?.healthy).toBe(true);

    /* A came back, B never moved. */
    const restartedA = sup.get(workerA.projectId);
    expect(restartedA?.pid).not.toBeNull();
    expect(restartedA?.pid).not.toBe(workerA.pid);
    expect(workerB.pid).toBe(pidB);
    expect(sup.restartCount(workerA.projectId)).toBe(1);

    const healthB = await sup.health(workerB.projectId);
    expect(healthB?.state).toBe('ready');
  }, 300_000);

  it('gives up after the crash limit and marks the worker degraded', async () => {
    const sup = create({ restartPolicy: { delaysMs: [1, 1, 1], maxRestarts: 2 } });
    const config = configFor(makeProject(base, 'app-a'), 'prj-app-a-00000005');
    const worker = await sup.start(config);

    /* crash → restart → crash → restart → crash ⇒ more than maxRestarts */
    const actions: string[] = [];
    for (let round = 0; round < 6; round += 1) {
      const current = sup.get(config.projectId);
      if (!current || current.pid === null || current.exitCode !== null) break;
      try {
        process.kill(current.pid, 'SIGKILL');
      } catch {
        break; /* پروسه از قبل رفته است. */
      }
      await new Promise(resolve => setTimeout(resolve, 400));
      const [result] = await sup.checkAll();
      actions.push(result?.action ?? 'none');
      if (result?.action === 'degraded') break;
    }

    expect(actions).toContain('degraded');
    expect(sup.isDegraded(config.projectId)).toBe(true);

    /* Degraded means the supervisor stops trying. */
    const after = await sup.checkAll();
    const result = after.find(r => r.projectId === config.projectId);
    expect(result?.action).toBe('none');
    expect(result?.reason).toMatch(/degraded/);
    void worker;
  }, 300_000);

  it('stops every worker and leaves no lock behind', async () => {
    const sup = create();
    const configA = configFor(makeProject(base, 'app-a'), 'prj-app-a-00000006');
    const configB = configFor(makeProject(base, 'app-b'), 'prj-app-b-00000006');

    await sup.start(configA);
    await sup.start(configB);
    expect(sup.list()).toHaveLength(2);

    await sup.stopAll();

    expect(sup.list()).toHaveLength(0);
    for (const config of [configA, configB]) {
      const lockPath = path.join(dataRoot, 'projects', config.projectId, 'locks', 'worker.lock');
      expect(fs.existsSync(lockPath)).toBe(false);
      expect(fs.existsSync(sup.socketPathFor(config.projectId))).toBe(false);
    }
  }, 300_000);

  it('records one worker crash without marking its neighbour', async () => {
    const sup = create({ restartPolicy: { delaysMs: [1, 1, 1], maxRestarts: 3 } });
    const configA = configFor(makeProject(base, 'app-a'), 'prj-app-a-00000009');
    const configB = configFor(makeProject(base, 'app-b'), 'prj-app-b-00000009');

    await sup.start(configA);
    await sup.start(configB);

    const workerA = sup.get(configA.projectId);
    process.kill(workerA!.pid as number, 'SIGKILL');
    await new Promise(resolve => setTimeout(resolve, 400));
    await sup.checkAll();

    const diagnosticsA = sup.diagnostics(configA.projectId);
    expect(diagnosticsA.restartHistory.length).toBeGreaterThan(0);
    expect(diagnosticsA.lastError).toBeTruthy();

    /* همسایهٔ سالم نه تاریخچه دارد نه خطا. */
    const diagnosticsB = sup.diagnostics(configB.projectId);
    expect(diagnosticsB.restartHistory).toEqual([]);
    expect(diagnosticsB.lastError).toBeUndefined();

    const healthB = await sup.health(configB.projectId);
    expect(healthB?.state).toBe('ready');
  }, 300_000);

  it('writes the worker artifacts under the supervisor data root', async () => {
    const sup = create();
    const config = configFor(makeProject(base, 'app-a'), 'prj-app-a-00000008');
    await sup.start(config);

    /*
    | رگرسیون: worker بدون `--data-dir` بالا می‌رفت و artifact را در data root
    | پیش‌فرض پلتفرم می‌نوشت، نه کنار socket و lock و لاگ خودش.
    */
    const indexPath = path.join(dataRoot, 'projects', config.projectId, 'project-index.json');
    expect(fs.existsSync(indexPath)).toBe(true);
    expect(fs.existsSync(path.join(dataRoot, 'gateway', 'logs', `${config.projectId}.log`))).toBe(true);
  }, 180_000);

  it('writes each worker log under the data root', async () => {
    const sup = create();
    const config = configFor(makeProject(base, 'app-a'), 'prj-app-a-00000007');
    await sup.start(config);

    const logFile = sup.logFileFor(config.projectId);
    expect(logFile.startsWith(dataRoot)).toBe(true);
    expect(fs.existsSync(logFile)).toBe(true);
  }, 180_000);
});
