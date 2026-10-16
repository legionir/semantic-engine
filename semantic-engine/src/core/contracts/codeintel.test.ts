import {
  CODEINTEL_ERROR_CODES,
  CODEINTEL_LINE_BASE,
  DEFAULT_CODEINTEL_CONFIG,
  LineIndex,
  toProjectIndexLineCount,
  canonicalJson,
  codeIntelError,
  compareCanonical,
  fail,
  isRetryableCode,
  makeHandle,
  makeSymbolKey,
  ok,
  parseHandle,
  parseSymbolKey,
  toProjectIndexLine,
} from './codeintel';

/**
 * Fixtures that between them cover every EOL form, a BOM, a surrogate pair, a
 * trailing break and the empty text. `offset` is a UTF-16 offset into
 * `LineIndex.text`, which is the coordinate space the contract defines.
 */
const FIXTURES: readonly { readonly name: string; readonly text: string }[] = [
  { name: 'empty', text: '' },
  { name: 'single character', text: 'x' },
  { name: 'ascii LF', text: 'alpha\nbeta' },
  { name: 'CRLF', text: 'alpha\r\nbeta' },
  { name: 'lone CR', text: 'alpha\rbeta' },
  { name: 'mixed endings', text: 'a\r\nb\nc\rd' },
  { name: 'trailing LF', text: 'a\n' },
  { name: 'trailing CRLF', text: 'a\r\n' },
  { name: 'BOM and Unicode', text: '\uFEFF🙂\nλ' },
  { name: 'emoji and Persian', text: 'تابع🙂ok' },
  { name: 'tabs', text: '\tif (a)\t{\n\t}\n' },
];

