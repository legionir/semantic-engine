/**
 * تایپ‌های symbol مستقل از ویرایشگر — MIG-30 و LSP-02.
 *
 * یک خطای خاموش که ارزیابی پیدا کرد و این فایل برای بستنش وجود دارد:
 *
 *   شماره‌گذاری `SymbolKind` در VS Code از صفر شروع می‌شود
 *   (`File=0 … TypeParameter=25`) و در خود پروتکل LSP از یک
 *   (`File=1 … TypeParameter=26`).
 *
 * `mapVSCodeSymbolKind` قدیمی برای جدول صفرمبنا نوشته شده بود. لحظه‌ای
 * که همان تابع به یک زبان‌سرور واقعی وصل شود، *هر* symbol یک رده
 * جابه‌جا می‌شود: کلاس‌ها به interface و متدها به property تبدیل
 * می‌شوند، بی‌هیچ خطایی. هیچ تستی چنین چیزی را نمی‌گرفت.
 */

import {
  LspSymbolKind,
  VsCodeSymbolKind,
  lspKindFromVsCode,
  vsCodeKindFromLsp,
  LSP_SYMBOL_KIND_NAMES,
} from './types';

/** جدول رسمی، دستی نوشته‌شده از متن مشخصات LSP 3.17 و vscode.d.ts. */
const TABLE: ReadonlyArray<readonly [name: string, vscode: number, lsp: number]> = [
  ['File', 0, 1],
  ['Module', 1, 2],
  ['Namespace', 2, 3],
  ['Package', 3, 4],
  ['Class', 4, 5],
  ['Method', 5, 6],
  ['Property', 6, 7],
  ['Field', 7, 8],
  ['Constructor', 8, 9],
  ['Enum', 9, 10],
  ['Interface', 10, 11],
  ['Function', 11, 12],
  ['Variable', 12, 13],
  ['Constant', 13, 14],
  ['String', 14, 15],
  ['Number', 15, 16],
  ['Boolean', 16, 17],
  ['Array', 17, 18],
  ['Object', 18, 19],
  ['Key', 19, 20],
  ['Null', 20, 21],
  ['EnumMember', 21, 22],
  ['Struct', 22, 23],
  ['Event', 23, 24],
  ['Operator', 24, 25],
  ['TypeParameter', 25, 26],
];

describe('SymbolKind numbering', () => {

  it('covers all 26 kinds', () => {
    expect(TABLE).toHaveLength(26);
    expect(Object.keys(LSP_SYMBOL_KIND_NAMES)).toHaveLength(26);
  });

  it.each(TABLE)('%s is %i in VS Code', (name, vscode) => {
    expect(VsCodeSymbolKind[name as keyof typeof VsCodeSymbolKind]).toBe(vscode);
  });

  it.each(TABLE)('%s is %i in LSP', (name, _vscode, lsp) => {
    expect(LspSymbolKind[name as keyof typeof LspSymbolKind]).toBe(lsp);
  });

  it.each(TABLE)('%s converts from VS Code to LSP', (_name, vscode, lsp) => {
    expect(lspKindFromVsCode(vscode)).toBe(lsp);
  });

  it.each(TABLE)('%s converts from LSP back to VS Code', (_name, vscode, lsp) => {
    expect(vsCodeKindFromLsp(lsp)).toBe(vscode);
  });

  it.each(TABLE)('%s round-trips', (_name, vscode) => {
    expect(vsCodeKindFromLsp(lspKindFromVsCode(vscode))).toBe(vscode);
  });

  it('names every LSP kind, so a wrong number is readable in a log', () => {
    for (const [name, , lsp] of TABLE) {
      expect(LSP_SYMBOL_KIND_NAMES[lsp as LspSymbolKind]).toBe(name);
    }
  });

  /*
  | صفر یک مقدار معتبر LSP نیست. اگر جایی یک مقدار VS Code به تابع LSP
  | برسد، باید سروصدا کند نه اینکه بی‌صدا یک رده جابه‌جا شود.
  */
  it('rejects a kind outside the LSP range', () => {
    expect(() => vsCodeKindFromLsp(0)).toThrow(/0/);
    expect(() => vsCodeKindFromLsp(27)).toThrow(/27/);
  });

  it('rejects a kind outside the VS Code range', () => {
    expect(() => lspKindFromVsCode(-1)).toThrow();
    expect(() => lspKindFromVsCode(26)).toThrow();
  });

  /*
  | این تست تنها چیزی است که مانع بازگشت باگ می‌شود: اختلاف دو جدول
  | دقیقاً یک است، نه صفر.
  */
  it('keeps the two numbering schemes exactly one apart', () => {
    for (const [, vscode, lsp] of TABLE) {
      expect(lsp - vscode).toBe(1);
    }
  });
});
