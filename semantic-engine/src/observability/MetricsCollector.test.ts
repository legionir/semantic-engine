import { MetricsCollector } from './MetricsCollector';

describe('MetricsCollector (V2 Observability)', () => {
  it('increments counters and formats metrics for Prometheus', () => {
    const collector = new MetricsCollector();
    collector.increment('requests');
    collector.increment('requests');
    collector.recordDuration('index_duration', 120);

    const prom = collector.toPrometheusFormat();
    expect(prom).toContain('semantic_engine_requests_total 2');
    expect(prom).toContain('semantic_engine_index_duration_sum_ms 120');
  });
});
