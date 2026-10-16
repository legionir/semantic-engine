/**
 * Platform Core V1 — LodService Unit Tests.
 */

import { LodService } from './visualization/LodService';
import { ManagedProject } from './ProjectService';
import { ProjectIndex } from '../core/types/project-index.types';
import { ProjectIndexReader } from '../ai/ProjectIndexReader';
import { makeConfidence } from '../core/types/common.types';

describe('LodService — Semantic Level of Detail (LoD) Engine', () => {
  const lodService = new LodService();

  const mockIndex: ProjectIndex = {
    schemaVersion: '2.0.0',
    root: 'test-prj',
    generatedAt: new Date().toISOString(),
    languages: ['typescript'],
    files: [
      { id: 'f1', path: 'src/api/auth.controller.ts', language: 'typescript', role: 'controller', encoding: 'utf8', size: 100, lines: 10, hash: '1', modified: new Date().toISOString(), binary: false, testFile: false, generated: false },
      { id: 'f2', path: 'src/services/auth.service.ts', language: 'typescript', role: 'service', encoding: 'utf8', size: 100, lines: 10, hash: '2', modified: new Date().toISOString(), binary: false, testFile: false, generated: false },
      { id: 'f3', path: 'src/models/user.entity.ts', language: 'typescript', role: 'model', encoding: 'utf8', size: 100, lines: 10, hash: '3', modified: new Date().toISOString(), binary: false, testFile: false, generated: false },
    ],
    symbols: [
      {
        id: 'sym-ctrl',
        name: 'AuthController',
        kind: 'class',
        fileId: 'f1',
        parentId: null,
        line: 5,
        endLine: 30,
        exported: true,
        source: 'lsp',
        confidence: makeConfidence(100),
      },
      {
        id: 'sym-login',
        name: 'login',
        kind: 'method',
        fileId: 'f2',
        parentId: null,
        line: 12,
        endLine: 40,
        exported: true,
        source: 'lsp',
        confidence: makeConfidence(100),
      },
    ],
    graphs: {
      dependencyGraph: [
        { from: 'f1', to: 'f2', kind: 'import', provenance: { extractor: 'heuristic', confidence: 95, basis: 'resolved' } },
        { from: 'f2', to: 'f3', kind: 'import', provenance: { extractor: 'heuristic', confidence: 90, basis: 'resolved' } },
      ],
      callGraph: [
        { id: 'c1', caller: 'sym-ctrl', callee: 'sym-login', kind: 'direct', provenance: { extractor: 'heuristic', confidence: 90, basis: 'resolved' } },
      ],
      typeGraph: [],
      reverseDependencyGraph: [],
    },
    diagnostics: [],
    metrics: {
      totalFiles: 3,
      totalLoc: 30,
      totalSymbols: 2,
      avgCyclomaticComplexity: 2,
      languageBreakdown: { typescript: 3 },
    },
  };

  const project: ManagedProject = {
    id: 'test-prj',
    name: 'Test Project',
    rootPath: '/tmp/test-prj',
    aliases: [],
    indexPath: '/tmp/test-prj/.agent/semantic/project-index.json',
    status: 'ready',
    index: mockIndex,
    reader: new ProjectIndexReader(mockIndex),
    stats: {
      filesCount: 3,
      symbolsCount: 2,
      dependenciesCount: 2,
    },
  };

  it('Level 1: Architecture View extracts high-level modules and layers', () => {
    const view = lodService.getArchitectureView(project);
    expect(view.level).toBe('architecture');
    expect(view.nodes.length).toBeGreaterThan(0);
    expect(view.nodes.some(n => n.type === 'module')).toBe(true);
    expect(view.edges.length).toBeGreaterThan(0);
  });

  it('Level 2: Module View extracts files within a specific module', () => {
    const view = lodService.getModuleView(project);
    expect(view.level).toBe('module');
    expect(view.nodes.length).toBe(3);
    expect(view.nodes.every(n => n.type === 'file')).toBe(true);
  });

  it('Level 3: File View extracts symbols contained in that file', () => {
    const view = lodService.getFileView(project, 'f2');
    expect(view.level).toBe('file');
    expect(view.nodes.some(n => n.id === 'f2')).toBe(true);
    expect(view.nodes.some(n => n.id === 'sym-login')).toBe(true);
    expect(view.edges.some(e => e.relation === 'contains')).toBe(true);
  });

  it('Level 4: Neighborhood View extracts connected caller and callee nodes', () => {
    const view = lodService.getNeighborhoodView(project, 'sym-ctrl', 1, 70);
    expect(view.level).toBe('neighborhood');
    expect(view.nodes.some(n => n.id === 'sym-ctrl')).toBe(true);
  });
});
