import { pairs } from './ngrams';
export function census(text: string): number {
  return pairs(text) * 2;
}
