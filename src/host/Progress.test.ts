/**
 * گزارش پیشرفت — MIG-12.
 *
 * `vscode.window.withProgress` بیرون از ویرایشگر وجود ندارد. سه مصرف‌کننده
 * داریم و هر کدام شکل متفاوتی می‌خواهد:
 *   - آدم پشت ترمینال      → یک خط که بازنویسی می‌شود
 *   - CI یا فرایند والد    → NDJSON روی stderr، قابل تجزیه
 *   - تست و کتابخانه       → هیچ‌چیز
 */

import {
  SilentProgress,
  TtyProgress,
  NdjsonProgress,
  createProgressReporter,
} from './Progress';

function makeSink() {
  const chunks: string[] = [];
  return {
    write(chunk: string): void {
      chunks.push(chunk);
    },
    get text(): string {
      return chunks.join('');
    },
    get lines(): string[] {
      return chunks.join('').split('\n').filter(line => line.length > 0);
    },
    chunks,
  };
}

describe('SilentProgress', () => {

  it('accepts reports and writes nothing', () => {
    const reporter = new SilentProgress();

    expect(() => {
      reporter.report({ message: 'x', increment: 10 });
      reporter.done();
    }).not.toThrow();
  });
});

describe('TtyProgress', () => {

  it('rewrites a single line instead of scrolling', () => {
    const sink = makeSink();
    const reporter = new TtyProgress({ sink, throttleMs: 0 });

    reporter.report({ message: 'first' });
    reporter.report({ message: 'second' });

    expect(sink.chunks.every(chunk => chunk.startsWith('\r'))).toBe(true);
    expect(sink.text).not.toContain('\n');
  });

  it('accumulates increments into a percentage', () => {
    const sink = makeSink();
    const reporter = new TtyProgress({ sink, throttleMs: 0 });

    reporter.report({ message: 'a', increment: 25 });
    reporter.report({ message: 'b', increment: 25 });

    expect(sink.chunks[1]).toContain('50%');
  });

  /*
  | افزایش‌های کسری روی هزاران فایل جمع می‌شوند و به‌خاطر خطای ممیز
  | شناور از ۱۰۰ رد می‌شوند. «۱۰۴٪» به کاربر می‌گوید ابزار حساب بلد نیست.
  */
  it('never shows more than 100 percent', () => {
    const sink = makeSink();
    const reporter = new TtyProgress({ sink, throttleMs: 0 });

    for (let i = 0; i < 30; i++) reporter.report({ increment: 10 });

    expect(sink.text).toContain('100%');
    expect(sink.text).not.toMatch(/1[0-9][1-9]%|[2-9][0-9][0-9]%/);
  });

  it('keeps the last message when a report carries only an increment', () => {
    const sink = makeSink();
    const reporter = new TtyProgress({ sink, throttleMs: 0 });

    reporter.report({ message: 'scanning files' });
    reporter.report({ increment: 5 });

    expect(sink.chunks[1]).toContain('scanning files');
  });

  it('clears the line and ends it on done', () => {
    const sink = makeSink();
    const reporter = new TtyProgress({ sink, throttleMs: 0 });

    reporter.report({ message: 'working' });
    reporter.done();

    expect(sink.text.endsWith('\n')).toBe(true);
  });

  /*
  | یک بازنویسی به‌ازای هر فایل روی ۱۰٬۰۰۰ فایل، خودش کندی محسوس
  | می‌آورد. کنترل جریان لازم است — ولی گزارش آخر نباید قربانی شود.
  */
  it('throttles intermediate reports but never the final one', () => {
    const sink = makeSink();
    let now = 1_000;
    const reporter = new TtyProgress({ sink, throttleMs: 100, now: () => now });

    reporter.report({ message: 'one' });
    reporter.report({ message: 'two' });
    reporter.report({ message: 'three' });
    now += 200;
    reporter.report({ message: 'four' });
    reporter.done();

    expect(sink.chunks.filter(chunk => chunk.includes('two'))).toHaveLength(0);
    expect(sink.text).toContain('four');
  });

  it('does not let a long message wrap onto a second line', () => {
    const sink = makeSink();
    const reporter = new TtyProgress({ sink, throttleMs: 0, columns: 40 });

    reporter.report({ message: 'x'.repeat(200) });

    const rendered = sink.chunks[0].replace('\r', '');
    expect(rendered.length).toBeLessThanOrEqual(40);
  });
});

describe('NdjsonProgress', () => {

  it('writes one parseable record per report', () => {
    const sink = makeSink();
    const reporter = new NdjsonProgress({ sink, now: () => new Date('2026-08-18T09:00:00.000Z') });

    reporter.report({ message: 'scanning', increment: 10 });

    expect(JSON.parse(sink.lines[0])).toEqual({
      type: 'progress',
      ts: '2026-08-18T09:00:00.000Z',
      message: 'scanning',
      percent: 10,
    });
  });

  it('does not throttle, because a machine reader wants every event', () => {
    const sink = makeSink();
    const reporter = new NdjsonProgress({ sink });

    for (let i = 0; i < 5; i++) reporter.report({ increment: 1 });

    expect(sink.lines).toHaveLength(5);
  });

  it('emits a terminal record on done', () => {
    const sink = makeSink();
    const reporter = new NdjsonProgress({ sink });

    reporter.done();

    expect(JSON.parse(sink.lines[0]).type).toBe('progress-done');
  });
});

describe('createProgressReporter', () => {

  it('is silent when asked to be', () => {
    expect(createProgressReporter({ mode: 'silent' })).toBeInstanceOf(SilentProgress);
  });

  it('picks ndjson when asked to be', () => {
    expect(createProgressReporter({ mode: 'ndjson', sink: makeSink() }))
      .toBeInstanceOf(NdjsonProgress);
  });

  it('picks tty for an interactive terminal in auto mode', () => {
    const sink = { write: () => {}, isTTY: true };

    expect(createProgressReporter({ mode: 'auto', sink })).toBeInstanceOf(TtyProgress);
  });

  /*
  | خروجی هدایت‌شده به فایل یا لوله TTY نیست. نوشتن `\r` آنجا یک فایل
  | لاگ پر از آشغال می‌سازد.
  */
  it('falls back to silent when the output is redirected', () => {
    const sink = { write: () => {}, isTTY: false };

    expect(createProgressReporter({ mode: 'auto', sink })).toBeInstanceOf(SilentProgress);
  });

  it('never writes progress to stdout in stdio mode', () => {
    const sink = { write: () => {}, isTTY: true };

    expect(createProgressReporter({ mode: 'auto', sink, stdio: true }))
      .toBeInstanceOf(SilentProgress);
  });
});
