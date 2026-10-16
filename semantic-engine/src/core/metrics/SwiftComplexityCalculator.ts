/**
 * محاسبه تقریبی Cyclomatic Complexity برای Swift.
 */

import { PatternComplexityCalculator, ComplexityPattern } from './PatternComplexityCalculator';

const SWIFT_PATTERNS: ComplexityPattern[] = [
  { name: 'if', regex: /\bif\b/g },
  { name: 'else', regex: /\belse\b/g },
  { name: 'guard', regex: /\bguard\b/g },
  { name: 'for', regex: /\bfor\b/g },
  { name: 'while', regex: /\bwhile\b/g },
  { name: 'repeat', regex: /\brepeat\b/g },
  { name: 'switch', regex: /\bswitch\b/g },
  { name: 'case', regex: /\bcase\b/g },
  { name: 'catch', regex: /\bcatch\b/g },
  { name: 'and', regex: /&&/g },
  { name: 'or', regex: /\|\|/g },
  { name: 'nil-coalesce', regex: /\?\?/g, weight: 1 },
];

export function createSwiftComplexityCalculator(): PatternComplexityCalculator {
  return new PatternComplexityCalculator({
    patterns: SWIFT_PATTERNS,
    languageId: 'swift',
    ignoreComments: true,
  });
}
