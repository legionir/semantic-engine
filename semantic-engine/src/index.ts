/**
 * @aicoder/semantic-engine — public barrel.
 *
 * Re-exports the key APIs that the aicoder extension consumes.
 * This is the only file that the aicoder extension should import directly
 * from `@aicoder/semantic-engine`.
 */

// Phase 0 additive CodeIntel contracts
export { LineIndex, makeHandle, makeSymbolKey, ok, fail, DEFAULT_CODEINTEL_CONFIG, canonicalJson } from './core/contracts/codeintel';
export type { Position, TextRange, SymbolKey, Handle, Envelope, CodeIntelError, CodeIntelConfig } from './core/contracts/codeintel';
export { deterministicPaths } from './core/contracts/ports';
export { readCoherentArtifactSet, IncoherentArtifactSetError } from './pipeline/OutputWriter';
export type { FileMetadata, FileProvider, TokenCounter } from './core/contracts/ports';
export { InMemorySnapshotStore } from './core/contracts/snapshotStore';
export type { SnapshotFile, SnapshotHandleResult } from './core/contracts/snapshotStore';

// Core types
export type {
  ProjectIndex,
  FileEntry,
  SymbolEntry,
  ImportEntry,
  ExportEntry,
  DependencyEdge,
  CallEdge,
  TypeEdge,
  ReverseDependencyEdge,
  AiMetadata,
  AiScore,
  ConfigUsageEntry,
  VectorChunk,
} from './core/types/project-index.types';

// Reader & Registry
export { ProjectIndexReader } from './ai/ProjectIndexReader';
export { AiToolRegistry } from './ai/AiToolRegistry';
export { AiToolCommandHandler } from './ai/AiToolCommandHandler';
export { AiMetadataGenerator } from './ai/AiMetadataGenerator';
export { ConfigUsageMapper } from './ai/ConfigUsageMapper';

// AI Tool types
export type {
  AiTool,
  AiToolInput,
  AiToolOutput,
  AiToolResultItem,
} from './ai/tools/types';

// Scanner
export { WorkspaceScanner } from './scanner/WorkspaceScanner';

// Vector
export { VectorStore } from './vector/VectorStore';
export { VectorIndexer } from './vector/VectorIndexer';
export type { VectorIndexerOptions, IndexOptions } from './vector/VectorIndexer';
// ── بردار بدون وابستگی (فاز ۴۴) ──────────────────────────────────────────
export { HashingEmbeddingGenerator, cosine, textSegments } from './vector/HashingEmbeddingGenerator';
export type { HashingEmbeddingOptions } from './vector/HashingEmbeddingGenerator';
export { VectorStoreCache } from './vector/VectorStoreCache';
export { SymbolTermIndex } from './ai/tools/SymbolTermIndex';
export { LocalEmbeddingGenerator } from './vector/LocalEmbeddingGenerator';

// Exporters
export { JsonExporter } from './export/JsonExporter';
export { BlueprintExporter } from './export/BlueprintExporter';

