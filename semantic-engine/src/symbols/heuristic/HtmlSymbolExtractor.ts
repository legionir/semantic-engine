/**
 * HtmlSymbolExtractor — استخراج symbol از فایل‌های HTML.
 *
 * - تگ‌های `<script>`, `<template>`, `<style>` به‌عنوان module boundary.
 * - attribute های `id` به‌عنوان class symbol.
 * - attribute های `class` به‌عنوان property symbol (اولین class name).
 *
 * ── SE-SYM-30 ─────────────────────────────────────────────────────
 *
 * همان دو نقص CSS، این‌جا هم بود: dedupe بر پایهٔ `نام + نوع`، و
 * «فقط اولین class». یک `class="card wide"` فقط `card` می‌داد، و یک
 * class که در دو جای فایل بیاید فقط یک بار — با مکان *اولین* ظهور.
 */

import { ISymbolExtractor, SymbolExtractionResult } from '../ISymbolExtractor';
import { SymbolEntry, SymbolKind } from '../../core/types/project-index.types';
import { ExtractionSource, Result, ok, makeConfidence } from '../../core/types/common.types';
import { getLineNumber } from '../../core/utils/lineNumber';
import { findMatchingTagEnd } from './BlockRange';
import { SymbolIdAllocator } from '../../core/id/SymbolIdentity';

export class HtmlSymbolExtractor implements ISymbolExtractor {
  readonly name: ExtractionSource = 'heuristic';
  readonly priority = 10;

  /*
  | SE-SCAN-13: این‌جا `'htm'` و `'xhtml'` هم پذیرفته می‌شدند، ولی
  | آن‌ها *پسوند* اند نه languageId؛ رجیستری برای `a.htm` همیشه
  | `'html'` برمی‌گرداند. دو شاخهٔ مرده که این توهم را می‌ساختند که
  | استخراج‌گر پوشش بیشتری دارد.
  */
  async isAvailable(languageId: string): Promise<boolean> {
    return languageId === 'html';
  }

  async extract(
    fileId: string,
    filePath: string,
    content: string,
    _languageId: string
  ): Promise<Result<SymbolExtractionResult>> {
    const symbols: SymbolEntry[] = [];
    const allocator = new SymbolIdAllocator();

    const addSymbol = (name: string, kind: SymbolKind, line: number, endLine = line) => {
      const allocated = allocator.allocate({ filePath, parentFqName: null, name, kind });

      symbols.push({
        id: allocated.id,
        fileId,
        parentId: null,
        kind,
        name,
        fullyQualifiedName: allocated.fullyQualifiedName,
        line,
        endLine,
        source: 'heuristic',
        confidence: makeConfidence(65),
      });
    };

    // Module boundaries: <script>, <template>, <style>
    const moduleTagRegex = /<(script|template|style)(\s|>)/gi;
    let match: RegExpExecArray | null;
    while ((match = moduleTagRegex.exec(content)) !== null) {
      const tagName = match[1]!;
      const line = getLineNumber(content, match.index);

      /*
      | `<script>` و `<template>` و `<style>` بلوک‌های واقعی‌اند و
      | بازه‌شان تا تگ بستهٔ متناظر ادامه دارد. همین بازه است که
      | chunkساز و `findSymbolAtLine` به آن نیاز دارند.
      */
      const close = findMatchingTagEnd(content, tagName, match.index);
      addSymbol(tagName, 'module', line, close === -1 ? line : getLineNumber(content, close));
    }

    /*
    | SE-SYM-24 — یک `id` در HTML یک *شناسه* روی یک عنصر است، نه یک
    | کلاس. ثبتش با `kind: 'class'` نگاشت معنایی غلطی بود که هر
    | مصرف‌کننده‌ای را که روی kind فیلتر می‌کند گمراه می‌کرد.
    */
    const idRegex = /\sid=["']([^"']+)["']/gi;
    while ((match = idRegex.exec(content)) !== null) {
      const idValue = match[1]!;
      const line = getLineNumber(content, match.index);
      addSymbol(idValue, 'property', line);
    }

    /*
    | همهٔ classها، نه فقط اولی. `class="card wide"` دو نام است و
    | برداشتن یکی، نیمی از اطلاعات را دور می‌ریزد.
    */
    const classRegex = /\sclass=["']([^"']+)["']/gi;
    while ((match = classRegex.exec(content)) !== null) {
      const line = getLineNumber(content, match.index);
      for (const className of match[1]!.trim().split(/\s+/)) {
        if (className) addSymbol(className, 'property', line);
      }
    }

    return ok({
      symbols,
      source: 'heuristic',
      partial: false,
      warnings: [],
    });
  }

  async dispose(): Promise<void> {}
}
