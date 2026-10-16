/**
 * محاسبه تقریبی Cyclomatic Complexity برای C / C++.
 */

import { PatternComplexityCalculator, ComplexityPattern } from './PatternComplexityCalculator';

const CPP_PATTERNS: ComplexityPattern[] = [
  { name: 'if', regex: /\bif\b/g },
  { name: 'else', regex: /\belse\b/g },
  { name: 'for', regex: /\bfor\b/g },
  { name: 'while', regex: /\bwhile\b/g },
  { name: 'do', regex: /\bdo\b/g },
  { name: 'switch', regex: /\bswitch\b/g },
  { name: 'case', regex: /\bcase\b/g },
  { name: 'catch', regex: /\bcatch\b/g },
  { name: 'and', regex: /&&/g },
  { name: 'or', regex: /\|\|/g },
  { name: 'ternary', regex: /\?[^:]+:/g, weight: 1 },
];

export function createCppComplexityCalculator(): PatternComplexityCalculator {
  return new PatternComplexityCalculator({
    patterns: CPP_PATTERNS,
    languageId: 'cpp',
    ignoreComments: true,
  });
}
