/**
 * پیکربندی زیرسیستم LSP — LSP-12.
 *
 * شش کلید در `contracts/config.schema.json` و یک تابع که آن‌ها را به
 * گزینه‌های `LspServerManager` تبدیل می‌کند. جدا نگه داشتنش دو
 * فایده دارد: `LspServerManager` به `Config` وابسته نمی‌شود (و در
 * آزمون‌ها بدون فایل پیکربندی ساخته می‌شود)، و تنها جایی که
 * نام‌کلیدها نوشته می‌شوند همین‌جاست.
 *
 * ── چرا `enabled` پیش‌فرض خاموش است ────────────────────────────────
 *
 * اندازه‌گیری `LSP-ARCHITECTURE.md` روی ۱۶۴ فایل همین مخزن:
 * tree-sitter ۲۱۳ms و ۶۵MB، زبان‌سرور ۷٬۷۴۱ms و ۸۰۹MB. روشن بودن
 * پیش‌فرض یعنی هر کاربری که فقط `index` می‌زند، سی‌وشش برابر صبر
 * می‌کند برای دقتی که شاید نخواسته.
 */

import { Config } from '../host/Config';
import { LspServerManagerOptions } from './LspServerManager';
import { ServerOverride } from './registry';

export interface LspSettings {
  readonly enabled: boolean;
  readonly requestTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly warmupTimeoutMs: number;
  readonly maxServerMemoryMb: number;
  readonly servers: Readonly<Record<string, ServerOverride>>;
}

/** فقط خواندن؛ اعتبارسنجی کار خود `Config` است. */
export function lspSettingsFrom(config: Config): LspSettings {
  return {
    enabled: config.get<boolean>('semanticEngine.lsp.enabled', false),
    requestTimeoutMs: config.get<number>('semanticEngine.lsp.requestTimeoutMs', 15_000),
    idleTimeoutMs: config.get<number>('semanticEngine.lsp.idleTimeoutMs', 600_000),
    warmupTimeoutMs: config.get<number>('semanticEngine.lsp.warmupTimeoutMs', 120_000),
    maxServerMemoryMb: config.get<number>('semanticEngine.lsp.maxServerMemoryMB', 2048),
    servers: normalizeOverrides(config.get<unknown>('semanticEngine.lsp.servers', {})),
  };
}

/**
 * `idleTimeoutMs: 0` در schema یعنی «هرگز خاموش نکن».
 *
 * صفر را مستقیم به مدیر دادن، برعکسش را می‌کرد: هر سرور بلافاصله
 * reap می‌شد. همان دستهٔ SE-EXT-07 است — صفر در یک سقف زمانی، دو
 * معنی کاملاً متضاد دارد و باید صریح ترجمه شود.
 */
export function managerOptionsFrom(
  settings: LspSettings,
  base: Pick<LspServerManagerOptions, 'workspaceRoot' | 'logger'>
): LspServerManagerOptions {
  return {
    ...base,
    requestTimeoutMs: settings.requestTimeoutMs,
    idleTimeoutMs: settings.idleTimeoutMs === 0 ? Number.POSITIVE_INFINITY : settings.idleTimeoutMs,
    warmupTimeoutMs: settings.warmupTimeoutMs,
    memoryLimitMb: settings.maxServerMemoryMb,
  };
}

function normalizeOverrides(raw: unknown): Readonly<Record<string, ServerOverride>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, ServerOverride> = {};

  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const command = typeof entry.command === 'string' ? entry.command : undefined;
    const disabled = entry.disabled === true;
    const args = Array.isArray(entry.args)
      ? entry.args.filter((item): item is string => typeof item === 'string')
      : undefined;
    /*
    | یک ورودی بی‌محتوا (`{"gopls": {}}`) نگه داشته نمی‌شود: وجودش
    | در نقشه یعنی «کاربر دربارهٔ این سرور تصمیمی گرفته»، و آن
    | تصمیم بعداً `command` نداشتن را به معنی چیز دیگری می‌گیرد.
    */
    if (!command && !disabled && !args) continue;
    out[id] = { command, args, disabled };
  }
  return out;
}
