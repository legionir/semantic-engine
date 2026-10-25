import { parseGitignoreContent, mergeGitignorePatterns } from './gitignoreParser';

describe('parseGitignoreContent', () => {
  it('should parse simple directory names', () => {
    const content = `node_modules
dist
build`;
    const result = parseGitignoreContent(content);
    expect(result.ignoreDirectories).toEqual(['node_modules', 'dist', 'build']);
    expect(result.ignoreFilePatterns).toEqual([]);
  });

  it('should skip comments and blank lines', () => {
    const content = `# Dependencies
node_modules

# Build output
dist`;
    const result = parseGitignoreContent(content);
    expect(result.ignoreDirectories).toEqual(['node_modules', 'dist']);
  });

  it('should parse glob patterns for files', () => {
    const content = `*.log
*.min.js
*.map`;
    const result = parseGitignoreContent(content);
    expect(result.ignoreFilePatterns).toEqual(['*.log', '*.min.js', '*.map']);
  });

  it('should parse directory-only patterns (ending with /)', () => {
    const content = `build/
dist/
temp/`;
    const result = parseGitignoreContent(content);
    expect(result.ignoreDirectories).toEqual(['build', 'dist', 'temp']);
  });

  it('should handle negation patterns', () => {
    const content = `*.log
!important.log`;
    const result = parseGitignoreContent(content);
    expect(result.ignoreFilePatterns).toEqual(['*.log']);
    // Parser strips the leading '!' — consumers match negations via minimatch.
    expect(result.negationPatterns).toEqual(['important.log']);
  });

  /*
  | SE-SCAN-02 — این تست تا فاز ۲۱ انتظار داشت که `/` ابتدایی *حذف*
  | شود و الگو به فهرست پوشه‌های ساده برود. همان کار بود که تمایز
  | «فقط ریشه» از «هر عمقی» را از بین می‌برد: `/dist` باعث حذف هر
  | پوشهٔ `dist` در کل درخت می‌شد.
  |
  | الگوی لنگرخورده حالا در `ignoreFilePatterns` می‌ماند — با اسلش
  | دست‌نخورده — تا مصرف‌کننده بتواند آن را با *مسیر نسبی* تطبیق دهد.
  */
  it('keeps a leading slash so the pattern stays anchored to the root', () => {
    const content = `/build
/dist`;
    const result = parseGitignoreContent(content);

    expect(result.ignoreDirectories).toEqual([]);
    expect(result.ignoreFilePatterns).toEqual(['/build', '/dist']);
  });

  it('still treats an unanchored name as a directory at any depth', () => {
    const result = parseGitignoreContent('build\ndist');

    expect(result.ignoreDirectories).toEqual(['build', 'dist']);
  });

  it('should handle mixed patterns', () => {
    const content = `node_modules
*.log
build/
.env`;
    const result = parseGitignoreContent(content);
    expect(result.ignoreDirectories).toContain('node_modules');
    expect(result.ignoreFilePatterns).toContain('*.log');
    expect(result.ignoreDirectories).toContain('build');
    expect(result.ignoreDirectories).toContain('.env');
  });
});

describe('mergeGitignorePatterns', () => {
  it('should merge without duplicates', () => {
    const existing = {
      ignoreDirectories: ['node_modules', 'dist'],
      ignoreFilePatterns: ['*.log'],
    };
    const gitignore = {
      ignoreDirectories: ['dist', 'build'],
      ignoreFilePatterns: ['*.log', '*.min.js'],
      negationPatterns: [],
    };
    const result = mergeGitignorePatterns(existing, gitignore);
    expect(result.ignoreDirectories).toEqual(['node_modules', 'dist', 'build']);
    expect(result.ignoreFilePatterns).toEqual(['*.log', '*.min.js']);
  });
});
