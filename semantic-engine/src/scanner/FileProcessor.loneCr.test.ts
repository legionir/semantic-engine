/**
 * F-0029 — lone-CR hash parity between the in-memory (complete) path and the
 * streaming (>maxFileSizeBytes) path in FileProcessor.
 *
 * The streaming path used to `stripCarriageReturns` — deleting every CR byte.
 * For CRLF that is right (CR dropped, LF kept), but for a *lone* CR it diverged
 * from the in-memory path, which runs `normalizeLineEndings` (`/\r\n?/g → \n`,
 * i.e. a lone CR becomes LF). So the same logical content hashed differently
 * depending on whether the file crossed `maxFileSizeBytes` — a staleness bug
 * for classic CR-only (old-Mac) text files, and an OS-portability crack.
 *
 * These tests force the streaming path with a tiny `maxFileSizeBytes` and
 * assert byte-for-byte hash equality with the reference `normalizeLineEndings`
 * output — for CRLF, lone CR, and CR split across stream-chunk boundaries.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceScanner } from './WorkspaceScanner';
import { FileEntry } from '../core/types/project-index.types';
import { normalizeLineEndings } from '../core/utils/encoding';

let root: string;

function write(relative: string, content: string | Buffer): void {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

async function scanOne(
  relative: string,
  maxFileSizeBytes: number
): Promise<FileEntry> {
  const result = await new WorkspaceScanner(root, { maxFileSizeBytes }).scan();
  if (!result.ok) throw result.error;
  const file = [...result.value.files].find(f => f.path === relative);
  if (!file) throw new Error(`file not scanned: ${relative}`);
  return file;
}

const sha256 = (buf: Buffer): string => crypto.createHash('sha256').update(buf).digest('hex');

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-cr-')));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('F-0029 — lone-CR hash parity (streaming == in-memory == normalizeLineEndings)', () => {
  /*
  | Payload comfortably over a 64-byte threshold so the streaming branch runs.
  | `x`s keep it text (not binary); only the line endings vary.
  */
  const filler = 'x'.repeat(400);

  it('lone-CR file hashes the same as its normalizeLineEndings reference', async () => {
    // Lone CR only: "a\rb\r" — must normalize to "a\nb\n".
    const raw = Buffer.from(`a\rb\r${filler}`, 'latin1');
    write('lone-cr.txt', raw);

    // Streaming path (>64 bytes).
    const streamed = await scanOne('lone-cr.txt', 64);
    expect(streamed.hash).toBe(sha256(Buffer.from(normalizeLineEndings(raw.toString('latin1')), 'latin1')));

    // Parity: the same content below the threshold (in-memory path) matches.
    write('lone-cr-small.txt', `a\rb\rshort`);
    const inMemory = await scanOne('lone-cr-small.txt', 1024 * 1024);
    expect(inMemory.hash).toBe(sha256(Buffer.from(normalizeLineEndings(`a\rb\rshort`), 'latin1')));
  });

  it('CRLF file hashes the same as its normalizeLineEndings reference', async () => {
    const raw = Buffer.from(`a\r\nb\r\n${filler}`, 'latin1');
    write('crlf.txt', raw);
    const streamed = await scanOne('crlf.txt', 64);
    expect(streamed.hash).toBe(sha256(Buffer.from(normalizeLineEndings(raw.toString('latin1')), 'latin1')));
  });

  it('a lone CR straddling a stream-chunk boundary is normalized to LF', async () => {
    /*
    | Force a CR to land exactly at the end of one 64KB read stream chunk and
    | its LF to begin the next. Node's createReadStream default highWaterMark is
    | 64 KiB; place the "…CR" at byte 65535 so "LF" starts chunk #2.
    */
    const before = Buffer.alloc(65535, 0x78); // 'x' * 65535
    const crlfAcrossBoundary = Buffer.concat([before, Buffer.from('\r\n', 'latin1'), Buffer.from('tail', 'latin1')]);
    write('cr-boundary.txt', crlfAcrossBoundary);

    const streamed = await scanOne('cr-boundary.txt', 1024);
    const expected = sha256(
      Buffer.from(normalizeLineEndings(crlfAcrossBoundary.toString('latin1')), 'latin1')
    );
    expect(streamed.hash).toBe(expected);
  });
});
