import * as crypto from 'crypto';

/**
 * SHA-256 hash — برای content hashing.
 * SHA-256 به‌جای SHA-1 به دلیل مقاومت بهتر در برابر collision.
 */
export function sha256(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * تولید file id از relative path.
 *
 * طراحی:
 * - id بر اساس path است (نه محتوا) → rename = id جدید
 * - normalize می‌شود تا تفاوت OS (backslash vs forward slash) مهم نباشد
 * - hash کوتاه (16 کاراکتر) کافی است چون فقط در scope یک پروژه یکتا باید باشد
 */
export function generateFileId(relativePath: string): string {
  const normalized = normalizePath(relativePath);
  return sha256(normalized).substring(0, 16);
}

/**
 * تولید symbol id.
 *
 * فرمول: hash(fullyQualifiedName + ':' + kind)
 * - پایدار تا وقتی نام و نوع symbol تغییر نکند
 * - rename فایل id symbol را عوض نمی‌کند (چون fqName شامل module path منطقی است، نه فیزیکی)
 */
export function generateSymbolId(fullyQualifiedName: string, kind: string): string {
  const input = `${fullyQualifiedName}:${kind}`;
  return sha256(input).substring(0, 16);
}

/**
 * Normalize path: همیشه forward slash، بدون leading ./، lowercase نمی‌شود
 * (چون فایل‌سیستم‌های case-sensitive وجود دارند).
 */
export function normalizePath(filePath: string): string {
  return filePath
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/');
}
