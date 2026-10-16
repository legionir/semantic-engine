/**
 * SecretRedactor — حذف/ماسک کردن secretهای احتمالی قبل از ارسال به LLM.
 *
 * این یک دفاع اولیه است و جایگزین security review کامل نمی‌شود.
 */

export class SecretRedactor {
  private readonly patterns: { readonly regex: RegExp; readonly replacement: string }[] = [
    // ── توکن‌های با شکل شناخته‌شده ──────────────────────────────
    // این‌ها پیش از الگوهای عمومی می‌آیند تا جایگزینی دقیق‌تری بدهند.
    {
      regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
      replacement: '[REDACTED_GITHUB_TOKEN]',
    },
    {
      regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
      replacement: '[REDACTED_GITHUB_TOKEN]',
    },
    {
      regex: /\bAKIA[0-9A-Z]{16}\b/g,
      replacement: '[REDACTED_AWS_KEY_ID]',
    },
    {
      regex: /\baws_secret_access_key\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/gi,
      replacement: 'aws_secret_access_key=[REDACTED_AWS_SECRET]',
    },
    {
      // JWT: سه بخش base64url جداشده با نقطه
      regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
      replacement: '[REDACTED_JWT]',
    },
    {
      regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
      replacement: '[REDACTED_SLACK_TOKEN]',
    },
    {
      // بدنه می‌تواند خط تیره و زیرخط داشته باشد: sk-live-…, sk_test_…, sk-proj-…
      regex: /\b(?:sk|pk|rk)[-_](?:live|test|proj)?[-_]?[A-Za-z0-9][A-Za-z0-9_-]{10,}\b/g,
      replacement: '[REDACTED_API_KEY]',
    },
    {
      // رشتهٔ اتصال با رمز داخل آن
      regex: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):[^\s@/]+@/gi,
      replacement: '$1:[REDACTED]@',
    },

    {
      regex: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
      replacement: '[REDACTED_PRIVATE_KEY]',
    },
    {
      regex: /api[_-]?key\s*[:=]\s*['"]?[a-zA-Z0-9_-]{16,}['"]?/gi,
      replacement: 'api_key=[REDACTED_API_KEY]',
    },
    {
      regex: /(bearer|token)\s+['"]?[a-zA-Z0-9_.-]{20,}['"]?/gi,
      replacement: '$1 [REDACTED_TOKEN]',
    },
    {
      regex: /password\s*[:=]\s*['"][^'"]{4,}['"]/gi,
      replacement: 'password=[REDACTED_PASSWORD]',
    },
    {
      regex: /secret\s*[:=]\s*['"][^'"]{8,}['"]/gi,
      replacement: 'secret=[REDACTED_SECRET]',
    },
  ];

  redact(content: string): string {
    let result = content;
    for (const { regex, replacement } of this.patterns) {
      result = result.replace(regex, replacement);
    }
    return result;
  }
}
