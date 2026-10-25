/**
 * Scan flags shared by `index`, `watch`, `start` and `worker`.
 *
 *   --max-depth <n>            0 = unlimited
 *   --max-file-size-mb <n>     files above this are indexed partially
 *   --ignore <a,b,c>           extra ignore patterns (comma separated)
 *   --no-gitignore             do not honour .gitignore
 *   --no-skip-hidden           descend into dot-directories
 *
 * They override the values in the data directory's `config.json` (`scan.*`), which stay the
 * default; a flag that is absent changes nothing.
 */

import { ParsedArgs, boolOption, stringOption } from './args';

export interface ScanFlagOverrides {
  useGitignore?: boolean;
  skipHiddenDirectories?: boolean;
  maxDepth?: number;
  maxFileSizeBytes?: number;
  additionalIgnorePatterns?: readonly string[];
}

export type ScanFlagsResult =
  | { readonly ok: true; readonly overrides: ScanFlagOverrides }
  | { readonly ok: false; readonly error: string };

function nonNegative(raw: string, flag: string): number | string {
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(value) || value < 0) {
    return `${flag} must be a non-negative number: ${raw}`;
  }
  return value;
}

export function parseScanFlags(args: ParsedArgs): ScanFlagsResult {
  const overrides: ScanFlagOverrides = {};
  const { options } = args;

  /* `--max-depth -1` parses as a bare flag followed by another flag; ignoring it would hide the mistake. */
  for (const [name, flag] of [['maxDepth', '--max-depth'], ['maxFileSizeMb', '--max-file-size-mb'], ['ignore', '--ignore']] as const) {
    if (name in options && typeof options[name] !== 'string') {
      return { ok: false, error: `${flag} needs a value` };
    }
  }

  const depth = stringOption(options, 'maxDepth');
  if (depth !== undefined) {
    const value = nonNegative(depth, '--max-depth');
    if (typeof value === 'string') return { ok: false, error: value };
    if (!Number.isInteger(value)) return { ok: false, error: `--max-depth must be an integer: ${depth}` };
    overrides.maxDepth = value;
  }

  const size = stringOption(options, 'maxFileSizeMb');
  if (size !== undefined) {
    const value = nonNegative(size, '--max-file-size-mb');
    if (typeof value === 'string') return { ok: false, error: value };
    if (value === 0) return { ok: false, error: '--max-file-size-mb must be greater than 0' };
    overrides.maxFileSizeBytes = Math.round(value * 1024 * 1024);
  }

  const ignore = stringOption(options, 'ignore');
  if (ignore !== undefined) {
    const patterns = ignore.split(',').map(part => part.trim()).filter(part => part !== '');
    if (patterns.length > 0) overrides.additionalIgnorePatterns = patterns;
  }

  if ('gitignore' in options) overrides.useGitignore = boolOption(options, 'gitignore', true);
  if ('skipHidden' in options) overrides.skipHiddenDirectories = boolOption(options, 'skipHidden', true);

  return { ok: true, overrides };
}

/** Flags win over the config file; patterns are merged, not replaced. */
export function mergeScanOverrides(
  fromConfig: ScanFlagOverrides,
  fromFlags: ScanFlagOverrides
): ScanFlagOverrides {
  const patterns = [
    ...(fromConfig.additionalIgnorePatterns ?? []),
    ...(fromFlags.additionalIgnorePatterns ?? []),
  ];
  return {
    ...fromConfig,
    ...fromFlags,
    ...(patterns.length > 0 ? { additionalIgnorePatterns: patterns } : {}),
  };
}
