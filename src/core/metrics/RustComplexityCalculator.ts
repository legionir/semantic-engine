/**
 * محاسبه تقریبی Cyclomatic Complexity برای Rust.
 */

import { PatternComplexityCalculator, ComplexityPattern } from './PatternComplexityCalculator';

const RUST_PATTERNS: ComplexityPattern[] = [
  { name: 'if', regex: /\bif\b/g },
  { name: 'else', regex: /\belse\b/g },
  { name: 'for', regex: /\bfor\b/g },
  { name: 'while', regex: /\bwhile\b/g },
  { name: 'loop', regex: /\bloop\b/g },
  { name: 'match', regex: /\bmatch\b/g },
  { name: 'match-arm', regex: /\s*=>\s*/g, weight: 1 },
  { name: 'and', regex: /&&/g },
  { name: 'or', regex: /\|\|/g },
];

export function createRustComplexityCalculator(): PatternComplexityCalculator {
  return new PatternComplexityCalculator({
    patterns: RUST_PATTERNS,
    languageId: 'rust',
    ignoreComments: true,
  });
}
