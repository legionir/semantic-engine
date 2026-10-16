/**
 * Benchmark: brute-force vs usearch vector search.
 *
 * اجرا:
 *   node dist/vector/VectorStore.benchmark.js
 *
 * خروجی:
 * - build time
 * - search time
 * - recall@K نسبت به brute-force ground truth
 */

import { VectorStore } from './VectorStore';
import { VectorChunk } from '../core/types/project-index.types';

function randomVector(dimensions: number): number[] {
  return Array.from({ length: dimensions }, () => Math.random());
}

function createChunk(id: string, embedding: number[]): VectorChunk {
  return {
    id,
    fileId: 'file1',
    symbolId: null,
    unit: 'module',
    content: `content ${id}`,
    startLine: 1,
    endLine: 1,
    tokenEstimate: 10,
    embedding,
  };
}

function buildDataset(count: number, dimensions: number): VectorChunk[] {
  return Array.from({ length: count }, (_, i) =>
    createChunk(`c${i}`, randomVector(dimensions))
  );
}

async function benchmarkBackend(
  name: string,
  chunks: VectorChunk[],
  query: number[],
  topK: number
): Promise<{ buildMs: number; searchMs: number; topResultId: string; topIds: string[] }> {
  const buildStart = process.hrtime.bigint();
  const store = new VectorStore(chunks, { backend: name as any });
  const buildMs = Number(process.hrtime.bigint() - buildStart) / 1_000_000;

  const searchStart = process.hrtime.bigint();
  const results = await store.search(query, { topK });
  const searchMs = Number(process.hrtime.bigint() - searchStart) / 1_000_000;

  return {
    buildMs,
    searchMs,
    topResultId: results[0]?.chunk.id ?? 'none',
    topIds: results.map(r => r.chunk.id),
  };
}

function computeRecall(groundTruth: string[], approximate: string[]): number {
  if (groundTruth.length === 0) return 0;
  const groundSet = new Set(groundTruth);
  let hits = 0;
  for (const id of approximate) {
    if (groundSet.has(id)) hits++;
  }
  return hits / groundTruth.length;
}

async function main(): Promise<void> {
  const counts = [100, 500, 1000, 5000];
  const dimensions = 384; // all-MiniLM-L6-v2
  const topK = 10;
  const query = randomVector(dimensions);

  console.log('VectorStore Benchmark');
  console.log('=====================');
  console.log(`dimensions=${dimensions}, topK=${topK}`);
  console.log();

  for (const count of counts) {
    const chunks = buildDataset(count, dimensions);

    const brute = await benchmarkBackend('brute-force', chunks, query, topK);
    const usearchResults = await benchmarkBackend('usearch', chunks, query, topK);

    const recall = computeRecall(brute.topIds, usearchResults.topIds);
    const speedup = brute.searchMs / usearchResults.searchMs;

    console.log(`Chunks: ${count}`);
    console.log(`  brute-force: build=${brute.buildMs.toFixed(2)}ms, search=${brute.searchMs.toFixed(2)}ms, top=${brute.topResultId}`);
    console.log(`  usearch:     build=${usearchResults.buildMs.toFixed(2)}ms, search=${usearchResults.searchMs.toFixed(2)}ms, top=${usearchResults.topResultId}`);
    console.log(`  speedup:     ${speedup.toFixed(2)}x`);
    console.log(`  recall@${topK}:  ${(recall * 100).toFixed(1)}%`);
    console.log();
  }
}

main().catch(error => {
  console.error('Benchmark failed:', error);
  process.exit(1);
});
