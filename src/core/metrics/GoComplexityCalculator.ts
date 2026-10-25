/**
 * محاسبه تقریبی Cyclomatic Complexity برای Go.
 */

import { PatternComplexityCalculator, ComplexityPattern } from './PatternComplexityCalculator';

const GO_PATTERNS: ComplexityPattern[] = [
  { name: 'if', regex: /\bif\b/g },
  { name: 'for', regex: /\bfor\b/g },
  { name: 'range', regex: /\brange\b/g },
  { name: 'switch', regex: /\bswitch\b/g },
  { name: 'case', regex: /\bcase\b/g },
  { name: 'select', regex: /\bselect\b/g },
  { name: 'and', regex: /&&/g },
  { name: 'or', regex: /\|\|/g },
];

export function createGoComplexityCalculator(): PatternComplexityCalculator {
  return new PatternComplexityCalculator({
    patterns: GO_PATTERNS,
    languageId: 'go',
    ignoreComments: true,
  });
}
