import * as fs from 'fs';

/**
 * .gitignore file parser.
 *
 * Converts .gitignore patterns to two lists:
 * - directory patterns (for skipping entire directories)
 * - file glob patterns (for skipping specific files)
 *
 * Supports:
 * - Comment lines (#)
 * - Blank lines
 * - Negation (!pattern)
 * - Directory-only patterns (pattern/)
 * - Wildcard patterns (*, **)
 * - Leading slash (absolute patterns relative to root)
 */

export interface GitignorePatterns {
  /** Directory names to ignore (e.g., 'node_modules', 'dist') */
  readonly ignoreDirectories: string[];
  /** Glob patterns to ignore files (e.g., '*.log', '*.min.js') */
  readonly ignoreFilePatterns: string[];
  /** Negation patterns (files that should NOT be ignored even if they match) */
  readonly negationPatterns: string[];
}

/**
 * Parse a .gitignore file and return structured patterns.
 * Returns null if the file doesn't exist or can't be read.
 */
export function parseGitignore(gitignorePath: string): GitignorePatterns | null {
  try {
    const content = fs.readFileSync(gitignorePath, 'utf8');
    return parseGitignoreContent(content);
  } catch {
    return null;
  }
}

/**
 * Parse .gitignore content string into structured patterns.
 */
export function parseGitignoreContent(content: string): GitignorePatterns {
  const ignoreDirectories: string[] = [];
  const ignoreFilePatterns: string[] = [];
  const negationPatterns: string[] = [];

  const lines = content.split('\n');

  for (let line of lines) {
    line = line.trim();

    // Skip empty lines and comments
    if (!line || line.startsWith('#')) {
      continue;
    }

    // Handle negation
    if (line.startsWith('!')) {
      const pattern = line.slice(1).trim();
      if (pattern) {
        negationPatterns.push(pattern);
      }
      continue;
    }

    // Remove leading slash (absolute patterns relative to root)
    /*
    | SE-SCAN-02 — پیشوند `/` **حذف نمی‌شود**.
    |
    | در gitignore، `/dist/` یعنی فقط `dist` ریشه و `dist/` یعنی هر
    | `dist` در هر عمقی. برداشتن اسلش، این تمایز را از بین می‌برد
    | پیش از آنکه اسکنر اصلاً ببیندش — و آن‌وقت یک قاعدهٔ ریشه‌ای،
    | هر پوشهٔ هم‌نام را در کل درخت حذف می‌کند.
    */
    const anchored = line.startsWith('/');

    // Check if it's a directory-only pattern (ends with /)
    if (line.endsWith('/')) {
      const dirName = line.slice(0, -1);
      if (dirName) {
        if (anchored) {
          // لنگرخورده: فقط همین مسیر، نه هر پوشهٔ هم‌نام
          ignoreFilePatterns.push(line);
        } else {
          ignoreDirectories.push(dirName);
        }
      }
      continue;
    }

    // Check if the pattern contains wildcards or path separators
    // If it contains * or /, it's a glob pattern for files
    if (anchored || line.includes('*') || line.includes('/')) {
      // Convert gitignore pattern to minimatch-compatible pattern
      // Remove leading ./ if present
      const pattern = line.startsWith('./') ? line.slice(2) : line;
      ignoreFilePatterns.push(pattern);
    } else {
      // Simple name — could be a directory or file
      // Treat as a directory name (most common case in .gitignore)
      ignoreDirectories.push(line);
    }
  }

  return { ignoreDirectories, ignoreFilePatterns, negationPatterns };
}

/**
 * Merge gitignore patterns with existing scanner config patterns.
 * Gitignore patterns are added to the existing ones (not replacing them).
 */
export function mergeGitignorePatterns(
  existing: {
    ignoreDirectories: string[];
    ignoreFilePatterns: string[];
  },
  gitignore: GitignorePatterns
): {
  ignoreDirectories: string[];
  ignoreFilePatterns: string[];
} {
  // Add directory patterns from .gitignore (avoid duplicates)
  const dirSet = new Set(existing.ignoreDirectories);
  for (const dir of gitignore.ignoreDirectories) {
    dirSet.add(dir);
  }

  // Add file patterns from .gitignore (avoid duplicates)
  const fileSet = new Set(existing.ignoreFilePatterns);
  for (const pattern of gitignore.ignoreFilePatterns) {
    fileSet.add(pattern);
  }

  return {
    ignoreDirectories: Array.from(dirSet),
    ignoreFilePatterns: Array.from(fileSet),
  };
}