// Graphs
export { CallGraphBuilder, TypeGraphBuilder, DependencyGraphBuilder } from './graphs';
// ── موتور پرس‌وجوی گراف (فاز ۳۹) ─────────────────────────────────────────
export { GraphQueryEngine, reverseEdge } from './graphs/GraphQueryEngine';
export { SubgraphExplorer } from './graphs/SubgraphExplorer';
// ── گراف چندلایه (فاز ۴۷) ────────────────────────────────────────────────
export { LayeredGraph } from './graphs/LayeredGraph';
export type { GraphLayer } from './graphs/LayeredGraph';
export { EntityMapExtractor, WorkflowExtractor } from './blueprint/EntityMapExtractor';
export { ApiMapExtractor } from './blueprint/ApiMapExtractor';
export type { ExtractedRoute, HttpMethod, ApiFramework } from './blueprint/ApiMapExtractor';
export { rescoreAfterEnrichment } from './pipeline/rescoreAfterEnrichment';
export { classifyFileRole, isEntryPointPath } from './core/fileRole';
export {
  PROJECT_OUTPUT_DIR,
  LEGACY_PROJECT_OUTPUT_DIR,
  LEGACY_FLAT_OUTPUT_DIR,
  PROJECT_INDEX_FILE,
  PROJECTS_DIR_NAME,
  BLUEPRINT_FILE,
  PROJECT_ARTIFACTS_MANIFEST_FILE,
  artifactRootFor,
  canonicalIndexPath,
  indexPathCandidates,
  normalizeWorkspaceRoot,
  resolveProjectIndexPath,
  resolveProjectPaths,
  workspaceRootFromIndexPath,
  workspaceRootFromIndex,
} from './core/config/ProjectPaths';
export type { ProjectPaths, ResolveProjectPathsOptions } from './core/config/ProjectPaths';
export {
  ARTIFACT_LOCATIONS,
  DATA_DIR_CONFIG_KEY,
  DATA_DIR_ENV_VAR,
  DEFAULT_ARTIFACT_LOCATION,
  ARTIFACT_LOCATION_CONFIG_KEY,
  artifactLocationOrDefault,
  ensureDataRoot,
  isArtifactLocation,
  platformDataRoot,
  resolveDataRoot,
} from './core/config/DataRootResolver';
export type { ArtifactLocation, DataRootOptions } from './core/config/DataRootResolver';
export {
  PROJECT_ID_PATTERN,
  assertPathSafeProjectId,
  assertProjectId,
  assertProjectRoot,
  canonicalizeRoot,
  isPathSafeProjectId,
  isSafeProjectId,
  isValidProjectId,
  projectIdFor,
  slugify,
} from './core/config/ProjectIdentity';
export { ProjectRegistry, REGISTRY_FILE, REGISTRY_VERSION } from './core/config/ProjectRegistry';
export type {
  ProjectRecord,
  ProjectRegistryOptions,
  RegisterProjectInput,
} from './core/config/ProjectRegistry';
export type { ExploreOptions, ExploredNode, ExplorationResult } from './graphs/SubgraphExplorer';
export { ExplainSymbolTool } from './ai/tools/ExplainSymbolTool';
export type { ExplainSymbolInput, SymbolExplanation } from './ai/tools/ExplainSymbolTool';
export type {
  GraphEdge,
  GraphRelation,
  Direction,
  TraversalOptions,
  TraversalResult,
  VisitedNode,
  PathResult,
  PathStep,
  SubgraphResult,
} from './graphs/GraphQueryEngine';

// ── رتبه‌بند context و بودجهٔ توکن (فاز ۴۲) ──────────────────────────────
export { ContextRanker, DEFAULT_SIGNAL_WEIGHTS } from './ai/ranking/ContextRanker';
export type {
  SignalName,
  RankSignals,
  RankCandidate,
  RankedCandidate,
  SignalContribution,
  RankOptions,
} from './ai/ranking/ContextRanker';
export { TokenBudget, estimateTokens } from './ai/ranking/TokenBudget';
export type {
  BudgetItem,
  BudgetSection,
  BudgetOptions,
  BudgetResult,
  SectionReport,
} from './ai/ranking/TokenBudget';
export { AssembleContextTool } from './ai/tools/AssembleContextTool';

// ── کشف نامزد (فاز ۴۳) ───────────────────────────────────────────────────
export { ContextDiscoverer } from './ai/discovery/ContextDiscoverer';
export type {
  DiscoverInput,
  DiscoveryResult,
  DiscoveredCandidate,
  DiscoverySeed,
  DiscoveryStats,
  CandidateOrigin,
  ContextDiscovererOptions,
} from './ai/discovery/ContextDiscoverer';
export { BlueprintIndex } from './ai/discovery/BlueprintIndex';
export type { ModuleMatch } from './ai/discovery/BlueprintIndex';
export {
  loadBlueprint,
  loadBlueprintBeside,
  BLUEPRINT_FILENAME,
} from './ai/discovery/loadBlueprint';
export type { BlueprintLoadResult } from './ai/discovery/loadBlueprint';
export { DiscoverContextTool } from './ai/tools/DiscoverContextTool';
export type { DiscoverContextInput } from './ai/tools/DiscoverContextTool';
export { queryTerms, identifierSegments, matchesSegments } from './ai/tools/queryTerms';
export type {
  AssembleContextInput,
  AssembleContextOptions,
} from './ai/tools/AssembleContextTool';

// Symbols
export { SymbolExtractorManager } from './symbols/SymbolExtractorManager';
export { TreeSitterSymbolExtractor } from './symbols/tree-sitter/TreeSitterSymbolExtractor';
export { TreeSitterParserManager } from './symbols/tree-sitter/TreeSitterParserManager';
export { HeuristicSymbolExtractor } from './symbols/heuristic/HeuristicSymbolExtractor';
// ── استخراج از زبان‌سرور (فاز ۳۳) ────────────────────────────────────────
export { LspSymbolExtractor } from './symbols/lsp/LspSymbolExtractor';
export type { LspSymbolExtractorOptions, LspClientProvider } from './symbols/lsp/LspSymbolExtractor';
export { mergeExtractionResults } from './symbols/mergeExtractionResults';
export type { MergeOutcome, MergeStats } from './symbols/mergeExtractionResults';
export { findImportLineSpans } from './symbols/lsp/importSpans';
export type { LineSpan } from './symbols/lsp/importSpans';
export { ImperativeSymbolExtractor } from './symbols/heuristic/ImperativeSymbolExtractor';
export { JsonSymbolExtractor } from './symbols/heuristic/JsonSymbolExtractor';
export { HtmlSymbolExtractor } from './symbols/heuristic/HtmlSymbolExtractor';
export { CssSymbolExtractor } from './symbols/heuristic/CssSymbolExtractor';

