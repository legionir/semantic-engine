/**
 * artifactManifest — the fail-closed integrity gate over the committed
 * artifact pair (`project-index.json` + `project-artifacts.manifest.json`).
 *
 * ## Why
 *
 * Publication of the index and its manifest cannot be one atomic operation
 * with the current layout (two independent files), so a crash between them
 * can leave a NEW index beside an OLD manifest digest. Two serve paths
 * behaved differently in that window:
 *
 * - `ProjectService` (HTTP) verified the index bytes against the committed
 *   digest and threw before handing anything out.
 * - `SemanticEngineMcpServer`/`cli.ts` (MCP) parsed whatever was on disk —
 *   a torn-but-valid, digest-mismatched index was served silently.
 *
 * Both now go through this one gate so the failure semantics cannot drift
 * apart again. `readCoherentArtifactSet` in the pipeline is the async
 * whole-set reader built on the same rule.
 *
 * ## Policy
 *
 * - No manifest at all → legacy artifact → allowed (unchanged behavior).
 * - Manifest without a committed index digest → allowed.
 * - Manifest present with a digest → the index bytes must match it
 *   byte-for-byte, otherwise the caller gets the historical error message
 *   and MUST NOT serve the index.
 *
 * ## Atomic publication (D-0014)
 *
 * The manifest is the commit point. The writer preserves the committed index under
 * `generations/<sha>.json` before replacing it, and `readCommittedIndexBytes` falls back to that
 * copy when the manifest still pins it, so a reader never sees a torn pair — only the old
 * committed set or the new one. Paths consumers already use are unchanged.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/** Canonical manifest name — single source for every reader/writer. */
export const MANIFEST_FILE_NAME = 'project-artifacts.manifest.json';

/** Directory (beside the index) holding digest-addressed copies of recently committed indexes. */
export const GENERATIONS_DIR_NAME = 'generations';

/** Committed generations kept besides the current one. */
export const GENERATIONS_KEPT = 2;

/** Historical message; HTTP has thrown exactly this since the gate existed. */
export const STALE_ARTIFACT_MESSAGE =
  'project-index does not match its committed artifact manifest';

export interface CommittedArtifactManifest {
  artifacts?: {
    index?: { path?: string; sha256?: string; bytes?: number } | null;
    blueprint?: { path?: string; sha256?: string } | null;
  };
}

/** Reads the manifest beside `indexPath`; `null` when none exists. */
export function readManifestBeside(indexPath: string): CommittedArtifactManifest | null {
  const manifestPath = path.join(path.dirname(indexPath), MANIFEST_FILE_NAME);
  if (!fs.existsSync(manifestPath)) return null;
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as CommittedArtifactManifest;
}

/**
 * Throws when the committed manifest pins a digest that `indexBytes` does
 * not have. Callers that catch (e.g. the MCP reload loop retries later)
 * keep serving their last good snapshot, so a byte-mismatched index is
 * never exposed to a consumer.
 */
export function assertIndexMatchesCommittedManifest(indexPath: string, indexBytes: Buffer): void {
  const expected = readManifestBeside(indexPath)?.artifacts?.index?.sha256;
  if (!expected) return;
  const actual = crypto.createHash('sha256').update(indexBytes).digest('hex');
  if (actual !== expected) {
    throw new Error(STALE_ARTIFACT_MESSAGE);
  }
}

/** `generations/<sha256>.json` beside `indexPath`. */
export function generationFilePath(indexPath: string, sha256: string): string {
  return path.join(path.dirname(indexPath), GENERATIONS_DIR_NAME, `${sha256}.json`);
}

function sha256Of(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * Returns the index bytes of the COMMITTED generation — the one the manifest pins.
 *
 * The manifest rename is the commit point of a publication (D-0014). Normally the index beside it
 * is that generation. If a writer is between "new index in place" and "new manifest in place" (or
 * died there), the manifest still pins the previous digest; that generation was preserved under
 * `generations/<sha>.json` before the index was replaced, so the reader gets a coherent old pair
 * instead of a torn one. Anything that cannot be verified throws `STALE_ARTIFACT_MESSAGE`.
 */
export function readCommittedIndexBytes(indexPath: string): Buffer {
  const rootBytes = fs.readFileSync(indexPath);
  const expected = readManifestBeside(indexPath)?.artifacts?.index?.sha256;
  if (!expected || sha256Of(rootBytes) === expected) return rootBytes;

  try {
    const preserved = fs.readFileSync(generationFilePath(indexPath, expected));
    if (sha256Of(preserved) === expected) return preserved;
  } catch {
    /* not preserved: fall through to fail-closed */
  }
  throw new Error(STALE_ARTIFACT_MESSAGE);
}

/**
 * Keeps `generations/<sha>.json` for the committed digest by hard-linking the current index
 * (copy when linking is impossible). Call before the index is replaced.
 */
export function preserveCommittedGeneration(indexPath: string): void {
  let expected: string | undefined;
  try {
    expected = readManifestBeside(indexPath)?.artifacts?.index?.sha256;
  } catch {
    return;
  }
  if (!expected) return;
  const target = generationFilePath(indexPath, expected);
  if (fs.existsSync(target)) return;
  try {
    if (sha256Of(fs.readFileSync(indexPath)) !== expected) return;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.linkSync(indexPath, target);
    } catch {
      fs.copyFileSync(indexPath, target);
    }
  } catch {
    /* best effort: without it readers fail closed, exactly as before */
  }
}

/** Drops preserved generations other than `currentSha256` and the newest `GENERATIONS_KEPT`. */
export function pruneGenerations(indexPath: string, currentSha256: string): void {
  const dir = path.join(path.dirname(indexPath), GENERATIONS_DIR_NAME);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter(name => name.endsWith('.json') && name !== `${currentSha256}.json`);
  } catch {
    return;
  }
  const dated = names
    .map(name => {
      try { return { name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }; } catch { return null; }
    })
    .filter((entry): entry is { name: string; mtime: number } => entry !== null)
    .sort((a, b) => b.mtime - a.mtime);
  for (const stale of dated.slice(GENERATIONS_KEPT)) {
    try { fs.unlinkSync(path.join(dir, stale.name)); } catch { /* ignore */ }
  }
}
