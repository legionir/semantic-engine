/**
 * OpenTelemetryTracer — W3C TraceContext traceparent generator and context propagation.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly startTime: number;
  endTime?: number;
  attributes: Record<string, unknown>;
  status: 'ok' | 'error';
}

export class OpenTelemetryTracer {
  private readonly spans: Span[] = [];

  createTraceparent(traceId?: string, spanId?: string): string {
    const tId = traceId || crypto.randomBytes(16).toString('hex');
    const sId = spanId || crypto.randomBytes(8).toString('hex');
    return `00-${tId}-${sId}-01`;
  }

  parseTraceparent(header?: string): { traceId: string; parentSpanId?: string } | null {
    if (!header) return null;
    /*
    | P-05/SE-F-034 — W3C traceparent را فقط با «چهار تکه شد» نمی‌توان
    | پذیرفت: طول، هگز بودن و all-zero بودنِ version-0 بخشی از خودِ
    | استانداردند. parseTraceparent('junk-x-y-z') قبلاً traceId:'x'
    | می‌داد و startSpan آن را به‌عنوان هویتِ realِ trace نگه می‌داشت —
    | یعنی یک span با منشأ نامعتبر، «معتبر» به نظر می‌رسید (§15:
    | خطا نباید به‌عنوان نتیجهٔ معتبر ارائه شود). حالت all-zero هم
    | طبق استاندارد یعنی «no trace», نه یک شناسه.
    */
    const match = /^([\da-f]{2})-([\da-f]{32})-([\da-f]{16})(-([\da-f]{2}))?$/i.exec(header.trim());
    if (!match) return null;
    const [, version, traceId, spanId, , flags] = match;
    if (version === '00' && traceId && /^0+$/.test(traceId)) return null;
    if (version === '00' && spanId && /^0+$/.test(spanId)) return null;
    if (version === 'ff') return null;
    if (flags === undefined) return null; // spec: version-0 requires the flags field
    return { traceId: traceId!, parentSpanId: spanId };
  }

  startSpan(name: string, parentHeader?: string): Span {
    const parsed = this.parseTraceparent(parentHeader);
    const traceId = parsed?.traceId || crypto.randomBytes(16).toString('hex');
    const spanId = crypto.randomBytes(8).toString('hex');

    const span: Span = {
      traceId,
      spanId,
      parentSpanId: parsed?.parentSpanId,
      name,
      startTime: Date.now(),
      attributes: {},
      status: 'ok',
    };

    this.spans.push(span);
    if (this.spans.length > 1000) {
      this.spans.splice(0, this.spans.length - 1000);
    }
    return span;
  }

  endSpan(span: Span, status: 'ok' | 'error' = 'ok'): void {
    span.endTime = Date.now();
    span.status = status;
  }

  async flush(outputPath: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    const tempPath = `${outputPath}.tmp-${process.pid}`;
    await fs.promises.writeFile(tempPath, `${JSON.stringify(this.spans)}\n`, 'utf8');
    await fs.promises.rename(tempPath, outputPath);
    this.spans.length = 0;
  }

  getRecentSpans(limit: number = 50): readonly Span[] {
    return this.spans.slice(-limit);
  }
}
