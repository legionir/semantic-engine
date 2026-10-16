import { tokenize } from './barrel';
import * as tk from './tokens';
import * as nodefs from 'fs';
export function stage(raw: string): string {
  const clean = nodefs.existsSync('x') ? raw : raw;
  return tk.tokenize(clean) + tokenize(clean);
}