describe('LineIndex — UTF-16, BOM and line endings', () => {
  test.each(FIXTURES.map(f => [f.name, f.text] as const))(
    '%s: every representable offset round-trips',
    (_name, input) => {
      const index = new LineIndex(input);
      let checked = 0;
      for (let offset = 0; offset <= index.text.length; offset += 1) {
        if (!index.isRepresentableOffset(offset)) continue;
        expect(index.offsetAt(index.positionAt(offset))).toBe(offset);
        checked += 1;
      }
      /* An empty text has exactly one representable offset; fail loudly if a
         fixture ever stops exercising anything. */
      expect(checked).toBeGreaterThan(0);
    }
  );

  test.each(FIXTURES.map(f => [f.name, f.text] as const))(
    '%s: positionAt is idempotent for every offset, including unrepresentable ones',
    (_name, input) => {
      const index = new LineIndex(input);
      for (let offset = 0; offset <= index.text.length; offset += 1) {
        const once = index.positionAt(offset);
        expect(index.positionAt(index.offsetAt(once))).toEqual(once);
      }
    }
  );

  test('empty file has one empty line', () => {
    const index = new LineIndex('');
    expect(index.lineCount).toBe(1);
    expect(index.text).toBe('');
    expect(index.positionAt(0)).toEqual({ line: 0, character: 0 });
    expect(index.offsetAt({ line: 0, character: 0 })).toBe(0);
    expect(index.lineBreakOf(0)).toBeNull();
  });

  test('offset zero is line 0, character 0', () => {
    const index = new LineIndex('first\nsecond');
    expect(index.positionAt(0)).toEqual({ line: 0, character: 0 });
    expect(index.offsetAt({ line: 0, character: 0 })).toBe(0);
  });

  test('offset to position and back across a multi-line text', () => {
    const index = new LineIndex('one\ntwo\nthree\n');
    expect(index.positionAt(0)).toEqual({ line: 0, character: 0 });
    expect(index.positionAt(4)).toEqual({ line: 1, character: 0 });
    expect(index.positionAt(6)).toEqual({ line: 1, character: 2 });
    expect(index.positionAt(8)).toEqual({ line: 2, character: 0 });
    expect(index.positionAt(14)).toEqual({ line: 3, character: 0 });
    for (const [line, character, offset] of [
      [0, 1, 1],
      [1, 1, 5],
      [2, 4, 12],
      [3, 0, 14],
    ] as const) {
      expect(index.offsetAt({ line, character })).toBe(offset);
    }
  });

  test.each(['\n', '\r\n', '\r'])('line separator %j is excluded from line range', eol => {
    const index = new LineIndex(`ab${eol}cd`);
    expect(index.contentEnd(0)).toBe(2);
    expect(index.offsetAt({ line: 0, character: 99 })).toBe(2);
    expect(index.positionAt(2 + eol.length)).toEqual({ line: 1, character: 0 });
    expect(index.lineBreakOf(0)).toEqual({ start: 2, end: 2 + eol.length });
  });

  test('a trailing break opens one more empty line', () => {
    const index = new LineIndex('only\n');
    expect(index.lineCount).toBe(2);
    expect(index.positionAt(index.text.length)).toEqual({ line: 1, character: 0 });
    expect(index.lineBreakOf(1)).toBeNull();
  });

  test('leading BOM is not part of the source coordinate space', () => {
    const index = new LineIndex('\uFEFF🙂');
    expect(index.text).toBe('🙂');
    expect(index.positionAt(0)).toEqual({ line: 0, character: 0 });
    expect(index.positionAt(2)).toEqual({ line: 0, character: 2 });
    expect(index.isRepresentableOffset(2)).toBe(true);
  });

  test('emoji character width is two UTF-16 code units', () => {
    const index = new LineIndex('a🙂b');
    expect(index.positionAt(1)).toEqual({ line: 0, character: 1 });
    expect(index.positionAt(3)).toEqual({ line: 0, character: 3 });
    expect(index.text.length).toBe(4);
  });

  /*
  | The `\n` of a `\r\n` has no `Position`: both code units of the break
  | collapse onto the line end. The policy is asserted here so it stays a
  | decision rather than an accident of the binary search.
  */
  test('the interior of a CRLF is not representable and collapses to the line end', () => {
    const index = new LineIndex('ab\r\ncd');
    expect(index.isRepresentableOffset(2)).toBe(true);
    expect(index.isRepresentableOffset(3)).toBe(false);
    expect(index.isRepresentableOffset(4)).toBe(true);

    expect(index.positionAt(3)).toEqual({ line: 0, character: 2 });
    expect(index.offsetAt(index.positionAt(3))).toBe(2);
    /* Clamping never moves forward past the requested offset. */
    expect(index.offsetAt(index.positionAt(3))).toBeLessThanOrEqual(3);
  });

  test('lone CR and LF breaks are fully representable', () => {
    for (const text of ['ab\rcd', 'ab\ncd']) {
      const index = new LineIndex(text);
      for (let offset = 0; offset <= index.text.length; offset += 1) {
        expect(index.isRepresentableOffset(offset)).toBe(true);
      }
    }
  });

  test('character beyond the line length clamps to the line end, not the next line', () => {
    const index = new LineIndex('ab\ncd');
    expect(index.offsetAt({ line: 0, character: 10 })).toBe(2);
    expect(index.offsetAt({ line: 1, character: 10 })).toBe(5);
  });

  test('ranges are end-exclusive', () => {
    const index = new LineIndex('abc\ndef');
    expect(index.textOf({ start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }))
      .toBe('abc');
    /* 'b' .. 'e' crosses the break: the break itself is not part of the text. */
    expect(index.textOf({ start: { line: 0, character: 1 }, end: { line: 1, character: 1 } }))
      .toBe('bc\nd');
    expect(index.toOffsets({ start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }))
      .toEqual({ start: 0, end: 0 });
  });

  test('rejects invalid offsets and positions', () => {
    const index = new LineIndex('x');
    expect(() => index.positionAt(-1)).toThrow(RangeError);
    expect(() => index.positionAt(2)).toThrow(RangeError);
    expect(() => index.positionAt(1.5)).toThrow(RangeError);
    expect(() => index.offsetAt({ line: -1, character: 0 })).toThrow(RangeError);
    expect(() => index.offsetAt({ line: 1, character: 0 })).toThrow(RangeError);
    expect(() => index.offsetAt({ line: 0, character: -1 })).toThrow(RangeError);
    expect(() => index.offsetAt({ line: 0.5, character: 0 })).toThrow(RangeError);
    expect(() => index.contentEnd(1)).toThrow(RangeError);
    expect(() => index.toOffsets({ start: { line: 0, character: 1 }, end: { line: 0, character: 0 } }))
      .toThrow(RangeError);
    expect(() => index.isRepresentableOffset(2)).toThrow(RangeError);
  });

  test('the 0-based contract has one documented bridge to 1-based symbol lines', () => {
    expect(CODEINTEL_LINE_BASE).toBe(0);
    expect(toProjectIndexLine({ line: 0, character: 4 })).toBe(1);
    expect(toProjectIndexLine({ line: 6, character: 0 })).toBe(7);
  });
});

