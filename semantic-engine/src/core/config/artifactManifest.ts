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
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/** Canonical manifest name — single source for every reader/writer. */
export const MANIFEST_FILE_NAME = 'project-artifacts.manifest.json';

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
