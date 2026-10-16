import { tokenize } from './tokens';
export function pairs(text: string): number {
  return tokenize(text).length;
}
export function triple(text: string): number {
  return tokenize(text).length + 1;
}