describe('ProjectIndex line-count bridge', () => {
  test.each([
    ['', 0],
    ['one', 1],
    ['one\n', 1],
    ['one\ntwo', 2],
    ['one\ntwo\n', 2],
    ['one\r\ntwo\r\n', 2],
  ] as const)('maps %j to FileEntry.lines=%i', (text, expected) => {
    expect(toProjectIndexLineCount(new LineIndex(text))).toBe(expected);
  });
});

describe('SymbolKey — stable identity', () => {
  test('follows the canonical path/name/kind format', () => {
    expect(makeSymbolKey('src/a.ts', 'A.run', 'method')).toBe('src/a.ts::A.run::method');
    expect(makeSymbolKey('src/a.ts', 'A.run', 'method', 0)).toBe('src/a.ts::A.run::method#0');
    expect(makeSymbolKey('src/a.ts', 'A.run', 'method', 2)).toBe('src/a.ts::A.run::method#2');
  });

  test('keeps nested relative paths intact', () => {
    expect(makeSymbolKey('src/core/contracts/codeintel.ts', 'LineIndex.positionAt', 'method'))
      .toBe('src/core/contracts/codeintel.ts::LineIndex.positionAt::method');
  });

  test('is deterministic: same inputs, same bytes, independent of call order', () => {
    const first = makeSymbolKey('src/a.ts', 'A.run', 'method', 1);
    const second = makeSymbolKey('src/a.ts', 'A.run', 'method', 1);
    expect(first).toBe(second);
    expect(compareCanonical(first, second)).toBe(0);
  });

  test('ordinal distinguishes repeated symbols and stays valid at 0', () => {
    const plain = makeSymbolKey('src/a.ts', 'A.run', 'method');
    const zero = makeSymbolKey('src/a.ts', 'A.run', 'method', 0);
    const one = makeSymbolKey('src/a.ts', 'A.run', 'method', 1);
    expect(new Set([plain, zero, one]).size).toBe(3);
  });

  test.each([
    ['empty path', () => makeSymbolKey('', 'A.run', 'method')],
    ['empty qualified name', () => makeSymbolKey('src/a.ts', '', 'method')],
    ['empty kind', () => makeSymbolKey('src/a.ts', 'A.run', '')],
    ['absolute path', () => makeSymbolKey('/etc/passwd', 'A.run', 'method')],
    ['drive letter', () => makeSymbolKey('C:/src/a.ts', 'A.run', 'method')],
    ['windows separator', () => makeSymbolKey('src\\a.ts', 'A.run', 'method')],
    ['traversal segment', () => makeSymbolKey('../outside/a.ts', 'A.run', 'method')],
    ['unnormalized segment', () => makeSymbolKey('src//a.ts', 'A.run', 'method')],
    ['trailing slash', () => makeSymbolKey('src/a.ts/', 'A.run', 'method')],
    ['separator inside name', () => makeSymbolKey('src/a.ts', 'A::run', 'method')],
    ['hash inside kind', () => makeSymbolKey('src/a.ts', 'A.run', 'method#1')],
    ['null byte', () => makeSymbolKey('src/\0a.ts', 'A.run', 'method')],
    ['negative ordinal', () => makeSymbolKey('src/a.ts', 'A.run', 'method', -1)],
    ['fractional ordinal', () => makeSymbolKey('src/a.ts', 'A.run', 'method', 1.5)],
  ])('rejects %s', (_name, build) => {
    expect(build).toThrow(TypeError);
  });

  test('parseSymbolKey inverts makeSymbolKey', () => {
    const key = makeSymbolKey('src/a.ts', 'A.run', 'method', 2);
    expect(parseSymbolKey(key)).toEqual({
      relativePath: 'src/a.ts',
      qualifiedName: 'A.run',
      kind: 'method',
      ordinal: 2,
    });
    const plain = makeSymbolKey('src/a.ts', 'A.run', 'method');
    expect(parseSymbolKey(plain).ordinal).toBeNull();
    expect(makeSymbolKey(
      parseSymbolKey(plain).relativePath,
      parseSymbolKey(plain).qualifiedName,
      parseSymbolKey(plain).kind,
      parseSymbolKey(plain).ordinal ?? undefined
    )).toBe(plain);
  });

  test.each([
    ['two parts', 'src/a.ts::A.run'],
    ['four parts', 'src/a.ts::A.run::method::extra'],
    ['fractional ordinal', 'src/a.ts::A.run::method#1.5'],
    ['empty', ''],
  ])('parseSymbolKey rejects %s', (_name, key) => {
    expect(() => parseSymbolKey(key)).toThrow(TypeError);
  });
});

