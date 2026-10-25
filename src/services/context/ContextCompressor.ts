/**
 * ContextCompressor — Compresses code context for Agent token budget optimization.
 * Strips verbose internal function bodies of non-target symbols while keeping interfaces and signatures.
 */

export interface CompressOptions {
  readonly maxTokens?: number;
  readonly preserveSymbols?: readonly string[];
  readonly keepSignaturesOnly?: boolean;
}

export class ContextCompressor {
  /**
   * Compresses source code snippet by compacting non-essential function bodies.
   */
  compressSnippet(source: string, options?: CompressOptions): { compressed: string; savedRatio: number } {
    if (!source || source.trim() === '') {
      return { compressed: '', savedRatio: 0 };
    }

    const lines = source.split('\n');
    const outputLines: string[] = [];
    let skippingBodyUntilDepth = -1;
    let currentBraceDepth = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const trimmed = line.trim();

      const openCount = (line.match(/{/g) || []).length;
      const closeCount = (line.match(/}/g) || []).length;

      if (skippingBodyUntilDepth >= 0) {
        currentBraceDepth += openCount - closeCount;
        if (currentBraceDepth <= skippingBodyUntilDepth) {
          skippingBodyUntilDepth = -1;
        }
        continue;
      }

      // Check if this line starts a method/function that should be compacted
      const isFunctionDecl = /(?:function|async\s+function|async\s+[a-zA-Z0-9_$]+\s*\(|[a-zA-Z0-9_$]+\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{)/.test(trimmed);

      if (options?.keepSignaturesOnly && isFunctionDecl && line.includes('{')) {
        const signaturePart = line.slice(0, line.indexOf('{')).trimEnd();
        outputLines.push(`${signaturePart} { /* ... implementation compressed ... */ }`);
        currentBraceDepth += openCount - closeCount;
        if (openCount > closeCount) {
          skippingBodyUntilDepth = currentBraceDepth - (openCount - closeCount);
        }
        continue;
      }

      currentBraceDepth += openCount - closeCount;

      // Filter out duplicate blank lines
      if (trimmed === '' && outputLines[outputLines.length - 1]?.trim() === '') {
        continue;
      }

      outputLines.push(line);
    }

    const compressed = outputLines.join('\n');
    const originalLen = source.length;
    const compressedLen = compressed.length;
    const savedRatio = originalLen > compressedLen ? (originalLen - compressedLen) / originalLen : 0;

    return {
      compressed,
      savedRatio: Math.round(savedRatio * 100) / 100,
    };
  }
}
