/**
 * Documentation/comment extraction for heuristic symbol extractors
 * (split from SymbolExtractionHelpers.ts, behavior unchanged).
 */

/**
 * استخراج documentation از خطوط قبل یا بعد از تعریف symbol.
 *
 * - Python: docstring (triple-quote) در خطوط بلافاصله بعد یا hash comments قبل
 * - Java/PHP/C#/C++/Kotlin/Swift: Javadoc-style block comment یا line comment قبل
 * - Go: line comment قبل
 * - Rust: doc comment (///) یا line comment قبل
 * - Ruby: hash comment قبل
 */
export function extractDocumentation(
  lines: string[],
  symbolLine: number,
  languageId: string
): string | null {
  const before = extractLeadingComments(lines, symbolLine, languageId);
  if (before) return before;

  if (languageId === 'python') {
    return extractPythonDocstring(lines, symbolLine);
  }

  return null;
}

export function extractLeadingComments(
  lines: string[],
  symbolLine: number,
  languageId: string
): string | null {
  const comments: string[] = [];
  let insideBlockComment = false;

  for (let i = symbolLine - 2; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.trim() === '') {
      if (insideBlockComment) {
        // خط خالی داخل block comment
        comments.unshift('');
        continue;
      }
      // برای Javadoc یک خط خالی قبل مجاز است؛ برای // پایان comment block
      if (comments.length > 0 && !isLineCommentLanguage(languageId)) {
        break;
      }
      continue;
    }

    const trimmed = line.trim();

    if (insideBlockComment) {
      if (trimmed.startsWith('/*')) {
        insideBlockComment = false;
        let text = trimmed.slice(trimmed.startsWith('/**') ? 3 : 2);
        text = text.replace(/^\s*\*\s?/g, '').trim();
        if (text) comments.unshift(text);
      } else {
        comments.unshift(trimmed.replace(/^\s*\*\s?/g, '').trim());
      }
      continue;
    }

    // خط قبل symbol می‌تواند پایان block comment باشد
    if (trimmed.endsWith('*/')) {
      insideBlockComment = true;
      const text = trimmed.slice(0, -2).replace(/^\s*\*\s?/g, '').trim();
      if (text) comments.unshift(text);
      continue;
    }

    const comment = extractLineCommentText(trimmed);
    if (comment !== null) {
      comments.unshift(comment);
    } else {
      break;
    }
  }

  if (comments.length === 0) return null;
  return comments.join('\n').trim() || null;
}

export function isLineCommentLanguage(languageId: string): boolean {
  return ['go', 'rust', 'swift', 'kotlin', 'java', 'php', 'csharp', 'cpp', 'c'].includes(languageId);
}

export function extractLineCommentText(trimmed: string): string | null {
  // Javadoc / Rust doc / C# XML doc: /// ...
  if (trimmed.startsWith('///') || trimmed.startsWith('//!')) {
    return trimmed.slice(3).trim();
  }
  if (trimmed.startsWith('//')) {
    return trimmed.slice(2).trim();
  }

  // Python / Ruby / Bash / PHP # comment
  if (trimmed.startsWith('#') && !trimmed.startsWith('#!')) {
    return trimmed.slice(1).trim();
  }

  return null;
}

export function extractPythonDocstring(lines: string[], symbolLine: number): string | null {
  // docstring در خطوط بلافاصله بعد از definition
  for (let i = symbolLine; i < Math.min(symbolLine + 3, lines.length); i++) {
    const line = lines[i];
    if (!line) continue;
    const trimmed = line.trim();
    if (trimmed === '') continue;

    const match = trimmed.match(/^(["']{3})([\s\S]*?)\1$/);
    if (match) {
      return match[2]!.trim();
    }

    // multi-line docstring start
    const startMatch = trimmed.match(/^(["']{3})([\s\S]*)$/);
    if (startMatch) {
      const quote = startMatch[1];
      const parts: string[] = [startMatch[2]!.trim()];
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j]!.trim();
        if (l.endsWith(quote)) {
          parts.push(l.slice(0, -quote.length).trim());
          return parts.join('\n').trim();
        }
        parts.push(l);
      }
    }

    break;
  }
  return null;
}