// Dependencies
export { DependencyExtractorManager } from './dependencies/DependencyExtractorManager';
export { TSDependencyExtractor } from './dependencies/typescript/TSDependencyExtractor';
export { TSPathResolver } from './dependencies/typescript/TSPathResolver';
export { ReExportResolver } from './dependencies/typescript/ReExportResolver';
export { HeuristicDependencyExtractor } from './dependencies/heuristic/HeuristicDependencyExtractor';

// Git
export { GitInfoCollector } from './core/git/GitInfoCollector';

// UI

// Incremental
export { IncrementalEngine } from './incremental/IncrementalEngine';

// ── Pipeline (فاز ۱۲) ────────────────────────────────────────────────────
export { IndexPipeline } from './pipeline/IndexPipeline';
export type { IndexPipelineOptions, IndexResult, IndexStats } from './pipeline/IndexPipeline';
export { createExtractors, resolveGrammarDir } from './pipeline/ExtractorFactory';
export type { ExtractorSet, ExtractorFactoryOptions } from './pipeline/ExtractorFactory';

/*
| SE-EXT-04: نوشتن خروجی و حلقهٔ watch هم بخشی از API عمومی‌اند.
| `OutputWriter` از فاز ۱۳ و `WatchPipeline` از فاز ۲۷ وجود داشتند
| ولی در barrel نبودند، پس هر مصرف‌کننده‌ای — از جمله CLI فاز ۲۹ —
| مجبور بود به مسیرهای داخلی دست ببرد.
*/
export { OutputWriter, INDEX_FILE_NAME, BLUEPRINT_FILE_NAME } from './pipeline/OutputWriter';
export type { OutputWriterOptions, WrittenArtifacts } from './pipeline/OutputWriter';

// ── WatchPipeline (فاز ۲۷) ───────────────────────────────────────────────
export { WatchPipeline } from './pipeline/WatchPipeline';
export type { WatchPipelineOptions, WatchStats } from './pipeline/WatchPipeline';

// ── Watcher و ignore مشترک (فاز ۲۸) ──────────────────────────────────────
export { FileWatcher } from './host/FileWatcher';
export type { FileWatcherOptions, PreviousHashLookup } from './host/FileWatcher';
export { IgnoreMatcher, matchesPath, normalizeSeparators } from './core/config/IgnoreMatcher';
export type { IgnoreMatcherOptions } from './core/config/IgnoreMatcher';

// ── Host (فازهای ۰۷ و ۰۸) ────────────────────────────────────────────────
export { Logger, createLoggerFromEnv, silentLogger } from './host/Logger';
export type { ILogger, LogLevel, LogFormat } from './host/Logger';
export { Config, ConfigError, envVarNameFor, findConfigFile } from './host/Config';
export { NodeFileSystem, jsonChunks, stringifyToStream } from './host/FileSystem';
export type { FileSystemPort } from './host/FileSystem';
export {
  CancellationTokenSource,
  CancellationTokenNone,
  CancellationError,
  fromAbortSignal,
  toAbortSignal,
  throwIfCancelled,
} from './host/Cancellation';
export type { CancellationToken } from './host/Cancellation';
export {
  SilentProgress,
  TtyProgress,
  NdjsonProgress,
  createProgressReporter,
} from './host/Progress';
export type { ProgressReporter, ProgressLike, ProgressUpdate } from './host/Progress';

