/**
 * FileChangeQueue — صف رویدادهای تغییر فایل با debounce.
 *
 * مسئولیت:
 * - جمع‌آوری رویدادهای فایل‌سیستم در یک بازهٔ زمانی
 * - ادغام رویدادهای تکراری (مثلاً modify چندبار پشت سر هم)
 * - ارائه‌ی batch نهایی برای پردازش
 */

import { FileChangeEvent } from '../core/types/common.types';

export interface FileChangeQueueOptions {
  readonly debounceMs: number;
  /** سقف انتظار — دیرتر از این، batch به‌هرحال اجرا می‌شود. */
  readonly maxWaitMs?: number;
}

interface QueuedEvent {
  readonly event: FileChangeEvent;
  readonly timestamp: number;
}

export class FileChangeQueue {
  private queue: QueuedEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  /** زمان اولین رویدادِ دستهٔ فعلی — مبنای سقف انتظار. */
  private batchStartedAt: number | null = null;

  constructor(private readonly options: FileChangeQueueOptions) {}

  /**
   * افزودن یک رویداد به صف. callback پس از debounce فراخوانی می‌شود.
   *
   * ── SE-INC-08 ────────────────────────────────────────────────────
   *
   * تایمر با هر رویداد ریست می‌شد. در جریان `git checkout` یا
   * `npm install` که رویدادها پیوسته و با فاصلهٔ کمتر از debounce
   * می‌آیند، لحظهٔ آرامش هرگز نمی‌رسد و batch **هیچ‌وقت** اجرا
   * نمی‌شود — گرسنگی، نه تأخیر.
   *
   * `maxWaitMs` سقف می‌گذارد: هرچقدر هم رویداد بیاید، دسته دیرتر از
   * این از اولین رویدادش عقب نمی‌افتد.
   */
  enqueue(event: FileChangeEvent, callback: (events: FileChangeEvent[]) => void): void {
    const now = Date.now();
    this.queue.push({ event, timestamp: now });
    this.batchStartedAt ??= now;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const fire = (): void => {
      this.timer = null;
      this.batchStartedAt = null;
      const batch = this.drain();
      if (batch.length > 0) {
        callback(batch);
      }
    };

    const { debounceMs } = this.options;
    const maxWaitMs = this.options.maxWaitMs;

    if (maxWaitMs !== undefined) {
      const waited = now - this.batchStartedAt;
      if (waited >= maxWaitMs) {
        fire();
        return;
      }
      /*
      | هرکدام زودتر رسید: آرامشِ debounce، یا سقف انتظار.
      */
      this.timer = setTimeout(fire, Math.min(debounceMs, maxWaitMs - waited));
      return;
    }

    this.timer = setTimeout(fire, debounceMs);
  }

  /**
   * خالی کردن صف و ادغام رویدادهای تکراری.
   */
  drain(): FileChangeEvent[] {
    const events = this.queue.map(q => q.event);
    this.queue = [];
    return this.mergeEvents(events);
  }

  /**
   * ادغام رویدادهای تکراری بر اساس مسیر:
   - created + modified → created
   - modified + modified → modified
   - deleted + created → modified (فایل دوباره ساخته شده)
   - renamed → نگه داشتن oldPath و path
   */
  private mergeEvents(events: FileChangeEvent[]): FileChangeEvent[] {
    const byPath = new Map<string, FileChangeEvent>();

    for (const event of events) {
      const key = event.type === 'renamed' ? `renamed:${event.oldPath ?? event.path}` : event.path;
      const existing = byPath.get(key);

      if (!existing) {
        byPath.set(key, event);
        continue;
      }

      if (event.type === 'deleted') {
        byPath.set(key, event);
      } else if (existing.type === 'created' && event.type === 'modified') {
        // keep created
      } else if (existing.type === 'deleted' && event.type === 'created') {
        byPath.set(key, { type: 'modified', path: event.path });
      } else if (event.type === 'renamed') {
        byPath.set(key, event);
      } else {
        byPath.set(key, { type: 'modified', path: event.path });
      }
    }

    return Array.from(byPath.values());
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.batchStartedAt = null;
    this.queue = [];
  }
}
