/**
 * تایپ‌های TypeScript مستقیماً derive شده از contracts/blueprint.schema.json v2.0.0
 *
 * قانون: هر تغییر در blueprint schema باید اینجا منعکس شود.
 */

export interface Blueprint {
  readonly schemaVersion: '2.0.0';
  readonly meta: BlueprintMeta;
  readonly architectureOverview: ArchitectureOverview;
  readonly moduleMap: ModuleEntry[];
  readonly folderStructure: FolderNode;
  readonly dependencyGraph: BlueprintDependencyGraph;
  readonly entityTechnicalMapping: EntityTechnicalMapping[];
  readonly apiMap: ApiEntry[];
  readonly workflowExecutionMap: WorkflowExecutionEntry[];
  readonly symbolIndex: BlueprintSymbolIndexEntry[];
  readonly technicalConstraints: TechnicalConstraint[];
}

export interface BlueprintMeta {
  readonly id: string;
  readonly projectName: string;
  readonly generatedAt: string;
  readonly sourceProjectIndex: {
    readonly generatedAt: string;
    readonly schemaVersion: string;
    readonly fileCountAtSync?: number;
  };
  readonly lastSyncedCommit: string;
  readonly driftScore: number;
  readonly generatorVersion: string;
}

export interface ArchitectureOverview {
  readonly layers: ArchitectureLayer[];
  readonly dataFlow: DataFlowEdge[];
}

export interface ArchitectureLayer {
  readonly name: string;
  readonly responsibility: string;
  readonly moduleIds?: string[];
  readonly derivedFrom?: 'ai-inference' | 'manual-override' | 'heuristic';
}

export interface DataFlowEdge {
  readonly from: string;
  readonly to: string;
  readonly description: string;
}

export interface ModuleEntry {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly responsibility: string;
  readonly fileIds: string[];
  readonly dependsOnModuleIds?: string[];
}

export interface FolderNode {
  readonly name: string;
  readonly type: 'file' | 'directory';
  readonly fileId?: string | null;
  readonly children?: FolderNode[];
}

export interface BlueprintDependencyGraph {
  readonly nodes: GraphNode[];
  readonly edges: GraphEdge[];
}

export interface GraphNode {
  readonly id: string;
  readonly kind: 'file' | 'module';
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: 'imports' | 'depends-on';
  readonly weight?: number | null;
}

export interface EntityTechnicalMapping {
  readonly conceptualEntityId: string;
  readonly symbolId: string;
  readonly modelName: string;
  readonly storage: 'sql' | 'nosql' | 'in-memory' | 'file';
  readonly fields: EntityField[];
  readonly tableOrCollectionName?: string | null;
  readonly ormType?: string | null;
}

export interface EntityField {
  readonly name: string;
  readonly type: string;
  readonly nullable?: boolean;
  readonly isPrimaryKey?: boolean;
  readonly references?: string | null;
}

export interface ApiEntry {
  readonly id: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD';
  readonly path: string;
  /**
   * `null` یعنی handler یک تابعِ درجاست و symbol مستقلی ندارد.
   *
   * SE-BP-02 — قرارداد قبلی این فیلد را `string` اجباری اعلام کرده
   * بود، که فقط تا وقتی درست است که `apiMap` همیشه خالی باشد. یک
   * `app.get('/health', (req, res) => ...)` هیچ symbolی برای ارجاع
   * ندارد؛ ساختنِ شناسهٔ جعلی بدتر از اعلامِ نبودش است.
   */
  readonly handlerSymbolId: string | null;
  readonly handlerName?: string | null;
  readonly fileId?: string;
  readonly line?: number;
  readonly framework?: 'express' | 'fastify' | 'nestjs';
  readonly derivedFrom?: 'static-analysis' | 'ai-inference';
  /*
  | SE-SEC-001 — three-state on purpose: `true`/`false` فقط وقتی صادر
  | می‌شود که واقعاً شاهدی دیده شده؛ `null` یعنی «از روی نحو نمی‌شود
  | دانست / بررسی نشد». `false` پیشین به مصرف‌کننده AI اجازه می‌داد
  | بگوید «این route عمومی است» بدون هیچ شاهدی.
  */
  readonly authRequired: boolean | null;
  readonly requestSchemaRef?: string | null;
  readonly responseSchemaRef?: string | null;
  readonly middlewareSymbolIds?: string[];
  readonly relatedFeatureId?: string | null;
}

export interface WorkflowExecutionEntry {
  readonly workflowId: string;
  readonly steps: WorkflowStep[];
}

export interface WorkflowStep {
  readonly symbolId: string;
  readonly order: number;
  readonly condition?: string | null;
}

export interface BlueprintSymbolIndexEntry {
  readonly id: string;
  readonly name: string;
  readonly kind: BlueprintSymbolKind;
  readonly fileId: string;
  readonly line: number;
  readonly signature?: string | null;
  readonly importanceScore?: number | null;
}

export type BlueprintSymbolKind =
  | 'class' | 'interface' | 'enum' | 'struct' | 'trait'
  | 'function' | 'method' | 'variable' | 'constant'
  | 'namespace' | 'module' | 'property' | 'type-alias' | 'decorator';

export interface TechnicalConstraint {
  readonly id: string;
  readonly pattern: string;
  readonly description: string;
  readonly enforcement: 'lint-rule' | 'code-review' | 'manual' | 'ci-check';
  readonly violatingFileIds?: string[];
}
