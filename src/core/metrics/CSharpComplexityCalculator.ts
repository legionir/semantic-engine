/**
 * محاسبه تقریبی Cyclomatic Complexity برای C#.
 */

import { PatternComplexityCalculator, ComplexityPattern } from './PatternComplexityCalculator';

const CSHARP_PATTERNS: ComplexityPattern[] = [
  { name: 'if', regex: /\bif\b/g },
  { name: 'else', regex: /\belse\b/g },
  { name: 'for', regex: /\bfor\b/g },
  { name: 'foreach', regex: /\bforeach\b/g },
  { name: 'while', regex: /\bwhile\b/g },
  { name: 'do', regex: /\bdo\b/g },
  { name: 'switch', regex: /\bswitch\b/g },
  { name: 'case', regex: /\bcase\b/g },
  { name: 'catch', regex: /\bcatch\b/g },
  { name: 'and', regex: /&&/g },
  { name: 'or', regex: /\|\|/g },
  { name: 'ternary', regex: /\?[^:]+:/g, weight: 1 },
  { name: 'null-coalesce', regex: /\?\?/g, weight: 1 },
];

export function createCSharpComplexityCalculator(): PatternComplexityCalculator {
  return new PatternComplexityCalculator({
    patterns: CSHARP_PATTERNS,
    languageId: 'csharp',
    ignoreComments: true,
  });
}
