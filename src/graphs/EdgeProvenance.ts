/**
 * Provenance یال — از کجا آمده و چقدر می‌شود به آن اعتماد کرد.
 *
 * چهار نوع یال در گراف هست و تا فاز ۱۹ هیچ‌کدام منشأ خود را
 * نمی‌گفتند. یالی که از تطبیق نام سراسری ساخته شده — «اولین symbol با
 * این نام در کل پروژه» — با یالی که مستقیم از AST خوانده شده یکسان
 * دیده می‌شد.
 *
 * این برای بلوک F مسدودکننده است: آن بلوک روی همین یال‌ها مسیر پیدا
 * می‌کند و برای آدم توضیح می‌سازد. یک گراف که نمی‌تواند بگوید کدام
 * یالش حدس است، مسیرهای **مطمئنِ غلط** تولید می‌کند — که از نداشتن
 * مسیر بدتر است.
 */

import { ExtractionSource } from '../core/types/common.types';
import { sha256 } from '../core/utils/hash';

/**
 * چگونگی به دست آمدن یک یال.
 *
 *   resolved        — خودِ کامپایلر (زبان‌سرور) گفته این دو به هم وصل‌اند
 *   ast             — هر دو سر از نحو همان فایل خوانده شده‌اند
 *   import-resolved — مقصد از راه importی که به فایل واقعی resolve شد
 *   declared        — در خود کد اعلام شده (extends، دستور import)
 *   name-match      — «اولین symbol هم‌نام در کل پروژه»
 *   unresolved      — مقصد یک نام است، نه یک symbol شناخته‌شده
 */
export type EdgeBasis =
  | 'resolved'
  | 'ast'
  | 'import-resolved'
  | 'declared'
  | 'name-match'
  | 'unresolved';

/**
 * اعتماد پیش‌فرض هر مبنا.
 *
 * `name-match` عمداً روی ۴۰ است — زیر آستانهٔ ۷۰. در هر مخزنی که دو
 * `handle` یا دو `run` داشته باشد، تطبیق نام سراسری اشتباه است؛ عددی
 * که آن را «قابل اتکا» نشان دهد، دروغ است.
 */
export const EDGE_CONFIDENCE: Readonly<Record<EdgeBasis, number>> = {
  /*
  | بالاتر از `ast`: پیمایش AST خودمان می‌داند در این فایل چه نوشته
  | شده، ولی زبان‌سرور می‌داند نام به کدام اعلان **resolve** می‌شود —
  | با overload، alias، re-export و ارث‌بری. (فاز ۳۷، LSP-17)
  */
  resolved: 98,
  ast: 95,
  'import-resolved': 85,
  declared: 90,
  'name-match': 40,
  unresolved: 25,
};

/** آستانهٔ «قابل اتکا» — مصرف‌کننده‌ها می‌توانند سخت‌گیرتر باشند. */
export const HIGH_CONFIDENCE_THRESHOLD = 70;

export interface EdgeLocation {
  readonly file: string;
  readonly line: number;
}

export interface EdgeProvenance {
  /** کدام استخراج‌گر این یال را ساخت. */
  readonly extractor: ExtractionSource;
  /** ۰ تا ۱۰۰. */
  readonly confidence: number;
  readonly basis: EdgeBasis;
  readonly location?: EdgeLocation;
}

export function provenanceFor(
  basis: EdgeBasis,
  extractor: ExtractionSource,
  location?: EdgeLocation
): EdgeProvenance {
  const provenance: EdgeProvenance = {
    extractor,
    confidence: EDGE_CONFIDENCE[basis],
    basis,
  };

  return location ? { ...provenance, location } : provenance;
}

export function isHighConfidence(
  provenance: EdgeProvenance,
  threshold: number = HIGH_CONFIDENCE_THRESHOLD
): boolean {
  return provenance.confidence >= threshold;
}

// ── شناسهٔ یال ────────────────────────────────────────────────────────────

export interface EdgeIdentity {
  readonly from: string;
  readonly to: string;
  readonly kind: string;
  readonly line?: number | null;
  /**
   * چندمین یالِ کاملاً یکسان روی همان خط.
   *
   * `f(g(), g())` دو یال یکسان روی یک خط است. بدون تفکیک، هر نگاشتی
   * که کلیدش شناسهٔ یال باشد یکی را روی دیگری می‌نویسد.
   */
  readonly occurrence?: number;
}

/**
 * شناسه از **محتوای** یال.
 *
 * SE-GRAPH-04: شناسهٔ قبلی `hash('call-edge-' + counter)` بود، یعنی
 * فقط جایگاه را کد می‌کرد. اندازه‌گیری‌شده: دو پروژهٔ کاملاً بی‌ربط
 * همان فهرست شناسه را تولید می‌کردند. هر مصرف‌کننده‌ای که شناسهٔ یال
 * را بین دو اجرا نگه دارد — کش، دیتابیس، حاشیه‌نویسی کاربر — به یال
 * دیگری اشاره می‌کند.
 */
export function makeEdgeId(identity: EdgeIdentity): string {
  const parts = [
    identity.from,
    identity.to,
    identity.kind,
    identity.line ?? '',
    /*
    | P-05/SE-P-002 — `identity.occurrence ? ...` مقدارِ `0` را مثلِ
    | غایب encode می‌کرد. سازندهٔ هویت (`CallGraphBuilder.occurrenceOf`)
    | از صفر شمارش می‌کند، پس *اولین* یالِ یک گروه با هیچِ occurrence
    | یک شناسه می‌گرفت — همان collisions که این فیلد برای جلوگیری از
    | آن‌ها طراحی شده بود. حالا صفر صریح «occ:0» است و غایب رشتهٔ خالی.
    */
    identity.occurrence !== undefined ? `occ:${identity.occurrence}` : '',
  ];

  return sha256(parts.join('\u0000')).substring(0, 16);
}

// ── فضای نام مقصد وابستگی ─────────────────────────────────────────────────

const PACKAGE_PREFIX = 'pkg:';

/**
 * علامت‌گذاری مقصدی که فایل نیست.
 *
 * SE-GRAPH-01: `DependencyEdge.to` هم fileId می‌گرفت و هم نام خام
 * ماژول. روی snapshot، ۱۶ یال از ۳۶ به چیزی اشاره می‌کردند که fileId
 * نبود. با یک فضای نام مشترک، «شناسهٔ ناشناخته» از «پکیج خارجی»
 * قابل تشخیص نیست — به همین دلیل بررسی یال معلق در اعتبارسنج هرگز
 * نوشته نشد (SE-EXP-11).
 */
export function packageRef(moduleName: string): string {
  return moduleName.startsWith(PACKAGE_PREFIX)
    ? moduleName
    : `${PACKAGE_PREFIX}${moduleName}`;
}

export function isPackageRef(target: string): boolean {
  return target.startsWith(PACKAGE_PREFIX);
}

export function packageNameOf(target: string): string | null {
  return isPackageRef(target) ? target.slice(PACKAGE_PREFIX.length) : null;
}
