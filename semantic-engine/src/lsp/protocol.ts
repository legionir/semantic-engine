/**
 * تایپ‌های سیم LSP — فقط آنچه واقعاً مصرف می‌کنیم.
 *
 * عمداً `vscode-languageserver-protocol` را وابستگی نکردیم. آن پکیج
 * کل پروتکل ۳٫۱۸ را می‌آورد در حالی که این زیرسیستم چند پیام محدود
 * می‌فرستد، و مهم‌تر: تایپ‌های symbol پروژه از قبل در
 * `src/symbols/types.ts` تعریف شده‌اند (فاز ۱۰) و داشتن دو تعریف
 * موازی از `DocumentSymbol` دقیقاً همان لغزش خاموشی است که فاز ۱۰
 * دربارهٔ شماره‌گذاری `SymbolKind` گرفت.
 *
 * شکل‌ها با probe روی `tsgo --lsp --stdio` (نسخهٔ ۷٫۰٫۲) تأیید شده‌اند،
 * نه از روی مستندات نوشته شده‌اند.
 */

import { DocumentSymbolLike, RangeLike } from '../symbols/types';

/** `textDocument/documentSymbol` یکی از این دو شکل را برمی‌گرداند. */
export type DocumentSymbolResult = DocumentSymbolLike[] | SymbolInformationLike[] | null;

/** شکل قدیمی و تخت `documentSymbol` — سرورهای بی‌سلسله‌مراتب. */
export interface SymbolInformationLike {
  readonly name: string;
  readonly kind: number;
  readonly location: { readonly uri: string; readonly range: RangeLike };
  readonly containerName?: string;
  readonly tags?: readonly number[];
  readonly deprecated?: boolean;
}

/** تشخیص اینکه پاسخ سلسله‌مراتبی است یا تخت. */
export function isHierarchical(
  result: DocumentSymbolResult
): result is DocumentSymbolLike[] {
  return Array.isArray(result) && (result.length === 0 || 'range' in result[0]);
}

/** `textDocumentSync.change` — مرجع: LSP 3.17. */
export enum TextDocumentSyncKind {
  None = 0,
  Full = 1,
  Incremental = 2,
}

export interface TextDocumentSyncOptions {
  readonly openClose?: boolean;
  readonly change?: TextDocumentSyncKind;
  readonly save?: boolean | { includeText?: boolean };
}

/**
 * فقط فیلدهایی که واقعاً می‌خوانیم؛ بقیه از سرور می‌آید و دست‌نخورده
 * می‌ماند. `tsgo` بیست‌وهشت کلید اعلام می‌کند و تایپ کردن همه‌شان
 * ارزشی ندارد.
 */
export interface ServerCapabilities {
  readonly positionEncoding?: 'utf-8' | 'utf-16' | 'utf-32' | string;
  readonly textDocumentSync?: TextDocumentSyncOptions | TextDocumentSyncKind;
  readonly documentSymbolProvider?: boolean | Record<string, unknown>;
  readonly hoverProvider?: boolean | Record<string, unknown>;
  readonly referencesProvider?: boolean | Record<string, unknown>;
  readonly definitionProvider?: boolean | Record<string, unknown>;
  readonly renameProvider?: boolean | Record<string, unknown>;
  readonly callHierarchyProvider?: boolean | Record<string, unknown>;
  readonly diagnosticProvider?: Record<string, unknown>;
  readonly codeActionProvider?: boolean | Record<string, unknown>;
  readonly workspaceSymbolProvider?: boolean | Record<string, unknown>;
  readonly [key: string]: unknown;
}

export interface ServerInfo {
  readonly name: string;
  readonly version?: string;
}

export interface InitializeResult {
  readonly capabilities: ServerCapabilities;
  readonly serverInfo?: ServerInfo;
}

/** شدت در `Diagnostic` — مرجع: LSP 3.17. */
export enum DiagnosticSeverity {
  Error = 1,
  Warning = 2,
  Information = 3,
  Hint = 4,
}

export interface DiagnosticLike {
  readonly range: RangeLike;
  readonly severity?: DiagnosticSeverity;
  readonly code?: string | number;
  readonly source?: string;
  readonly message: string;
  readonly tags?: readonly number[];
}

export interface PublishDiagnosticsParams {
  readonly uri: string;
  readonly version?: number;
  readonly diagnostics: readonly DiagnosticLike[];
}

export interface ProgressParams {
  readonly token: string | number;
  readonly value: unknown;
}

/**
 * پاسخ سرور به یک متد ناشناخته.
 *
 * ⚠ probe روی `tsgo`: پاسخ به متد ناموجود کد **‎-32600
 * (InvalidRequest)** بود، نه ‎-32601 (MethodNotFound) که استاندارد
 * می‌گوید. پس نمی‌شود «پشتیبانی نمی‌شود» را از روی کد خطا تشخیص داد؛
 * کاوش قابلیت (فاز ۳۳) باید به نتیجهٔ واقعی نگاه کند.
 */
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_REQUEST = -32600;
