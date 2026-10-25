/**
 * F-0007 — `transport: 'loopback'` باید واقعاً اجرا شود، نه اینکه بی‌صدا روی
 * سوکت بیفتد.
 *
 * `WorkerTransport` و `workerArgv` از قبل TCP را می‌شناختند، ولی supervisor
 * و هر دو مسیرِ ارتباطی (proxy و WS upgrade) همیشه socketPath می‌ساختند؛
 * یعنی گزینه‌ای که در schema و در مستندات معماری (D5) اعلام شده بود هیچ
 * مسیرِ اجرا نداشت.
 */

import * as net from 'net';
import {
  allocateLoopbackPort,
  describeTarget,
  netConnectOptions,
  normalizeTransport,
  targetConnectOptions,
} from './workerTarget';
import { WorkerProcess } from './WorkerProcess';
import { ProjectWorkerConfig } from './types';
import { socketEndpoint } from '../server/socketEndpoint';

const config: ProjectWorkerConfig = {
  projectId: 'prj-app-12345678',
  name: 'App',
  rootPath: '/srv/app',
  dataDir: '/srv/data',
  indexing: {
    vectors: false, blueprint: true, git: true, treeSitter: true, pretty: true,
  },
  watch: false,
  watchOptions: { debounceMs: 500, blueprintMode: 'always' },
  service: { transport: 'socket', host: '127.0.0.1', http: false, stdio: false, web: false },
  security: { gatewayManaged: true, tokenEnvVar: 'SE_TOKEN' },
  embedding: { enabled: false, provider: 'local', normalize: false },
} as unknown as ProjectWorkerConfig;

describe('F-0007 — worker target', () => {
  it('loopback با host/port وصل می‌شود، نه با socketPath', () => {
    const target = { transport: 'loopback', host: '127.0.0.1', port: 43100 } as const;

    expect(targetConnectOptions(target)).toEqual({ host: '127.0.0.1', port: 43100 });
    // net.connect برای سوکت کلید `path` می‌خواهد، نه `socketPath`
    expect(netConnectOptions(target)).toEqual({ host: '127.0.0.1', port: 43100 });
    expect(describeTarget(target)).toBe('loopback:127.0.0.1:43100');
  });

  it('socket همان نشانیِ سوکت را می‌دهد، با normalizeِ پلتفرم و کلیدِ درست', () => {
    const socketPath = '/run/x/app.sock';
    const target = { transport: 'socket', socketPath } as const;
    const http = targetConnectOptions(target);
    // NetConnectOpts یک union است؛ برای خواندنِ کلیدها شکلِ روشن می‌دهیم
    const tcp = netConnectOptions(target) as { path?: string; host?: string; port?: number };

    /*
    | روی ویندوز هر دو باید به لولهٔ نام‌دار برسند (SE-PORT-02) و روی
    | POSIX همان مسیرِ داده‌شده؛ چیزی که این تست واقعا قفل می‌کند
    | این است: http کلید `socketPath` و net کلید `path` می‌گیرد.
    */
    const normalized = socketEndpoint(socketPath);
    expect(http.socketPath).toBe(normalized);
    expect(tcp.path).toBe(normalized);
    if (process.platform === 'win32') {
      expect(normalized.startsWith('\\\\.\\pipe\\')).toBe(true);
    } else {
      expect(normalized).toBe(socketPath);
    }
    expect(http.host).toBeUndefined();
    expect(tcp.port).toBeUndefined();
  });

  it('normalizeTransport فقط loopback را از رفتارِ سوکت جدا می‌کند', () => {
    expect(normalizeTransport('loopback')).toBe('loopback');
    expect(normalizeTransport('socket')).toBe('socket');
    expect(normalizeTransport(undefined)).toBe('socket');
    expect(normalizeTransport('nonsense' as never)).toBe('socket');
  });

  it('پورتِ رزروشده واقعاً آزاد است و روی آن می‌توان listen کرد', async () => {
    const port = await allocateLoopbackPort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);

    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    });
    server.close();
  });

  it('دو بار رزرو، دو پورتِ می‌دهد (شماره‌ها بازاستفاده نمی‌شوند)', async () => {
    const [a, b] = await Promise.all([allocateLoopbackPort(), allocateLoopbackPort()]);
    expect(a).not.toBe(b);
  });

  it('WorkerProcess با هدفِ loopback هرگز --socket نمی‌فرستد و --port می‌فرستد', () => {
    const target = { transport: 'loopback', host: '127.0.0.1', port: 43999 } as const;
    const proc = new WorkerProcess({
      config,
      socketPath: '/unused/app.sock',
      target,
      token: 'internal-token',
      binary: 'semantic-engine',
    });

    const argv = proc.argv();
    expect(argv).toContain('--port');
    expect(argv).toContain('43999');
    expect(argv).not.toContain('--socket');
    // هدف از بیرون هم خوانا بماند تا /gateway/projects بتواند نشان دهد
    expect(proc.target).toEqual(target);
  });

  it('با هدفِ سوکت (حالتِ تاریخی) همان --socket قبلی فرستاده می‌شود', () => {
    const proc = new WorkerProcess({
      config,
      socketPath: '/run/app.sock',
      token: 'internal-token',
      binary: 'semantic-engine',
    });

    const argv = proc.argv();
    expect(argv.slice(-2)).toEqual(['--socket', '/run/app.sock']);
    expect(argv).not.toContain('--port');
    expect(proc.target).toEqual({ transport: 'socket', socketPath: '/run/app.sock' });
  });
});
