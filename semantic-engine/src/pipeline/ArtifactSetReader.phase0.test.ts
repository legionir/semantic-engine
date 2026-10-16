import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MANIFEST_FILE_NAME, OutputWriter, readCoherentArtifactSet, IncoherentArtifactSetError } from './OutputWriter';
import { NodeFileSystem } from '../host/FileSystem';

describe('Phase 0 — coherent artifact reader', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-artifact-reader-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('returns an index only when the manifest digest and byte count match', async () => {
    const index = { schemaVersion: '2.0.0', root: 'fixture', generatedAt: new Date(0).toISOString(), languages: [], files: [], symbols: [], graphs: { dependencyGraph: [], reverseDependencyGraph: [], callGraph: [], typeGraph: [] }, diagnostics: [], metrics: {} } as any;
    await new OutputWriter({ outputDir: dir, blueprint: false, pretty: false, validate: false }).write(index);
    await expect(readCoherentArtifactSet(dir)).resolves.toMatchObject({ root: 'fixture' });
  });

  test('rejects a mismatched pair and exposes no parsed index', async () => {
    const index = { schemaVersion: '2.0.0', root: 'before', generatedAt: new Date(0).toISOString(), languages: [], files: [], symbols: [], graphs: { dependencyGraph: [], reverseDependencyGraph: [], callGraph: [], typeGraph: [] }, diagnostics: [], metrics: {} } as any;
    await new OutputWriter({ outputDir: dir, blueprint: false, pretty: false, validate: false }).write(index);
    fs.writeFileSync(path.join(dir, 'project-index.json'), JSON.stringify({ ...index, root: 'tampered' }));
    await expect(readCoherentArtifactSet(dir)).rejects.toBeInstanceOf(IncoherentArtifactSetError);
  });

  test('does not trust a manifest with a different file name', async () => {
    const index = { schemaVersion: '2.0.0', root: 'fixture', generatedAt: new Date(0).toISOString(), languages: [], files: [], symbols: [], graphs: { dependencyGraph: [], reverseDependencyGraph: [], callGraph: [], typeGraph: [] }, diagnostics: [], metrics: {} } as any;
    await new OutputWriter({ outputDir: dir, blueprint: false, pretty: false, validate: false }).write(index);
    const manifestPath = path.join(dir, MANIFEST_FILE_NAME);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.artifacts.index.path = 'other.json';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    await expect(readCoherentArtifactSet(dir)).rejects.toBeInstanceOf(IncoherentArtifactSetError);
  });

  test('uses the injected filesystem boundary', async () => {
    const fsPort = new NodeFileSystem();
    await expect(readCoherentArtifactSet(dir, fsPort)).rejects.toBeTruthy();
  });
});
