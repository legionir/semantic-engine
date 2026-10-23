/**
 * Types of the explain_symbol tool (split from ExplainSymbolTool.ts, unchanged).
 */

import type { AiToolInput } from './types';

export interface ExplainSymbolInput extends AiToolInput {
  /** شناسهٔ symbol. */
  readonly id?: string;
  /** یا نامش — اگر یکتا نبود، همهٔ نامزدها گزارش می‌شوند. */
  readonly name?: string;
  /** برای رفع ابهام نام. */
  readonly path?: string;
  /** چند فراخوان و فراخوانده در خروجی. پیش‌فرض ۲۰. */
  readonly limit?: number;
  /** پیش‌فرض ۰ — اینجا **همه‌چیز** نشان داده می‌شود، با برچسب. */
  readonly minConfidence?: number;
}

/** یک طرف رابطه، با منشأش. */
export interface RelatedSymbol {
  readonly id: string;
  readonly name: string;
  readonly path?: string;
  readonly line?: number;
  readonly basis: string;
  readonly confidence: number;
}

export interface SymbolExplanation {
  readonly id: string;
  readonly symbol: string;
  readonly kind: string;
  readonly file?: string;
  readonly line: number;
  readonly endLine: number;
  readonly signature: string;
  readonly visibility: string;
  readonly exported: boolean;
  readonly deprecated: boolean;
  readonly documentation: string | null;
  readonly complexity: number | null;
  readonly referenceCount: number | null;
  readonly parameters: readonly unknown[];
  readonly returnType: string | null;
  readonly calls: readonly RelatedSymbol[];
  readonly calledBy: readonly RelatedSymbol[];
  /*
  | SE-AI-HONESTY (P-06) — `calls`/`calledBy`/`members` هر سه به `limit`
  | می‌خورند. بدون اعلامِ برش، AI لیستِ سقف‌خورده را «همهٔ فراخوانی‌ها»
  | می‌خواند و مثلاً برای refactor دامنهٔ اثر را کوچک‌ازحد می‌گیرد. این
  | سه فیلد، شمارشِ کامل (پیش از برش) و خودِ پرچم برش را می‌آورند.
  */
  /** شمارش کامل یال‌های منحصربه‌فرد call، پیش از برش `limit`. */
  readonly callsCount: number;
  /** شمارش کامل یال‌های منحصربه‌فرد caller، پیش از برش `limit`. */
  readonly calledByCount: number;
  /** آیا برشِ `limit` چیزی از بین برد؟ + سقفِ اعمال‌شده. */
  readonly truncated: {
    readonly calls: boolean;
    readonly calledBy: boolean;
    readonly members: boolean;
    readonly any: boolean;
    readonly limit: number;
  };
  /**
   * اعضای یک سمبل اعلانی (کلاس/اینترفیس/…), با همان امضا و پیچیدگی هر عضو.
   *
   * تا پیش از این `explain_symbol` روی یک کلاس عملاً خالی برمی‌گشت:
   * یال‌های فراخوانی به سازنده/متدها وصل‌اند نه به خودِ کلاس، پس
   * `calls`/`calledBy` خالی می‌شد و `complexity` هم `null` — یعنی
   * «کلاسی با چهل متد» و «کلاسی که هیچ‌کس نمی‌شناسد» یک پاسخ داشتند.
   */
  readonly members?: readonly {
    readonly id: string;
    readonly name: string;
    readonly kind: string;
    readonly line: number;
    readonly visibility: string;
    readonly signature: string;
    readonly complexity: number | null;
    readonly exported: boolean;
  }[];
  /** شمارش کامل اعضا — حتی وقتی `members` به سقف `limit` خورده است. */
  readonly memberCount?: number;
  /** جمع پیچیدگی اعضا؛ `null` اگر هیچ عضوی عدد داشته باشد. */
  readonly aggregateComplexity?: number | null;
  /** چند گره مستقل به خودِ این سمبل یا اعضای آن اشاره می‌کنند. */
  readonly referencedBy?: { readonly sources: number; readonly files: number };
  /** وقتی calls/calledBy از اعضا جمع شده‌اند، همین‌جا گفته می‌شود. */
  readonly aggregation?: { readonly owners: number; readonly fromMembers: number };
  /**
   * تست‌ها، با **دلیل** پیدا شدنشان.
   *
   * `find_tests` دلیلش را از قبل حساب می‌کرد و در فیلد `source`
   * می‌گذاشت؛ نسخهٔ اول این ابزار فقط مسیرها را برمی‌داشت. روی
   * ایندکس واقعی، `runDoctor` دو فایل تستِ کاملاً بی‌ربط می‌گرفت و
   * هیچ راهی نبود که مدل بفهمد آن‌ها یک حدسِ نامِ فایل‌اند
   * (SE-AI-15).
   */
  readonly tests: readonly { readonly path: string; readonly reason: string }[];
  readonly git?: { readonly commitCount: number; readonly hotspotScore: number };
  readonly aiScore?: { readonly importance: number; readonly hotness: number; readonly readPriority: number };
  readonly diagnostics: readonly { readonly severity: string; readonly line: number; readonly message: string }[];
  /** منشأ هر بخش — همان چیزی که خروجیِ وصله‌شدهٔ دستی ندارد. */
  readonly confidence: {
    readonly symbol: number;
    readonly source: string;
    readonly calls: string;
    readonly calledBy: string;
    readonly weakCalls: number;
    readonly weakCalledBy: number;
  };
}
