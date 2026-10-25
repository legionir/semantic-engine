/**
 * RateLimiter — a small fixed-window limiter for the public auth/verify oracle
 * (F-0009).
 *
 * `POST /auth/verify` is reachable with no token. Its response distinguishes a
 * valid token from an invalid one, so it is a token-enumeration oracle: an
 * attacker can hammer it guessing `sk_plat_…` values. The honest, low-risk fix
 * is to throttle per-client, so automated enumeration is impractical while a
 * legitimate occasional verify still succeeds.
 *
 * Fixed window (count resets every `windowMs`) — deliberately simple, no
 * external store, sufficient for a single-process loopback server.
 */

export interface RateLimiterOptions {
  /** Maximum requests allowed per window before a request is rejected. */
  readonly limit: number;
  /** Window length in milliseconds. */
  readonly windowMs: number;
}

export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly options: RateLimiterOptions) {}

  /**
   * Returns `{ allowed, retryAfterMs }`. When denied, `retryAfterMs` is how
   * long until the window that currently blocks this key rolls over.
   */
  check(key: string, now = Date.now()): { allowed: boolean; retryAfterMs: number } {
    const entry = this.windows.get(key);
    if (!entry || now >= entry.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + this.options.windowMs });
      return { allowed: true, retryAfterMs: 0 };
    }
    if (entry.count < this.options.limit) {
      entry.count += 1;
      return { allowed: true, retryAfterMs: 0 };
    }
    return { allowed: false, retryAfterMs: entry.resetAt - now };
  }

  /** Drop expired windows so a long-lived process does not grow unbounded. */
  prune(now = Date.now()): void {
    for (const [key, entry] of this.windows) {
      if (now >= entry.resetAt) this.windows.delete(key);
    }
  }
}
