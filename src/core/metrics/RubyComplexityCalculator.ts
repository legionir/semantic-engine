/**
 * محاسبه تقریبی Cyclomatic Complexity برای Ruby.
 */

import { PatternComplexityCalculator, ComplexityPattern } from './PatternComplexityCalculator';

const RUBY_PATTERNS: ComplexityPattern[] = [
  { name: 'if', regex: /\bif\b/g },
  { name: 'unless', regex: /\bunless\b/g },
  { name: 'elsif', regex: /\belsif\b/g },
  { name: 'else', regex: /\belse\b/g },
  { name: 'for', regex: /\bfor\b/g },
  { name: 'while', regex: /\bwhile\b/g },
  { name: 'until', regex: /\buntil\b/g },
  { name: 'case', regex: /\bcase\b/g },
  { name: 'when', regex: /\bwhen\b/g },
  { name: 'and', regex: /\band\b/g },
  { name: 'or', regex: /\bor\b/g },
  { name: 'rescue', regex: /\brescue\b/g },
];

export function createRubyComplexityCalculator(): PatternComplexityCalculator {
  return new PatternComplexityCalculator({
    patterns: RUBY_PATTERNS,
    languageId: 'ruby',
    ignoreComments: true,
  });
}
