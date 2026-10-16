/**
 * artifactManifest — the shared fail-closed gate over the committed
 * artifact pair. Unit-level rules; the end-to-end HTTP/MCP behavior lives
 * in the Phase 0 suites.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  MANIFEST_FILE_NAME,
  STALE_ARTIFACT_MESSAGE,
  assertIndexMatchesCommittedManifest,
  readManifestBeside,
} from './artifactManifest';

let dir: string;
let indexPath: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'se-artifact-manifest-')));
  indexPath = path.join(dir, 'project-index.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeIndex(payload: object): Buffer {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  fs.writeFileSync(indexPath, bytes);
  return bytes;
}

function writeManifest(sha256: string | undefined): void {
  const manifest = {
    artifacts: {
      index: sha256 === undefined ? null : { path: 'project-index.json', sha256, bytes: 1 },
    },
  };
  fs.writeFileSync(path.join(dir, MANIFEST_FILE_NAME), JSON.stringify(manifest));
}

describe('assertIndexMatchesCommittedManifest', () => {
  test('allows a legacy artifact with no manifest at all', () => {
    const bytes = writeIndex({ schemaVersion: '2.0.0' });
    expect(() => assertIndexMatchesCommittedManifest(indexPath, bytes)).not.toThrow();
  });

  test('allows a manifest that pins no index digest', () => {
    const bytes = writeIndex({ schemaVersion: '2.0.0' });
    writeManifest(undefined);
    expect(() => assertIndexMatchesCommittedManifest(indexPath, bytes)).not.toThrow();
  });

  test('passes when the bytes match the committed digest', () => {
    const bytes = writeIndex({ schemaVersion: '2.0.0', n: 1 });
    writeManifest(crypto.createHash('sha256').update(bytes).digest('hex'));
    expect(() => assertIndexMatchesCommittedManifest(indexPath, bytes)).not.toThrow();
  });

  test('throws the historical message on a single-byte drift', () => {
    const bytes = writeIndex({ schemaVersion: '2.0.0', n: 1 });
    writeManifest(crypto.createHash('sha256').update(bytes).digest('hex'));
    const drifted = Buffer.from(JSON.stringify({ schemaVersion: '2.0.0', n: 2 }), 'utf8');
    expect(() => assertIndexMatchesCommittedManifest(indexPath, drifted)).toThrow(
      STALE_ARTIFACT_MESSAGE
    );
  });

  test('fails closed on a torn manifest (unparseable JSON)', () => {
    const bytes = writeIndex({ schemaVersion: '2.0.0' });
    fs.writeFileSync(path.join(dir, MANIFEST_FILE_NAME), '{"artifacts":{');
    expect(() => assertIndexMatchesCommittedManifest(indexPath, bytes)).toThrow();
  });
});

describe('readManifestBeside', () => {
  test('returns null when no manifest exists', () => {
    writeIndex({});
    expect(readManifestBeside(indexPath)).toBeNull();
  });

  test('parses the manifest next to the index, not anywhere else', () => {
    writeIndex({});
    writeManifest('abc');
    expect(readManifestBeside(indexPath)?.artifacts?.index?.sha256).toBe('abc');
  });
});
