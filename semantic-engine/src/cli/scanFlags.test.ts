import { parseArgs } from './args';
import { mergeScanOverrides, parseScanFlags } from './scanFlags';

const flags = (...argv: string[]) => parseScanFlags(parseArgs(['index', ...argv]));

describe('scan flags', () => {
  it('no flag changes nothing', () => {
    expect(flags()).toEqual({ ok: true, overrides: {} });
  });

  it('maps every flag to a scanner override', () => {
    expect(flags('--max-depth', '4', '--max-file-size-mb', '2.5', '--ignore', '**/*.snap, vendor/**', '--no-gitignore', '--no-skip-hidden')).toEqual({
      ok: true,
      overrides: {
        maxDepth: 4,
        maxFileSizeBytes: Math.round(2.5 * 1024 * 1024),
        additionalIgnorePatterns: ['**/*.snap', 'vendor/**'],
        useGitignore: false,
        skipHiddenDirectories: false,
      },
    });
  });

  it.each([
    [['--max-depth', '-1'], '--max-depth'],
    [['--max-depth', '1.5'], '--max-depth'],
    [['--max-depth', 'many'], '--max-depth'],
    [['--max-file-size-mb', '0'], '--max-file-size-mb'],
    [['--max-file-size-mb', 'x'], '--max-file-size-mb'],
  ])('rejects %j', (argv, flag) => {
    const result = flags(...argv);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(flag);
  });

  it('flags win over the config file and ignore patterns are merged', () => {
    expect(
      mergeScanOverrides(
        { maxDepth: 9, useGitignore: false, additionalIgnorePatterns: ['a'] },
        { maxDepth: 2, additionalIgnorePatterns: ['b'] }
      )
    ).toEqual({ maxDepth: 2, useGitignore: false, additionalIgnorePatterns: ['a', 'b'] });
  });
});
