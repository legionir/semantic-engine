/**
 * محاسبه تقریبی Cyclomatic Complexity برای Bash/Shell.
 */

import { PatternComplexityCalculator, ComplexityPattern } from './PatternComplexityCalculator';

const BASH_PATTERNS: ComplexityPattern[] = [
  { name: 'if', regex: /\bif\b/g },
  { name: 'elif', regex: /\belif\b/g },
  { name: 'for', regex: /\bfor\b/g },
  { name: 'while', regex: /\bwhile\b/g },
  { name: 'case', regex: /\bcase\b/g },
  { name: 'and', regex: /&&/g },
  { name: 'or', regex: /\|\|/g },
];

export function createBashComplexityCalculator(): PatternComplexityCalculator {
  return new PatternComplexityCalculator({
    patterns: BASH_PATTERNS,
    languageId: 'shellscript',
    ignoreComments: true,
  });
}
