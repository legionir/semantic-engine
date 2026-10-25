/**
 * TreeSitterParserManager — مدیریت بارگذاری و cache پparser های tree-sitter.
 *
 * - web-tree-sitter را init می‌کند.
 - زبان‌های TS/JS/TSX/JSX را از فایل‌های WASM بارگذاری می‌کند.
 * - parser ها را cache می‌کند تا بارگذاری تکراری نباشد.
 */

import * as path from 'path';
import { grammarFor } from './languageGrammars';
import * as fs from 'fs';
import { Parser, Language } from 'web-tree-sitter';
import { ILogger, defaultLogger } from '../../host/Logger';

export interface TreeSitterParserManagerOptions {
  /** مسیر دایرکتوری حاوی فایل‌های WASM grammar */
  readonly grammarDir: string;
  readonly logger?: ILogger;
}

export class TreeSitterParserManager {
  private initialized = false;
  /** وعدهٔ init در حال اجرا — تا فراخوان‌های هم‌زمان روی همان یکی صبر کنند. */
  private initializing: Promise<void> | null = null;
  private readonly parsers = new Map<string, Parser>();
  private readonly languages = new Map<string, Language>();

  constructor(private readonly options: TreeSitterParserManagerOptions) {}

  /**
   * بررسی اینکه آیا tree-sitter برای یک زبان در دسترس است.
   */
  async isAvailable(languageId: string): Promise<boolean> {
    await this.ensureInitialized();
    return this.getGrammarName(languageId) !== null;
  }

  /**
   * دریافت parser برای یک زبان.
   */
  async getParser(languageId: string): Promise<Parser | null> {
    await this.ensureInitialized();

    const grammarName = this.getGrammarName(languageId);
    if (!grammarName) return null;

    const cached = this.parsers.get(languageId);
    if (cached) return cached;

    const language = await this.loadLanguage(grammarName);
    if (!language) return null;

    const parser = new Parser();
    parser.setLanguage(language);
    this.parsers.set(languageId, parser);
    return parser;
  }

  /**
   * بارگذاری language grammar از فایل WASM.
   */
  private async loadLanguage(grammarName: string): Promise<Language | null> {
    const cached = this.languages.get(grammarName);
    if (cached) return cached;

    const wasmPath = path.join(this.options.grammarDir, `tree-sitter-${grammarName}.wasm`);
    try {
      /*
      | خواندن WASM به‌صورت Uint8Array تا از dynamic import در Node/Jest
      | اجتناب شود.
      |
      | SE-PERF-01 — خواندن ناهمگام است: `Language.load` خودش کامپایل
      | WASM را همگام انجام می‌دهد و نمی‌شود کاری‌اش کرد، ولی دست‌کم
      | خواندنِ چند مگابایت از دیسک نباید event loop را هم نگه دارد.
      | این هزینه یک‌بار به ازای هر گرامر است و بعد کش می‌شود.
      */
      const wasmBytes = await fs.promises.readFile(wasmPath);
      const language = await Language.load(wasmBytes);
      this.languages.set(grammarName, language);
      return language;
    } catch (error) {
      (this.options.logger ?? defaultLogger).warn('failed to load grammar', { grammar: grammarName, cause: error });
      return null;
    }
  }

  /**
   * تبدیل languageId ما به نام grammar tree-sitter.
   */
  private getGrammarName(languageId: string): string | null {
    /*
    | GAP-11 — این `switch` قبلاً فقط چهار زبان را می‌شناخت، پس هر
    | زبان دیگری به مسیر heuristic می‌افتاد. حالا از یک جدولِ
    | مشترک می‌آید که `TreeSitterSymbolMapper` هم همان را می‌خواند؛
    | دو فهرستِ جدا از «زبان‌های پشتیبانی‌شده» دیر یا زود از هم
    | واگرا می‌شوند.
    */
    return grammarFor(languageId)?.grammar ?? null;
  }

  /**
   * اطمینان از init شدن web-tree-sitter.
   *
   * SE-SYM-15 — نسخهٔ قبلی فقط یک پرچم بولی داشت. چون بین بررسی پرچم
   * و ست شدنش یک `await` بود، ده فایل که هم‌زمان شروع می‌شوند ده بار
   * `Parser.init()` را صدا می‌زدند. نگه داشتن *وعده* به‌جای پرچم،
   * بقیه را روی همان یک init منتظر می‌گذارد.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (this.initializing) return this.initializing;

    this.initializing = this.runInit();
    try {
      await this.initializing;
      this.initialized = true;
    } finally {
      this.initializing = null;
    }
  }

  /** جدا نگه داشته شده تا در تست بشود شمردش. */
  private async runInit(): Promise<void> {
    await Parser.init();
  }

  /**
   * آزادسازی parser ها.
   */
  async dispose(): Promise<void> {
    for (const parser of this.parsers.values()) {
      parser.delete();
    }
    this.parsers.clear();
    this.languages.clear();

    /*
    | SE-SYM-15 — پرچم هم باید ریست شود. بدون این، مدیرِ dispose‌شده
    | «مقداردهی‌شده» می‌ماند ولی هیچ parserی ندارد، و استفادهٔ دوباره
    | از آن بی‌صدا شکست می‌خورد.
    */
    this.initialized = false;
    this.initializing = null;
  }
}
