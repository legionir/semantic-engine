/**
 * توکن لغو — MIG-13.
 *
 * شکل عمومی عمداً همان `vscode.CancellationToken` است
 * (`isCancellationRequested` + `onCancellationRequested`) تا امضاهای
 * موجود مثل `WorkspaceScanner.scan` دست‌نخورده بمانند و مهاجرت فقط یک
 * تعویض import باشد. زیرش `AbortSignal` است، نه هیچ‌چیز مخصوص ویرایشگر.
 */

import {
  CancellationTokenSource,
  CancellationTokenNone,
  fromAbortSignal,
  toAbortSignal,
  throwIfCancelled,
  CancellationError,
} from './Cancellation';

describe('CancellationTokenSource', () => {

  it('starts uncancelled', () => {
    expect(new CancellationTokenSource().token.isCancellationRequested).toBe(false);
  });

  it('flips the flag when cancelled', () => {
    const source = new CancellationTokenSource();

    source.cancel();

    expect(source.token.isCancellationRequested).toBe(true);
  });

  it('notifies listeners on cancel', () => {
    const source = new CancellationTokenSource();
    const seen: string[] = [];
    source.token.onCancellationRequested(() => seen.push('first'));
    source.token.onCancellationRequested(() => seen.push('second'));

    source.cancel();

    expect(seen).toEqual(['first', 'second']);
  });

  it('notifies only once no matter how often cancel is called', () => {
    const source = new CancellationTokenSource();
    const listener = jest.fn();
    source.token.onCancellationRequested(listener);

    source.cancel();
    source.cancel();
    source.cancel();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  /*
  | معنای VS Code: ثبت listener روی توکنی که *قبلاً* لغو شده، فوراً
  | صدا زده می‌شود. بدون این، هر کدی که دیر ثبت می‌کند برای همیشه منتظر
  | می‌ماند.
  */
  it('calls a listener registered after cancellation immediately', () => {
    const source = new CancellationTokenSource();
    source.cancel();
    const listener = jest.fn();

    source.token.onCancellationRequested(listener);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('stops notifying a disposed listener', () => {
    const source = new CancellationTokenSource();
    const listener = jest.fn();
    const registration = source.token.onCancellationRequested(listener);

    registration.dispose();
    source.cancel();

    expect(listener).not.toHaveBeenCalled();
  });

  /*
  | یک listener معیوب نباید بقیه را از صدا شدن محروم کند؛ وگرنه یک
  | throw در پاک‌سازی، پاک‌سازی‌های بعدی را می‌خورد و منابع باز می‌ماند.
  */
  it('keeps notifying after a listener throws', () => {
    const source = new CancellationTokenSource();
    const later = jest.fn();
    source.token.onCancellationRequested(() => {
      throw new Error('listener is broken');
    });
    source.token.onCancellationRequested(later);

    expect(() => source.cancel()).not.toThrow();
    expect(later).toHaveBeenCalledTimes(1);
  });

  it('drops listeners on dispose without cancelling', () => {
    const source = new CancellationTokenSource();
    const listener = jest.fn();
    source.token.onCancellationRequested(listener);

    source.dispose();

    expect(source.token.isCancellationRequested).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('CancellationTokenNone', () => {

  it('is never cancelled and never calls back', () => {
    const listener = jest.fn();

    const registration = CancellationTokenNone.onCancellationRequested(listener);
    registration.dispose();

    expect(CancellationTokenNone.isCancellationRequested).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('AbortSignal bridge', () => {

  it('turns an AbortSignal into a token', () => {
    const controller = new AbortController();
    const token = fromAbortSignal(controller.signal);
    const listener = jest.fn();
    token.onCancellationRequested(listener);

    expect(token.isCancellationRequested).toBe(false);
    controller.abort();

    expect(token.isCancellationRequested).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('reports an already aborted signal as cancelled', () => {
    const controller = new AbortController();
    controller.abort();

    expect(fromAbortSignal(controller.signal).isCancellationRequested).toBe(true);
  });

  /*
  | لازم است چون `fetch`، `child_process.spawn` و `fs.promises` همگی
  | `AbortSignal` می‌خواهند نه توکن ما.
  */
  it('turns a token back into an AbortSignal', () => {
    const source = new CancellationTokenSource();
    const signal = toAbortSignal(source.token);

    expect(signal.aborted).toBe(false);
    source.cancel();

    expect(signal.aborted).toBe(true);
  });

  it('returns an already aborted signal for an already cancelled token', () => {
    const source = new CancellationTokenSource();
    source.cancel();

    expect(toAbortSignal(source.token).aborted).toBe(true);
  });

  it('round-trips without losing cancellation', () => {
    const controller = new AbortController();
    const signal = toAbortSignal(fromAbortSignal(controller.signal));

    controller.abort();

    expect(signal.aborted).toBe(true);
  });
});

describe('timeout and linking', () => {

  it('cancels itself after a timeout', async () => {
    const source = CancellationTokenSource.withTimeout(10);

    await new Promise(resolve => setTimeout(resolve, 30));

    expect(source.token.isCancellationRequested).toBe(true);
  });

  it('does not keep the process alive after being disposed', () => {
    const source = CancellationTokenSource.withTimeout(60_000);

    source.dispose();

    expect(source.token.isCancellationRequested).toBe(false);
  });

  it('cancels a linked source when any parent cancels', () => {
    const first = new CancellationTokenSource();
    const second = new CancellationTokenSource();
    const linked = CancellationTokenSource.link(first.token, second.token);

    second.cancel();

    expect(linked.token.isCancellationRequested).toBe(true);
  });

  it('is born cancelled if a parent was already cancelled', () => {
    const parent = new CancellationTokenSource();
    parent.cancel();

    expect(CancellationTokenSource.link(parent.token).token.isCancellationRequested).toBe(true);
  });
});

describe('throwIfCancelled', () => {

  it('does nothing while the token is live', () => {
    expect(() => throwIfCancelled(new CancellationTokenSource().token)).not.toThrow();
  });

  it('throws a recognisable error once cancelled', () => {
    const source = new CancellationTokenSource();
    source.cancel();

    expect(() => throwIfCancelled(source.token)).toThrow(CancellationError);
  });

  it('tolerates an absent token, so callers need no null check', () => {
    expect(() => throwIfCancelled(undefined)).not.toThrow();
  });
});
