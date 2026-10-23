/**
 * Positions, ranges and `LineIndex` of the CodeIntel contracts (split from codeintel.ts, unchanged).
 * The coordinate-space rules are documented in `codeintel.ts`.
 */

export interface Position {
  readonly line: number;
  /** UTF-16 code units from the start of the line's content, 0-based. */
  readonly character: number;
}

export interface TextRange {
  readonly start: Position;
  readonly end: Position;
}

/** Line numbering of this contract. `ProjectIndex` symbol lines are 1-based. */
export const CODEINTEL_LINE_BASE = 0;

/** The documented bridge to the existing 1-based `ProjectIndex` line fields. */
export function toProjectIndexLine(position: Position): number {
  return position.line + CODEINTEL_LINE_BASE + 1;
}

/**
 * Bridge for `FileEntry.lines`, whose existing contract follows `countLines`:
 * it counts line terminators and does not count the empty logical line opened
 * by a trailing terminator. `LineIndex.lineCount` deliberately exposes the
 * editor/LSP view and therefore differs for empty and trailing-newline text.
 */
export function toProjectIndexLineCount(index: Pick<LineIndex, 'text' | 'lineCount'>): number {
  if (index.text.length === 0) return 0;
  const endsWithLineBreak = /(?:\r\n|\r|\n)$/u.test(index.text);
  return index.lineCount - (endsWithLineBreak ? 1 : 0);
}

/** A line break, `[start, end)`, as an offset range. */
export interface LineBreak {
  readonly start: number;
  readonly end: number;
}

/** A single source of truth for UTF-16 offsets and all supported EOL forms. */
export class LineIndex {
  /** The indexed text is decoded and has one leading BOM removed. */
  readonly text: string;
  private readonly starts: readonly number[];
  private readonly ends: readonly number[];

  constructor(input: string) {
    this.text = input.startsWith('\uFEFF') ? input.slice(1) : input;
    const starts: number[] = [0];
    const ends: number[] = [];
    let i = 0;
    while (i < this.text.length) {
      if (this.text[i] === '\r') {
        ends.push(i);
        i += this.text[i + 1] === '\n' ? 2 : 1;
        starts.push(i);
      } else if (this.text[i] === '\n') {
        ends.push(i);
        i += 1;
        starts.push(i);
      } else {
        i += 1;
      }
    }
    ends.push(this.text.length);
    this.starts = starts;
    this.ends = ends;
  }

  get lineCount(): number {
    return this.starts.length;
  }

  /** Offset of the first code unit of `line`. */
  lineStart(line: number): number {
    this.assertLine(line);
    return this.starts[line];
  }

  /** Offset of the first code unit of the line break, or the end of the text. */
  contentEnd(line: number): number {
    this.assertLine(line);
    return this.ends[line];
  }

  /**
   * The line break that ends `line`, or `null` when the line is the last one
   * and the text has no trailing break. A `\r\n` is one break of length two.
   */
  lineBreakOf(line: number): LineBreak | null {
    this.assertLine(line);
    const start = this.ends[line];
    const end = this.nextLineStart(line);
    if (end === null || end === start) return null;
    return { start, end };
  }

  /**
   * False only for the interior of a multi-code-unit line break (`\r\n`),
   * which no `Position` can address. Everything else round-trips exactly.
   */
  isRepresentableOffset(offset: number): boolean {
    this.assertOffset(offset);
    const line = this.positionAt(offset).line;
    const lineBreak = this.lineBreakOf(line);
    if (!lineBreak) return true;
    return offset <= lineBreak.start || offset >= lineBreak.end;
  }

  offsetAt(position: Position): number {
    this.assertPosition(position);
    return Math.min(this.starts[position.line] + position.character, this.ends[position.line]);
  }

  positionAt(offset: number): Position {
    this.assertOffset(offset);
    let low = 0;
    let high = this.starts.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.starts[mid] <= offset) low = mid + 1;
      else high = mid - 1;
    }
    const line = Math.max(0, high);
    return { line, character: Math.min(offset, this.ends[line]) - this.starts[line] };
  }

  toOffsets(range: TextRange): { start: number; end: number } {
    const start = this.offsetAt(range.start);
    const end = this.offsetAt(range.end);
    if (end < start) throw new RangeError('range end precedes range start');
    return { start, end };
  }

  /** The text a range covers. End-exclusive, so this is `slice`, not `substring`. */
  textOf(range: TextRange): string {
    const { start, end } = this.toOffsets(range);
    return this.text.slice(start, end);
  }

  private nextLineStart(line: number): number | null {
    return line + 1 < this.starts.length ? this.starts[line + 1] : null;
  }

  private assertLine(line: number): void {
    if (!Number.isInteger(line) || line < 0 || line >= this.starts.length) {
      throw new RangeError(`line out of bounds: ${line}`);
    }
  }

  private assertOffset(offset: number): void {
    if (!Number.isInteger(offset) || offset < 0 || offset > this.text.length) {
      throw new RangeError(`offset out of bounds: ${offset}`);
    }
  }

  private assertPosition(position: Position): void {
    if (!Number.isInteger(position.line) || !Number.isInteger(position.character)) {
      throw new RangeError('position must contain integer line and character');
    }
    if (position.line < 0 || position.line >= this.starts.length || position.character < 0) {
      throw new RangeError(`position out of bounds: ${position.line}:${position.character}`);
    }
  }
}
