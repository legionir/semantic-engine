import { OpenTelemetryTracer } from './OpenTelemetryTracer';

describe('OpenTelemetryTracer (V2 W3C TraceContext)', () => {
  it('generates and parses standard W3C traceparent headers', () => {
    const tracer = new OpenTelemetryTracer();
    const header = tracer.createTraceparent();

    expect(header.startsWith('00-')).toBe(true);

    const parsed = tracer.parseTraceparent(header);
    expect(parsed).not.toBeNull();
    expect(parsed?.traceId.length).toBe(32);

    const span = tracer.startSpan('semantic.index', header);
    expect(span.traceId).toBe(parsed?.traceId);

    tracer.endSpan(span, 'ok');
    expect(span.endTime).toBeDefined();
  });
});