// ── LSP (فاز ۳۲) ─────────────────────────────────────────────────────────
/*
| بارگذاری اینجا ایستا است و اشکالی ندارد: `vscode-jsonrpc` جاوااسکریپت
| خالص است و هیچ باینری‌ای دانلود نمی‌کند (برخلاف SE-EXT-05). خودِ
| زبان‌سرور یک پروسهٔ بیرونی است و فقط وقتی spawn می‌شود که کسی
| `LspClient.start()` را صدا بزند.
*/
export { LspClient, LspError, LspTimeoutError, LspStartError, LspNotRunningError, uriOf, pathOf } from './lsp/LspClient';
export type { LspClientOptions, LspClientState, LspExitInfo, RequestOptions } from './lsp/LspClient';
export {
  resolveTypeScriptLspCommand,
  describeMissingTypeScriptLsp,
  supportsLsp,
  parseVersion as parseTypeScriptVersion,
  TS_LSP_ENV_VAR,
  MINIMUM_TYPESCRIPT_LSP_MAJOR,
} from './lsp/typescriptServer';
export type { TypeScriptLspCommand, TypeScriptLspSource } from './lsp/typescriptServer';
export { TextDocumentSyncKind, DiagnosticSeverity, isHierarchical } from './lsp/protocol';
export { CapabilityProbe, isUsable, isEmptyResult, anchorsFrom, PROBED_CAPABILITIES } from './lsp/CapabilityProbe';
export { DiagnosticsProvider, toSchemaDiagnostic, severityOf } from './lsp/DiagnosticsProvider';
// ── رجیستری، چرخهٔ عمر و آمادگی (فاز ۳۶) ─────────────────────────────────
export {
  LspServerRegistry,
  DEFAULT_LSP_SERVERS,
  describeMissingServers,
} from './lsp/registry';
export type {
  LspServerSpec,
  ResolvedLspServer,
  ServerDetection,
  ServerOverride,
} from './lsp/registry';
export { LspServerManager, firstFileProbe } from './lsp/LspServerManager';
export type { LspServerManagerOptions, ManagedServerStatus, ManagedState } from './lsp/LspServerManager';
export { ReadinessTracker } from './lsp/readiness';
export type { ReadinessProbe, ReadinessVerdict } from './lsp/readiness';
export { residentMemoryMb } from './lsp/processMemory';
export { lspSettingsFrom, managerOptionsFrom } from './lsp/config';
// ── غنی‌سازی بودجه‌دار (فاز ۳۷) ───────────────────────────────────────────
export {
  LspEnrichmentService,
  BATCH_BUDGET,
  WATCH_BUDGET,
  prioritize,
  findEnclosing,
  columnOfName,
  isModuleItem,
} from './lsp/LspEnrichmentService';
export type {
  EnrichmentBudget,
  EnrichmentInput,
  EnrichmentResult,
  EnrichmentStats,
  LspEnrichmentServiceOptions,
} from './lsp/LspEnrichmentService';
export type { LspSettings } from './lsp/config';
export { InteractiveOps, LspOperationError, isPlausibleIdentifier } from './lsp/InteractiveOps';
export type {
  InteractiveOpsOptions,
  SourcePosition,
  SourceLocation,
  IncomingCall,
  EditOutcome,
  EditPreview,
} from './lsp/InteractiveOps';
export {
  planWorkspaceEdit,
  applyEditPlan,
  applyTextEdits,
  resolveInsideRoot,
  WorkspaceEditError,
} from './lsp/WorkspaceEdit';
export type {
  WorkspaceEditLike,
  WorkspaceEditPlan,
  PlannedFileEdit,
  TextEditLike,
} from './lsp/WorkspaceEdit';
export type { DiagnosticsProviderOptions, FileDiagnosticsSource } from './lsp/DiagnosticsProvider';
export type { LspCapability, CapabilityVerdict, CapabilityReport, CapabilityProbeOptions } from './lsp/CapabilityProbe';
export type {
  ServerCapabilities,
  ServerInfo,
  InitializeResult,
  DocumentSymbolResult,
  SymbolInformationLike,
  DiagnosticLike,
  PublishDiagnosticsParams,
  ProgressParams,
} from './lsp/protocol';

// ── Platform Core & Visualizer Services (V1) ─────────────────────────────
export { HttpServer } from './server/HttpServer';
export { SecurityPipeline } from './server/SecurityPipeline';
export { SseManager } from './server/SseManager';
export { JobManager } from './runtime/JobManager';
export { ProjectService } from './services/ProjectService';
export { SearchService } from './services/SearchService';
export { CodeIntelligenceService } from './services/CodeIntelligenceService';
export { ContextService } from './services/ContextService';
export { LodService } from './services/visualization/LodService';
export { GraphViewModelMapper } from './services/visualization/GraphViewModelMapper';
export type {
  HttpRequestContext,
  HttpResponseData,
  RouteDefinition,
  PlatformConfig,
  GraphNode,
  GraphEdge as PlatformGraphEdge,
  SubgraphResponse,
  NodeType,
  EdgeRelation,
} from './server/types';
export type { ManagedProject } from './services/ProjectService';
export type { JobRecord } from './runtime/JobManager';
