/**
 * ToolResultCache — cache نتایج AI tools برای کاهش latency.
 *
 * Invalidation بر اساس hash ورودی + hash محتوای project-index.
 */

import { AiToolInput, AiToolOutput } from './types';

/**
 * `JSON.stringify` با کلیدهای مرتب‌شده، به‌صورت بازگشتی.
 *
 * `undefined` مثل فیلدِ غایب رفتار می‌کند، همان‌طور که
 * `JSON.stringify` هم می‌کند — تا `{q:'a', extra: undefined}` و
 * `{q:'a'}` یک کلید بگیرند.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);

  return `{${entries.join(',')}}`;
}

export interface ToolResultCacheOptions {
  readonly maxSize?: number;
  readonly ttlMs?: number;
}

interface CacheEntry {
  readonly result: AiToolOutput;
  readonly projectHash: string;
  readonly timestamp: number;
}

export class ToolResultCache {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly options: ToolResultCacheOptions = {}) {}

  /**
   * کلیدِ پایدار — SE-AI-07.
   *
   * قبلاً `JSON.stringify(input)` بود، که به **ترتیب فیلدها** حساس
   * است: `{a:1,b:2}` و `{b:2,a:1}` دو کلید متفاوت می‌شدند، در حالی
   * که همان فراخوانی‌اند. یک مصرف‌کنندهٔ MCP که فیلدها را به ترتیب
   * دیگری بفرستد، هرگز به کش نمی‌خورد.
   *
   * کلیدهای شیء مرتب می‌شوند، آرایه‌ها **نه** — ترتیب عناصر آرایه
   * بخشی از معنای ورودی است (`targetFiles: ['a','b']`).
   */
  private makeKey(toolName: string, input: AiToolInput): string {
    return `${toolName}:${stableStringify(input)}`;
  }

  get(toolName: string, input: AiToolInput, projectHash: string): AiToolOutput | undefined {
    const key = this.makeKey(toolName, input);
    const entry = this.cache.get(key);

    if (!entry) return undefined;

    // Invalidation بر اساس تغییر project-index
    if (entry.projectHash !== projectHash) {
      this.cache.delete(key);
      return undefined;
    }

    // TTL check
    const ttl = this.options.ttlMs ?? 5 * 60 * 1000; // default 5 minutes
    if (Date.now() - entry.timestamp > ttl) {
      this.cache.delete(key);
      return undefined;
    }

    /*
    | SE-AI-07 — همین جا بود که LRU نبودن مشخص می‌شد: `get` ترتیب را
    | به‌روز نمی‌کرد. در `Map` جاوااسکریپت، حذف و درجِ دوباره یعنی
    | «تازه‌ترین». بدون این خط، پرکاربردترین ورودی همان اولی است که
    | بیرون انداخته می‌شود.
    */
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.result;
  }

  set(toolName: string, input: AiToolInput, projectHash: string, result: AiToolOutput): void {
    const key = this.makeKey(toolName, input);

    // نوشتنِ دوباره هم یک «استفاده» است.
    this.cache.delete(key);

    const maxSize = this.options.maxSize ?? 100;
    while (this.cache.size >= maxSize) {
      const leastRecentlyUsed = this.cache.keys().next().value;
      if (leastRecentlyUsed === undefined) break;
      this.cache.delete(leastRecentlyUsed);
    }

    this.cache.set(key, {
      result,
      projectHash,
      timestamp: Date.now(),
    });
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}
