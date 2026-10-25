/**
 * تایپ‌های مشترک برای AI tools.
 *
 * هر tool باید input schema مشخص، output structured، و source attribution داشته باشد.
 */

import { FileEntry, SymbolEntry } from '../../core/types/project-index.types';

export interface AiToolInput {
  readonly [key: string]: unknown;
}

export interface AiToolResultItem {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly path?: string;
  readonly line?: number;
  readonly relevanceScore?: number;
  readonly source: string;
  readonly excerpt?: string;
  /**
   * هرچه دربارهٔ *چگونگی* رسیدن به این نتیجه گفتنی است — فاز ۳۹.
   *
   * `impact_analysis` اینجا عمق، اعتماد مسیر و مبنای یال را
   * می‌گذارد. بدون آن، دو نتیجه با امتیاز نزدیک از هم قابل تشخیص
   * نیستند: یکی از یک import قطعی آمده و دیگری از حدسِ نام.
   */
  readonly metadata?: Record<string, unknown>;
}

export interface AiToolOutput {
  readonly success: boolean;
  readonly error?: string;
  readonly items: readonly AiToolResultItem[];
  readonly context?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface AiTool<I extends AiToolInput = AiToolInput> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  execute(input: I): Promise<AiToolOutput>;
}

export interface RankedSymbol extends SymbolEntry {
  readonly relevanceScore: number;
}

export interface RankedFile extends FileEntry {
  readonly relevanceScore: number;
}
