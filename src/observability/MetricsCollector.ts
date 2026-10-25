/**
 * MetricsCollector — Aggregates platform operational metrics for Prometheus export on /metrics.
 */

export interface CounterMetric {
  readonly name: string;
  readonly help: string;
  readonly labels?: Record<string, string>;
  value: number;
}

export class MetricsCollector {
  private readonly counters = new Map<string, number>();
  private readonly durations = new Map<string, number[]>();

  increment(metricName: string, amount: number = 1): void {
    const current = this.counters.get(metricName) || 0;
    this.counters.set(metricName, current + amount);
  }

  recordDuration(metricName: string, durationMs: number): void {
    const list = this.durations.get(metricName) || [];
    list.push(durationMs);
    if (list.length > 500) list.shift();
    this.durations.set(metricName, list);
  }

  getMetricsSummary(): Record<string, unknown> {
    const summary: Record<string, unknown> = {};
    for (const [k, v] of this.counters.entries()) {
      summary[k] = v;
    }
    for (const [k, durations] of this.durations.entries()) {
      const avg = durations.length > 0
        ? durations.reduce((a, b) => a + b, 0) / durations.length
        : 0;
      summary[`${k}_avg_ms`] = Math.round(avg * 100) / 100;
      summary[`${k}_count`] = durations.length;
    }
    return summary;
  }

  toPrometheusFormat(): string {
    const lines: string[] = [
      '# HELP semantic_engine_requests_total Total HTTP requests handled',
      '# TYPE semantic_engine_requests_total counter',
    ];

    for (const [k, v] of this.counters.entries()) {
      lines.push(`semantic_engine_${k}_total ${v}`);
    }

    for (const [k, durations] of this.durations.entries()) {
      const sum = durations.reduce((a, b) => a + b, 0);
      lines.push(`semantic_engine_${k}_sum_ms ${sum}`);
      lines.push(`semantic_engine_${k}_count ${durations.length}`);
    }

    return lines.join('\n') + '\n';
  }
}
