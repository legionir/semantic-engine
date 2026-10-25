/**
 * ProjectIndexReader — wrapper read-only برای ProjectIndex با index های پرس‌وجو.
 *
 * این کلاس برای AI tools ساخته شده و برخلاف ProjectIndexStore mutable نیست.
 */

import {
  ProjectIndex,
  FileEntry,
  SymbolEntry,
  ReverseDependencyEdge,
  DependencyEdge,
  CallEdge,
  TypeEdge,
} from '../core/types/project-index.types';
import { normalizePath } from '../core/utils/hash';

export class ProjectIndexReader {
  private readonly fileById = new Map<string, FileEntry>();
  private readonly fileByPath = new Map<string, FileEntry>();
  private readonly symbolById = new Map<string, SymbolEntry>();
  private readonly symbolsByFileId = new Map<string, SymbolEntry[]>();
  private readonly symbolsByName = new Map<string, SymbolEntry[]>();
  private readonly reverseDependencyByFrom = new Map<string, ReverseDependencyEdge[]>();
  private readonly dependencyByFrom = new Map<string, DependencyEdge[]>();
  private readonly callByCallee = new Map<string, CallEdge[]>();
  private readonly typeByParent = new Map<string, TypeEdge[]>();
  private readonly testsBySymbolId = new Map<string, FileEntry[]>();
  private readonly testsByFileId = new Map<string, FileEntry[]>();

  constructor(public readonly projectIndex: ProjectIndex) {
    this.buildIndexes();
  }

  private buildIndexes(): void {
    for (const file of this.projectIndex.files) {
      this.fileById.set(file.id, file);
      this.fileByPath.set(normalizePath(file.path), file);
    }

    for (const sym of this.projectIndex.symbols) {
      this.symbolById.set(sym.id, sym);

      const fileSyms = this.symbolsByFileId.get(sym.fileId) ?? [];
      fileSyms.push(sym);
      this.symbolsByFileId.set(sym.fileId, fileSyms);

      const nameSyms = this.symbolsByName.get(sym.name) ?? [];
      nameSyms.push(sym);
      this.symbolsByName.set(sym.name, nameSyms);
    }

    for (const edge of this.projectIndex.graphs.reverseDependencyGraph ?? []) {
      const list = this.reverseDependencyByFrom.get(edge.from) ?? [];
      list.push(edge);
      this.reverseDependencyByFrom.set(edge.from, list);
    }

    for (const edge of this.projectIndex.graphs.dependencyGraph) {
      const list = this.dependencyByFrom.get(edge.from) ?? [];
      list.push(edge);
      this.dependencyByFrom.set(edge.from, list);
    }

    for (const edge of this.projectIndex.graphs.callGraph) {
      const list = this.callByCallee.get(edge.callee) ?? [];
      list.push(edge);
      this.callByCallee.set(edge.callee, list);
    }

    for (const edge of this.projectIndex.graphs.typeGraph) {
      const list = this.typeByParent.get(edge.parent) ?? [];
      list.push(edge);
      this.typeByParent.set(edge.parent, list);
    }

    // Index symbol → test files
    const testFiles = new Set(this.projectIndex.files.filter(f => f.testFile).map(f => f.id));
    for (const sym of this.projectIndex.symbols) {
      if (!sym.testIds || sym.testIds.length === 0) continue;
      const tests: FileEntry[] = [];
      for (const testId of sym.testIds) {
        const testFile = this.fileById.get(testId);
        if (testFile && testFiles.has(testFile.id)) {
          tests.push(testFile);
        }
      }
      if (tests.length > 0) {
        this.testsBySymbolId.set(sym.id, tests);
      }
    }

    // Index file → test files (union of tests of its symbols)
    for (const file of this.projectIndex.files) {
      if (file.testFile) continue;
      const fileSymbols = this.symbolsByFileId.get(file.id) ?? [];
      const testIdSet = new Set<string>();
      for (const sym of fileSymbols) {
        for (const testId of sym.testIds ?? []) {
          testIdSet.add(testId);
        }
      }
      if (testIdSet.size > 0) {
        this.testsByFileId.set(
          file.id,
          Array.from(testIdSet).map(id => this.fileById.get(id)).filter((f): f is FileEntry => !!f)
        );
      }
    }
  }

  getFileById(fileId: string): FileEntry | undefined {
    return this.fileById.get(fileId);
  }

  getFileByPath(filePath: string): FileEntry | undefined {
    return this.fileByPath.get(normalizePath(filePath));
  }

  getSymbolById(symbolId: string): SymbolEntry | undefined {
    return this.symbolById.get(symbolId);
  }

  getSymbolsByName(name: string): readonly SymbolEntry[] {
    return this.symbolsByName.get(name) ?? [];
  }

  getSymbolsForFile(fileId: string): readonly SymbolEntry[] {
    return this.symbolsByFileId.get(fileId) ?? [];
  }

  getAllFiles(): readonly FileEntry[] {
    return this.projectIndex.files;
  }

  getAllSymbols(): readonly SymbolEntry[] {
    return this.projectIndex.symbols;
  }

  getReverseDependencies(fromId: string): readonly ReverseDependencyEdge[] {
    return this.reverseDependencyByFrom.get(fromId) ?? [];
  }

  getDependencies(fromId: string): readonly DependencyEdge[] {
    return this.dependencyByFrom.get(fromId) ?? [];
  }

  getCallers(calleeId: string): readonly CallEdge[] {
    return this.callByCallee.get(calleeId) ?? [];
  }

  getTypeChildren(parentId: string): readonly TypeEdge[] {
    return this.typeByParent.get(parentId) ?? [];
  }

  getTestsForSymbol(symbolId: string): readonly FileEntry[] {
    return this.testsBySymbolId.get(symbolId) ?? [];
  }

  getTestsForFile(fileId: string): readonly FileEntry[] {
    return this.testsByFileId.get(fileId) ?? [];
  }

  getSymbolsForIds(ids: readonly string[]): SymbolEntry[] {
    return ids.map(id => this.symbolById.get(id)).filter((s): s is SymbolEntry => !!s);
  }

  getFilesForIds(ids: readonly string[]): FileEntry[] {
    return ids.map(id => this.fileById.get(id)).filter((f): f is FileEntry => !!f);
  }
}
