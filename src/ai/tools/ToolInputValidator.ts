/**
 * ToolInputValidator — SE-AI-01.
 *
 * ## آنچه جایگزین می‌کند
 *
 * ```ts
 * const required = Array.isArray(schema.required) ? schema.required : [];
 * for (const key of required) {
 *   if (!(key in input) || input[key] === undefined) return { error: `Missing ${key}` };
 * }
 * ```
 *
 * فقط *وجود داشتن* فیلدها. هیچ بررسی نوع، enum یا محدوده‌ای — با
 * اینکه هر ابزار یک JSON Schema کامل دارد و `ajv` هم از قبل در
 * وابستگی‌هاست و جای دیگری از همین مخزن استفاده می‌شود.
 *
 * اجرای واقعی روی رجیستری پیش از رفع:
 *
 * ```
 * get_dependencies { id: 123, direction: 'sideways' }  →  ACCEPTED
 * semantic_search  { query: 'x', limit: 'ten' }        →  ACCEPTED
 * semantic_search  { query: { not: 'a string' } }      →  «text.toLowerCase is not a function»
 * ```
 *
 * سومی مهم‌ترین است: ورودیِ نامعتبر تا عمقِ پیاده‌سازی می‌رفت و پیامِ
 * خطای داخلی به مصرف‌کننده درز می‌کرد. برای سروری که با یک مدل حرف
 * می‌زند، این هم نشتِ جزئیات است و هم پیامی که مدل نمی‌تواند بر
 * اساسش خودش را تصحیح کند.
 *
 * ## تصمیم‌ها
 *
 * **`strict: false`** — schemaهای ابزارها `default` و `oneOf` دارند و
 * حالت سخت‌گیرانهٔ ajv بعضی‌شان را رد می‌کند. هدف اعتبارسنجیِ *ورودی*
 * است، نه ممیزیِ خودِ schema.
 *
 * **`useDefaults` خاموش** — پر کردن مقادیر پیش‌فرض یعنی ajv ورودی را
 * تغییر دهد. هر ابزار خودش پیش‌فرض‌هایش را با `??` اعمال می‌کند و دو
 * جای پیش‌فرض‌گذاری، دیر یا زود از هم واگرا می‌شوند.
 *
 * **`allErrors: true`** — یک مدل که سه فیلد را اشتباه فرستاده باید هر
 * سه را در یک پاسخ ببیند، نه اینکه سه بار رفت‌وبرگشت کند.
 *
 * **کامپایل تنبل و کش‌شده** — `ajv.compile` گران است و رجیستری در هر
 * پروسه چند بار ساخته می‌شود.
 */

import Ajv, { ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

import { AiTool, AiToolInput } from './types';

export type ValidationOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

export class ToolInputValidator {
  private readonly ajv: Ajv;
  private readonly compiled = new Map<string, ValidateFunction | null>();

  constructor() {
    this.ajv = new Ajv({
      allErrors: true,
      strict: false,
      useDefaults: false,
      coerceTypes: false,
    });
    addFormats(this.ajv);
  }

  validate(tool: AiTool, input: AiToolInput): ValidationOutcome {
    const validate = this.validatorFor(tool);

    /*
    | schemaیی که کامپایل نمی‌شود، نباید ابزار را از کار بیندازد.
    | این یک نقصِ خودِ ابزار است و جایش لینت و آزمون است، نه ردکردنِ
    | فراخوانیِ کاربر در زمان اجرا.
    */
    if (!validate) return { ok: true };

    if (validate(input)) return { ok: true };

    const errors = validate.errors ?? [];
    const messages = errors.map(error => {
      const field = fieldOf(error);
      const detail = describe(error);
      return field ? `${field}: ${detail}` : detail;
    });

    const unique = [...new Set(messages)];
    return {
      ok: false,
      error: `Invalid input for '${tool.name}' — ${unique.join('; ')}`,
    };
  }

  private validatorFor(tool: AiTool): ValidateFunction | null {
    const cached = this.compiled.get(tool.name);
    if (cached !== undefined) return cached;

    let validate: ValidateFunction | null = null;
    try {
      validate = this.ajv.compile(tool.inputSchema);
    } catch {
      validate = null;
    }
    this.compiled.set(tool.name, validate);
    return validate;
  }
}

/** نام فیلدی که خطا به آن مربوط است، به شکلی که یک آدم بخواند. */
function fieldOf(error: { instancePath?: string; params?: Record<string, unknown> }): string {
  const missing = error.params?.missingProperty;
  if (typeof missing === 'string') return missing;

  const path = error.instancePath ?? '';
  if (path.length === 0) return '';
  return path.replace(/^\//, '').replace(/\//g, '.');
}

/**
 * پیام ajv، کمی خواناتر.
 *
 * پیامِ خامِ ajv برای enum فقط «must be equal to one of the allowed
 * values» است و نمی‌گوید آن مقادیر چه‌اند — یعنی دقیقاً همان چیزی که
 * یک مدل برای تصحیح خودش لازم دارد را حذف می‌کند.
 */
function describe(error: {
  keyword?: string;
  message?: string;
  params?: Record<string, unknown>;
}): string {
  if (error.keyword === 'enum') {
    const allowed = error.params?.allowedValues;
    if (Array.isArray(allowed)) {
      return `must be one of ${allowed.map(v => JSON.stringify(v)).join(', ')}`;
    }
  }
  if (error.keyword === 'required') return 'is required';
  return error.message ?? 'is invalid';
}
