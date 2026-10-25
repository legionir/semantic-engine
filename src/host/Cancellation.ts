/**
 * توکن لغو مستقل از ویرایشگر.
 *
 * شکل عمومی همان `vscode.CancellationToken` است تا امضاهای موجود
 * (`WorkspaceScanner.scan(progress, token)`) بدون تغییر بمانند؛ زیر آن
 * `AbortSignal` استاندارد Node است تا بشود مستقیم به `fetch`،
 * `child_process.spawn` و `fs.promises` داد.
 */

export interface Disposable {
  dispose(): void;
}

export interface CancellationToken {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): Disposable;
}

/** خطای استاندارد لغو؛ فراخوان می‌تواند آن را از خطای واقعی تشخیص دهد. */
export class CancellationError extends Error {
  constructor(message = 'Operation cancelled') {
    super(message);
    this.name = 'CancellationError';
  }
}

const NOOP_DISPOSABLE: Disposable = { dispose: () => {} };

/** توکنی که هرگز لغو نمی‌شود — جای `undefined` در مسیرهای اختیاری. */
export const CancellationTokenNone: CancellationToken = {
  get isCancellationRequested(): boolean {
    return false;
  },
  onCancellationRequested(): Disposable {
    return NOOP_DISPOSABLE;
  },
};

class MutableToken implements CancellationToken {
  private cancelled = false;
  private listeners: Array<() => void> | null = [];

  get isCancellationRequested(): boolean {
    return this.cancelled;
  }

  onCancellationRequested(listener: () => void): Disposable {
    /*
    | معنای VS Code: ثبت روی توکنِ از پیش لغو‌شده فوراً اجرا می‌شود.
    | بدون این، هر مصرف‌کننده‌ای که دیر ثبت کند تا ابد منتظر می‌ماند.
    */
    if (this.cancelled) {
      safeInvoke(listener);
      return NOOP_DISPOSABLE;
    }

    this.listeners?.push(listener);

    return {
      dispose: () => {
        if (!this.listeners) return;
        const index = this.listeners.indexOf(listener);
        if (index !== -1) this.listeners.splice(index, 1);
      },
    };
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;

    const listeners = this.listeners ?? [];
    this.listeners = null;
    for (const listener of listeners) safeInvoke(listener);
  }

  dropListeners(): void {
    this.listeners = [];
  }
}

/*
| یک listener معیوب نباید مانع صدا شدن بقیه شود: در عمل listenerها
| پاک‌سازی منابع‌اند و از دست رفتن یکی یعنی نشتی.
*/
function safeInvoke(listener: () => void): void {
  try {
    listener();
  } catch {
    // عمدی: خطای listener مسئلهٔ منبع لغو نیست.
  }
}

export class CancellationTokenSource {
  private readonly mutable = new MutableToken();
  private timer: NodeJS.Timeout | undefined;
  private links: Disposable[] = [];

  get token(): CancellationToken {
    return this.mutable;
  }

  cancel(): void {
    this.mutable.cancel();
    this.clearTimer();
  }

  /** آزادسازی بدون لغو — برای وقتی عملیات عادی تمام شده است. */
  dispose(): void {
    this.clearTimer();
    for (const link of this.links) link.dispose();
    this.links = [];
    this.mutable.dropListeners();
  }

  static withTimeout(ms: number): CancellationTokenSource {
    const source = new CancellationTokenSource();
    source.timer = setTimeout(() => source.cancel(), ms);
    /*
    | بدون unref، یک مهلت ۳۰ دقیقه‌ای پروسه را ۳۰ دقیقه زنده نگه می‌دارد
    | حتی وقتی کار تمام شده است.
    */
    source.timer.unref?.();
    return source;
  }

  /** منبعی که با لغو هر یک از والدها لغو می‌شود. */
  static link(...parents: readonly CancellationToken[]): CancellationTokenSource {
    const source = new CancellationTokenSource();
    for (const parent of parents) {
      source.links.push(parent.onCancellationRequested(() => source.cancel()));
    }
    return source;
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

export function fromAbortSignal(signal: AbortSignal): CancellationToken {
  return {
    get isCancellationRequested(): boolean {
      return signal.aborted;
    },
    onCancellationRequested(listener: () => void): Disposable {
      if (signal.aborted) {
        safeInvoke(listener);
        return NOOP_DISPOSABLE;
      }
      const wrapped = (): void => safeInvoke(listener);
      signal.addEventListener('abort', wrapped, { once: true });
      return { dispose: () => signal.removeEventListener('abort', wrapped) };
    },
  };
}

export function toAbortSignal(token: CancellationToken | undefined): AbortSignal {
  const controller = new AbortController();
  if (!token) return controller.signal;

  if (token.isCancellationRequested) {
    controller.abort();
  } else {
    /*
    | P-05/SE-P-003 — ثبتِ خام، disposable را دور می‌ریخت: تا لغو شدن
    |ِ source (که ممکن است هرگز رخ ندهد) closure متعلق به signalِ
    | دورریخته‌شده روی tokenِ طولانی‌عمر می‌ماند. حالا شنونده پس از
    | یک بار fire، اشتراکش را آزاد می‌کند؛ رفتار abort یکسان است و
    | رشدِ listener در مصرفِ پرتعدادِ sourceهای طولانی‌عمر بسته می‌شود.
    */
    let registration: Disposable | undefined;
    registration = token.onCancellationRequested(() => {
      registration?.dispose();
      controller.abort();
    });
  }

  return controller.signal;
}

/** جای سه‌خط `if (token?.isCancellationRequested) return err(...)`. */
export function throwIfCancelled(token: CancellationToken | undefined, what?: string): void {
  if (token?.isCancellationRequested) {
    throw new CancellationError(what ? `${what} was cancelled` : undefined);
  }
}
