/**
 * اسکنر روی تایپ‌های میزبان — MIG-15.
 *
 * جایگزینی `vscode.Progress` و `vscode.CancellationToken` با تایپ‌های
 * خودی فقط وقتی بی‌خطر است که دو چیز هم‌زمان درست باشد:
 *
 *   ۱. اسکنر با پیاده‌سازی میزبان کار کند (مقصد مهاجرت)
 *   ۲. همان اسکنر با شیءِ VS Code-شکل هم کار کند (تا `extension.ts` در
 *      فاصلهٔ فازهای ۰۹ تا ۱۳ نشکند)
 *
 * تست دوم عمداً یک شیء دست‌ساز است، نه import از `vscode`: نکته همین
 * است که سازگاری *ساختاری* است و به ویرایشگر ربطی ندارد.
 */

import * as path from 'path';
import { WorkspaceScanner } from './WorkspaceScanner';
import { CancellationTokenSource } from '../host/Cancellation';
import { NdjsonProgress, ProgressLike, ProgressUpdate } from '../host/Progress';

const fixtureRoot = path.join(__dirname, '..', '..', 'test-fixture');

function recordingProgress(): ProgressLike & { updates: ProgressUpdate[] } {
  const updates: ProgressUpdate[] = [];
  return { updates, report: (update: ProgressUpdate) => void updates.push(update) };
}

describe('WorkspaceScanner on host types', () => {

  it('reports progress to a host reporter', async () => {
    const progress = recordingProgress();

    const result = await new WorkspaceScanner(fixtureRoot, { skipHiddenDirectories: false })
      .scan(progress);

    expect(result.ok).toBe(true);
    expect(progress.updates.length).toBeGreaterThan(0);
    expect(progress.updates[0].message).toContain('Collecting');
  });

  it('accepts the real NdjsonProgress without an adapter', async () => {
    const lines: string[] = [];
    const reporter = new NdjsonProgress({ sink: { write: chunk => void lines.push(chunk) } });

    const result = await new WorkspaceScanner(fixtureRoot).scan(reporter);

    expect(result.ok).toBe(true);
    expect(JSON.parse(lines[0]).type).toBe('progress');
  });

  it('stops when the host token is already cancelled', async () => {
    const source = new CancellationTokenSource();
    source.cancel();

    const result = await new WorkspaceScanner(fixtureRoot).scan(undefined, source.token);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.message).toMatch(/cancel/i);
  });

  it('stops partway through when cancelled during the scan', async () => {
    const source = new CancellationTokenSource();
    const progress: ProgressLike = {
      report: () => source.cancel(),
    };

    const result = await new WorkspaceScanner(fixtureRoot).scan(progress, source.token);

    expect(result.ok).toBe(false);
  });

  /*
  | شکل VS Code، بدون وارد کردن VS Code. تا وقتی `extension.ts` زنده
  | است این سازگاری باید بماند.
  */
  it('still accepts a vscode-shaped progress and token', async () => {
    const seen: string[] = [];
    const vscodeShapedProgress = {
      report(value: { message?: string; increment?: number }): void {
        if (value.message) seen.push(value.message);
      },
    };
    const vscodeShapedToken = {
      isCancellationRequested: false,
      onCancellationRequested(
        _listener: (event: unknown) => unknown,
        _thisArgs?: unknown,
        _disposables?: unknown[]
      ): { dispose(): unknown } {
        return { dispose: () => undefined };
      },
    };

    const result = await new WorkspaceScanner(fixtureRoot)
      .scan(vscodeShapedProgress, vscodeShapedToken);

    expect(result.ok).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
  });
});
