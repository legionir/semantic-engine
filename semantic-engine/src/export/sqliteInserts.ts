/**
 * Bulk-insert steps of the SQLite export (split from SQLiteExporter.ts, behavior unchanged).
 */

import { ProjectIndex } from '../core/types/project-index.types';
import { SqliteDriver, SqliteStatement } from './sqlite/SqliteDriver';

export async function insertFiles(db: SqliteDriver, files: ProjectIndex['files']): Promise<void> {
  const sql = `
    INSERT OR REPLACE INTO files
    (id, path, language, size, lines, hash, modified, binary, role, entry_point, test_file, generated,
     metrics_json, git_metrics_json, config_usages_json, ai_metadata_json, imports_json, exports_json, symbol_ids_json, outline_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const stmt = await prepare(db, sql);
  try {
    for (const file of files) {
      await runStatement(stmt, [
        file.id,
        file.path,
        file.language,
        file.size,
        file.lines,
        file.hash,
        file.modified,
        file.binary ? 1 : 0,
        file.role ?? null,
        file.entryPoint ? 1 : 0,
        file.testFile ? 1 : 0,
        file.generated ? 1 : 0,
        JSON.stringify(file.metrics ?? null),
        JSON.stringify(file.gitMetrics ?? null),
        JSON.stringify(file.configUsages ?? []),
        JSON.stringify(file.aiMetadata ?? null),
        JSON.stringify(file.imports ?? []),
        JSON.stringify(file.exports ?? []),
        JSON.stringify(file.symbolIds ?? []),
        JSON.stringify(file.outline ?? []),
      ]);
    }
  } finally {
    await finalize(stmt);
  }
}

export async function insertSymbols(db: SqliteDriver, symbols: ProjectIndex['symbols']): Promise<void> {
  const sql = `
    INSERT OR REPLACE INTO symbols
    (id, file_id, parent_id, kind, name, fully_qualified_name, signature, visibility, line, end_line,
     documentation, deprecated, exported, async, generator, abstract, static, readonly,
     parameters_json, return_type, throws_json, side_effects, generics_json, extends_json, implements_json,
     complexity, reference_count, calls_json, called_by_json, test_ids_json, source, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const stmt = await prepare(db, sql);
  try {
    for (const sym of symbols) {
      await runStatement(stmt, [
        sym.id,
        sym.fileId,
        sym.parentId ?? null,
        sym.kind,
        sym.name,
        sym.fullyQualifiedName ?? null,
        sym.signature ?? null,
        sym.visibility ?? null,
        sym.line,
        sym.endLine,
        sym.documentation ?? null,
        sym.deprecated ? 1 : 0,
        sym.exported ? 1 : 0,
        sym.async ? 1 : 0,
        sym.generator ? 1 : 0,
        sym.abstract ? 1 : 0,
        sym.static ? 1 : 0,
        sym.readonly ? 1 : 0,
        JSON.stringify(sym.parameters ?? []),
        sym.returnType ?? null,
        JSON.stringify(sym.throws ?? []),
        sym.sideEffects === null ? null : (sym.sideEffects ? 1 : 0),
        JSON.stringify(sym.generics ?? []),
        JSON.stringify(sym.extends ?? []),
        JSON.stringify(sym.implements ?? []),
        sym.complexity ?? null,
        sym.referenceCount ?? null,
        JSON.stringify(sym.calls ?? []),
        JSON.stringify(sym.calledBy ?? []),
        JSON.stringify(sym.testIds ?? []),
        /*
        | SE-EXP-15: این دو تنها ستون‌هایی بودند که `?? null`
        | نداشتند. `sqlite3` بی‌صدا NULL می‌کرد؛ یک درایور
        | سخت‌گیرتر همان‌جا می‌ترکد.
        */
        sym.source ?? null,
        sym.confidence ?? null,
      ]);
    }
  } finally {
    await finalize(stmt);
  }
}

export async function insertCallGraph(db: SqliteDriver, edges: ProjectIndex['graphs']['callGraph']): Promise<void> {
  const sql = `INSERT OR REPLACE INTO call_graph (id, caller, callee, kind, line, extractor, confidence, basis) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
  const stmt = await prepare(db, sql);
  try {
    for (const edge of edges) {
      await runStatement(stmt, [
        edge.id, edge.caller, edge.callee, edge.kind, edge.line ?? null,
        edge.provenance.extractor, edge.provenance.confidence, edge.provenance.basis,
      ]);
    }
  } finally {
    await finalize(stmt);
  }
}

export async function insertTypeGraph(db: SqliteDriver, edges: ProjectIndex['graphs']['typeGraph']): Promise<void> {
  const sql = `INSERT OR REPLACE INTO type_graph (parent, child, kind, extractor, confidence, basis) VALUES (?, ?, ?, ?, ?, ?)`;
  const stmt = await prepare(db, sql);
  try {
    for (const edge of edges) {
      await runStatement(stmt, [
        edge.parent, edge.child, edge.kind,
        edge.provenance.extractor, edge.provenance.confidence, edge.provenance.basis,
      ]);
    }
  } finally {
    await finalize(stmt);
  }
}

export async function insertDependencyGraph(db: SqliteDriver, edges: ProjectIndex['graphs']['dependencyGraph']): Promise<void> {
  const sql = `INSERT OR REPLACE INTO dependency_graph (from_id, to_id, kind, extractor, confidence, basis) VALUES (?, ?, ?, ?, ?, ?)`;
  const stmt = await prepare(db, sql);
  try {
    for (const edge of edges) {
      await runStatement(stmt, [
        edge.from, edge.to, edge.kind,
        edge.provenance.extractor, edge.provenance.confidence, edge.provenance.basis,
      ]);
    }
  } finally {
    await finalize(stmt);
  }
}

export async function insertReverseDependencyGraph(db: SqliteDriver, edges: NonNullable<ProjectIndex['graphs']['reverseDependencyGraph']>): Promise<void> {
  const sql = `INSERT OR REPLACE INTO reverse_dependency_graph (from_id, to_id, kind, extractor, confidence, basis) VALUES (?, ?, ?, ?, ?, ?)`;
  const stmt = await prepare(db, sql);
  try {
    for (const edge of edges) {
      await runStatement(stmt, [
        edge.from, edge.to, edge.kind,
        edge.provenance.extractor, edge.provenance.confidence, edge.provenance.basis,
      ]);
    }
  } finally {
    await finalize(stmt);
  }
}

export async function insertVectorChunks(
  db: SqliteDriver,
  chunks: NonNullable<ProjectIndex['vectorChunks']>,
  validFileIds: ReadonlySet<string>,
  validSymbolIds: ReadonlySet<string>
): Promise<void> {
  const sql = `
    INSERT OR REPLACE INTO vector_chunks
    (id, file_id, symbol_id, unit, content, start_line, end_line, token_estimate, embedding_json, embedding_model)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const stmt = await prepare(db, sql);
  let skipped = 0;
  let orphanSymbolRefs = 0;
  try {
    for (const chunk of chunks) {
      /*
      | SE-VEC-10 — جدول یک FK به files و symbols دارد. اگر chunk به
      | fileId/symbolId ای اشاره کند که در ایندکس نیست، درج با
      | `FOREIGN KEY constraint failed` کلِ تراکنش را می‌شکست و
      | `vector_chunks` خالی می‌ماند — دقیقاً همان چیزی که در JSON پر
      | بود ولی در SQLite نه. حالا:
      |   • chunk با fileId نامعتبر رد می‌شود (file_id NOT NULL است).
      |   • symbolId نامعتبر به NULL تبدیل می‌شود (chunk حفظ می‌شود).
      */
      if (!validFileIds.has(chunk.fileId)) {
        skipped++;
        continue;
      }
      let symbolId = chunk.symbolId ?? null;
      if (symbolId !== null && !validSymbolIds.has(symbolId)) {
        symbolId = null;
        orphanSymbolRefs++;
      }
      await runStatement(stmt, [
        chunk.id,
        chunk.fileId,
        symbolId,
        chunk.unit,
        chunk.content,
        chunk.startLine,
        chunk.endLine,
        chunk.tokenEstimate,
        chunk.embedding ? JSON.stringify(chunk.embedding) : null,
        chunk.embedding ? chunk.embeddingModel ?? 'unknown' : null,
      ]);
    }
    // ارجاع‌های ناسازگار بی‌صدا سازگار می‌شوند (skipped/orphanSymbolRefs)
    // تا export sqlite هرگز به‌خاطر یک chunkِ آویزان کاملاً fail نشود.
    void skipped;
    void orphanSymbolRefs;
  } finally {
    await finalize(stmt);
  }
}

export function prepare(db: SqliteDriver, sql: string): Promise<SqliteStatement> {
  return db.prepare(sql);
}

export function runStatement(stmt: SqliteStatement, params: unknown[]): Promise<void> {
  return stmt.run(...params);
}

export function finalize(stmt: SqliteStatement): Promise<void> {
  return stmt.finalize();
}
