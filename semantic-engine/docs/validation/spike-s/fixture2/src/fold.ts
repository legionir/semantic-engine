import { tokenize } from './tokens';
export function fold(text: string): string {
  function inner(tokenize: number) {
    return tokenize + 1;
  }
  const mapper = (tokenize: string) => tokenize.slice(1);
  return text + inner(2) + mapper('ab');
}
