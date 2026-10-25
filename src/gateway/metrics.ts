/**
 * Metric vocabulary — فاز ۱۳.
 *
 * The two metric sets are a contract: the Gateway console renders them, the
 * tests assert them, and an operator reads them. Keeping the key lists here
 * means a renamed metric breaks a test instead of silently emptying a
 * dashboard column.
 */

export const GATEWAY_METRIC_KEYS = [
  'gateway_projects_total',
  'gateway_workers_ready',
  'gateway_workers_unhealthy',
  'gateway_requests_total',
  'gateway_request_duration_ms',
  'gateway_active_requests',
  'gateway_proxy_errors_total',
  'gateway_worker_restarts_total',
  'gateway_index_jobs_active',
] as const;

export const WORKER_METRIC_KEYS = [
  'worker_uptime_seconds',
  'worker_memory_bytes',
  'worker_cpu_percent',
  'worker_active_requests',
  'worker_queue_size',
  'worker_index_duration_ms',
  'worker_index_failures_total',
  'worker_files_total',
  'worker_symbols_total',
  'worker_dependencies_total',
  'worker_vector_chunks_total',
  'worker_restart_count',
  'worker_index_state',
] as const;

export interface DurationSnapshot {
  readonly count: number;
  readonly sumMs: number;
  readonly avgMs: number;
  readonly maxMs: number;
  readonly p95Ms: number;
}

/**
 * خلاصهٔ مدت‌زمان درخواست‌ها.
 *
 * عمداً یک پنجرهٔ کران‌دار است و نه histogram کامل: یک Gateway که روزها
 * بالا می‌ماند نباید با هر درخواست حافظه بخورد، و برای یک داشبورد
 * `count/avg/max/p95` کافی است.
 */
export class DurationSummary {
  private readonly samples: number[] = [];

  constructor(private readonly window: number = 200) {}

  record(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    this.samples.push(durationMs);
    if (this.samples.length > this.window) this.samples.shift();
  }

  snapshot(): DurationSnapshot {
    const count = this.samples.length;
    if (count === 0) {
      return { count: 0, sumMs: 0, avgMs: 0, maxMs: 0, p95Ms: 0 };
    }

    const sorted = [...this.samples].sort((a, b) => a - b);
    const sumMs = sorted.reduce((sum, value) => sum + value, 0);
    const p95Index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);

    return {
      count,
      sumMs: Math.round(sumMs),
      avgMs: Math.round(sumMs / count),
      maxMs: Math.round(sorted[sorted.length - 1] ?? 0),
      p95Ms: Math.round(sorted[Math.max(p95Index, 0)] ?? 0),
    };
  }
}

/**
 * درصد CPU از `process.cpuUsage()`: مجموع زمان user+system تقسیم بر زمان
 * دیواری، در صد. بیش از ۱۰۰ یعنی بیش از یک هسته.
 */
export function cpuPercent(usage: NodeJS.CpuUsage, uptimeMs: number): number {
  if (!Number.isFinite(uptimeMs) || uptimeMs <= 0) return 0;
  const cpuMs = (usage.user + usage.system) / 1000;
  return Math.round((cpuMs / uptimeMs) * 10000) / 100;
}
