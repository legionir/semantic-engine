/**
 * محاسبه تقریبی Cyclomatic Complexity برای Kotlin.
 */

import { PatternComplexityCalculator, ComplexityPattern } from './PatternComplexityCalculator';

const KOTLIN_PATTERNS: ComplexityPattern[] = [
  { name: 'if', regex: /\bif\b/g },
  { name: 'else', regex: /\belse\b/g },
  { name: 'for', regex: /\bfor\b/g },
  { name: 'while', regex: /\bwhile\b/g },
  { name: 'do', regex: /\bdo\b/g },
  { name: 'when', regex: /\bwhen\b/g },
  { name: 'catch', regex: /\bcatch\b/g },
  { name: 'and', regex: /&&/g },
  { name: 'or', regex: /\|\|/g },
  { name: 'ternary', regex: /\?[^:]+:/g, weight: 1 },
];

export function createKotlinComplexityCalculator(): PatternComplexityCalculator {
  return new PatternComplexityCalculator({
    patterns: KOTLIN_PATTERNS,
    languageId: 'kotlin',
    ignoreComments: true,
  });
}