describe('Handle — range plus content hash', () => {
  test('follows the canonical range/hash format', () => {
    expect(makeHandle('src/a.ts', 10, 20, 'deadbeef')).toBe('src/a.ts:10-20#deadbeef');
    expect(makeHandle('src/a.ts', 0, 0, '00000000')).toBe('src/a.ts:0-0#00000000');
  });

  test('keeps the path and the half-open range', () => {
    const parsed = parseHandle(makeHandle('src/deep/mod.ts', 4, 9, 'abcdef01'));
    expect(parsed).toEqual({
      relativePath: 'src/deep/mod.ts',
      start: 4,
      end: 9,
      hash8: 'abcdef01',
    });
  });

  test('parseHandle round-trips to the same handle', () => {
    for (const handle of [
      makeHandle('src/a.ts', 10, 20, 'deadbeef'),
      makeHandle('a.ts', 0, 1, 'aaaaaaaa'),
      makeHandle('src/a-b:c.ts', 3, 4, 'bbbbbbbb'),
    ]) {
      const parsed = parseHandle(handle);
      expect(makeHandle(parsed.relativePath, parsed.start, parsed.end, parsed.hash8)).toBe(handle);
    }
  });

  test.each([
    ['short hash', 'src/a.ts', 0, 1, 'deadbee'],
    ['long hash', 'src/a.ts', 0, 1, 'deadbeeff'],
    ['uppercase hash', 'src/a.ts', 0, 1, 'DEADBEEF'],
    ['non-hex hash', 'src/a.ts', 0, 1, 'zzzzzzzz'],
    ['empty hash', 'src/a.ts', 0, 1, ''],
  ])('rejects %s', (_name, path, start, end, hash) => {
    expect(() => makeHandle(path, start, end, hash)).toThrow(TypeError);
  });

  test.each([
    ['end before start', 'src/a.ts', 20, 10],
    ['negative start', 'src/a.ts', -1, 10],
    ['negative end', 'src/a.ts', 0, -1],
    ['fractional offset', 'src/a.ts', 1.5, 10],
  ])('rejects %s', (_name, path, start, end) => {
    expect(() => makeHandle(path, start, end, 'deadbeef')).toThrow(TypeError);
  });

  test.each([
    ['empty path', '', 0, 1],
    ['absolute path', '/etc/passwd', 0, 1],
    ['traversal', '../secret', 0, 1],
    ['backslash', 'src\\a.ts', 0, 1],
  ])('rejects %s', (_name, path, start, end) => {
    expect(() => makeHandle(path, start, end, 'deadbeef')).toThrow(TypeError);
  });

  test.each([
    ['no hash', 'src/a.ts:10-20'],
    ['no range', 'src/a.ts#deadbeef'],
    ['missing start', 'src/a.ts:-20#deadbeef'],
    ['reversed range', 'src/a.ts:20-10#deadbeef'],
    ['uppercase hash', 'src/a.ts:10-20#DEADBEEF'],
    ['garbage range', 'src/a.ts:x-y#deadbeef'],
  ])('parseHandle rejects %s', (_name, handle) => {
    expect(() => parseHandle(handle)).toThrow(TypeError);
  });
});

