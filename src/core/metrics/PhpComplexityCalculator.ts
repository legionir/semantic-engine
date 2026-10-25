/**
 * محاسبه تقریبی Cyclomatic Complexity برای PHP.
 */

import { PatternComplexityCalculator, ComplexityPattern } from './PatternComplexityCalculator';

const PHP_PATTERNS: ComplexityPattern[] = [
  { name: 'if', regex: /\bif\b/g },
  { name: 'elseif', regex: /\belseif\b/g },
  { name: 'else', regex: /\belse\b/g },
  { name: 'for', regex: /\bfor\b/g },
  { name: 'foreach', regex: /\bforeach\b/g },
  { name: 'while', regex: /\bwhile\b/g },
  { name: 'switch', regex: /\bswitch\b/g },
  { name: 'case', regex: /\bcase\b/g },
  { name: 'catch', regex: /\bcatch\b/g },
  { name: 'and', regex: /&&/g },
  { name: 'or', regex: /\|\|/g },
  { name: 'ternary', regex: /\?.*?:/g, weight: 1 },
];

export function createPhpComplexityCalculator(): PatternComplexityCalculator {
  return new PatternComplexityCalculator({
    patterns: PHP_PATTERNS,
    languageId: 'php',
    ignoreComments: true,
  });
}
