import { census } from './count';
export function summary(text: string): number {
  return census(text);
}