describe('Envelope and configuration', () => {
  test('success and failure include snapshot, trust, stats and warnings', () => {
    const success = ok('r1', 'snap-1', { value: 1 }, {
      stats: { resultCount: 1, durationMs: 3 },
      warnings: ['truncated'],
    });
    const failure = fail('r2', 'snap-1', {
      code: 'STALE_HANDLE',
      message: 'stale',
      retryable: false,
    });
    expect(success).toMatchObject({
      ok: true,
      requestId: 'r1',
      schemaVersion: '1',
      snapshotId: 'snap-1',
      trust: 'untrusted-source-content',
      stats: { resultCount: 1, durationMs: 3 },
      warnings: ['truncated'],
      data: { value: 1 },
    });
    expect(success.error).toBeUndefined();
    expect(success.sessionId).toBeUndefined();
    expect(failure).toMatchObject({
      ok: false,
      requestId: 'r2',
      snapshotId: 'snap-1',
      trust: 'untrusted-source-content',
      error: { code: 'STALE_HANDLE' },
    });
    expect(failure.data).toBeUndefined();
  });

  test('sessionId is optional and only carried when present', () => {
    expect(ok('r1', 'snap-1', 1, { sessionId: 's-1' }).sessionId).toBe('s-1');
    expect('sessionId' in ok('r1', 'snap-1', 1)).toBe(false);
    expect('sessionId' in fail('r1', 'snap-1', codeIntelError('NOT_FOUND', 'x'))).toBe(false);
  });

  test('a stale handle is a typed, non-retryable error', () => {
    const error = codeIntelError(CODEINTEL_ERROR_CODES.STALE_HANDLE, 'content changed', {
      handle: 'src/a.ts:0-1#deadbeef',
    });
    expect(error.code).toBe('STALE_HANDLE');
    expect(error.retryable).toBe(false);
    expect(isRetryableCode(error.code)).toBe(false);
    expect(isRetryableCode(CODEINTEL_ERROR_CODES.TIMEOUT)).toBe(true);
  });

  test('the error taxonomy is closed and each code is a stable string', () => {
    const codes = Object.values(CODEINTEL_ERROR_CODES);
    expect(codes.length).toBeGreaterThan(0);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(typeof code).toBe('string');
  });

  test('defaults are disabled, read-only, bounded and frozen', () => {
    expect(DEFAULT_CODEINTEL_CONFIG).toEqual({
      enabled: false,
      readOnly: true,
      maxFiles: 10_000,
      maxFileBytes: 2_000_000,
      timeoutMs: 30_000,
    });
    expect(Object.isFrozen(DEFAULT_CODEINTEL_CONFIG)).toBe(true);
    expect(() => {
      (DEFAULT_CODEINTEL_CONFIG as { enabled: boolean }).enabled = true;
    }).toThrow(TypeError);
    expect(DEFAULT_CODEINTEL_CONFIG.enabled).toBe(false);
    expect(DEFAULT_CODEINTEL_CONFIG.readOnly).toBe(true);
  });
});

describe('canonical JSON', () => {
  test('is independent from object insertion order', () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}');
    expect(canonicalJson({ a: { x: 3, y: 2 }, z: 1 })).toBe('{"a":{"x":3,"y":2},"z":1}');
  });

  test('sorts by code unit, not by locale collation', () => {
    /* An ICU-dependent collation would put "a" before "B". */
    expect(canonicalJson({ a: 1, B: 2 })).toBe('{"B":2,"a":1}');
  });

  test('keeps array order, which is data rather than presentation', () => {
    expect(canonicalJson({ list: [3, 1, 2] })).toBe('{"list":[3,1,2]}');
  });

  test('produces identical output for identical input', () => {
    const value = { files: [{ path: 'b.ts' }, { path: 'a.ts' }], stats: { n: 2, m: 1 } };
    const clone = JSON.parse(JSON.stringify(value)) as unknown;
    expect(canonicalJson(value)).toBe(canonicalJson(clone));
    expect(canonicalJson(value)).toBe(canonicalJson(value));
  });

  test('compareCanonical matches code-unit ordering', () => {
    expect(compareCanonical('a.ts', 'b.ts')).toBeLessThan(0);
    expect(compareCanonical('b.ts', 'b.ts')).toBe(0);
    expect(compareCanonical('B.ts', 'a.ts')).toBeLessThan(0);
  });
});
