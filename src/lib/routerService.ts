import fs from 'node:fs';
import path from 'node:path';
import { AgentStateStore } from './agentState.ts';
import type { ChatGptAuthManager } from './chatgptAuth.ts';
import { EmbeddingEnsembleRunner } from './embeddingEnsemble.ts';
import { formatEmbeddingText, resolveChatGptSystemPrompt } from './instructions.ts';
import {
  MODEL_SPECS,
  inspectLocalModelRegistry,
  resolveTransformersModelTarget,
} from './modelRegistry.ts';
import { ProjectProgressTracker } from './progressTracker.ts';
import {
  ENCODER_PROVIDERS,
  executeLocalProviderFunction,
} from './providers.ts';
import {
  deletePackageVectorStoreByConnector,
  discoverZipArchives,
  extractAndChunkZipArchive,
  loadAllPackageVectorStores,
  normalizeVectorInPlace,
  savePackageVectorStore,
  scorePackageVectorStore,
  type LoadedPackageStore,
} from './packageIngestor.ts';
import { fetchAndChunkConnector, scoreRagChunks } from './ragEngine.ts';
import {
  checkTrinityHealth,
  fetchTrinityContext,
  ingestTrinityChunk,
  queryTrinityRag,
} from './trinityBridge.ts';
import {
  computeLocalDenseVector,
  createLocalVectorLookup,
  evaluateDataset,
  extractDynamicParametersLocal,
  optimizeRouteThresholds,
  scoreRoutes,
  scoreRoutesEnsemble,
  type EnsembleSlotLookup,
  type VectorLookup,
} from './routerEngine.ts';
import {
  DEFAULT_ENSEMBLE_CONFIG,
  DEFAULT_ROUTER_CONFIG,
  DEFAULT_SYSTEM_INSTRUCTIONS,
  SEED_EVAL_CASES,
  SEED_PROJECT_MILESTONES,
  SEED_RAG_CONNECTORS,
  SEED_ROUTES,
} from './seedData.ts';
import type { TelemetryCollector } from './telemetry.ts';
import { DEFAULT_LIBRARY_KNOWLEDGE } from './architectureBlueprints.ts';
import type {
  AgentStateSnapshot,
  ArchiveFilterProfile,
  DiscoveredZipArchive,
  EmbeddingSlotConfig,
  EmbeddingSlotRole,
  EncoderModelId,
  EnsembleConfig,
  EnsembleFusionMode,
  EnsembleSlotRuntimeStatus,
  EvalCase,
  EvalReport,
  ExtractedFunctionCall,
  FitReport,
  FunctionSchema,
  IngestedPackageManifest,
  LibraryKnowledgeState,
  LocalModelInventoryItem,
  McpStdioLogEntry,
  MilestoneProgress,
  ProjectMilestone,
  ProjectProgressState,
  ProviderExecutionResult,
  RagChunk,
  RagConnector,
  RagQueryResult,
  RagRetrievalMatch,
  RedTeamCampaignOptions,
  RedTeamCampaignReport,
  RedTeamRecommendation,
  RouteDecisionResult,
  RouteDefinition,
  RouteInstructionOverride,
  RouteScoreBreakdown,
  RouterConfig,
  SystemInstructionsConfig,
  TelemetryEdgeId,
} from './types.ts';
import { applyGuardrailPatch, runRedTeamCampaign } from './redTeamEngine.ts';

interface PersistedState {
  routes: RouteDefinition[];
  evalCases: EvalCase[];
  config: RouterConfig;
  instructions: SystemInstructionsConfig;
  ragConnectors: RagConnector[];
  ragChunks: RagChunk[];
  progressState?: ProjectProgressState;
  agentState?: AgentStateSnapshot;
}

type FeatureExtractor = (
  texts: string[],
  options: { pooling: 'mean' | 'cls'; normalize: boolean }
) => Promise<{ tolist: () => number[][] }>;

function migrateLegacyTargetModel(target: string): string {
  if (target === 'gemini-4-hydrogen') return 'openai:chatgpt-flagship';
  if (target === 'gemini-3.1-flash-lite') return 'openai:chatgpt-fast';
  return target;
}

function migrateLegacyEncoder(enc: string | undefined): EncoderModelId {
  if (enc === 'local-subword-bm25') return 'local-subword-bm25';
  if (enc === 'bge-m3') return 'bge-m3';
  if (enc === 'e5-base-v2') return 'e5-base-v2';
  if (enc === 'e5-large-v2') return 'e5-large-v2';
  return 'e5-small-v2';
}

function normalizeEnsembleConfig(raw?: Partial<EnsembleConfig>): EnsembleConfig {
  const defaults = structuredClone(DEFAULT_ENSEMBLE_CONFIG);
  const rawSlots = raw?.slots as EmbeddingSlotConfig[] | undefined;
  if (!raw || !Array.isArray(rawSlots) || rawSlots.length === 0) {
    return defaults;
  }

  const byRole = new Map<EmbeddingSlotRole, EmbeddingSlotConfig>();
  for (const s of rawSlots) {
    if (s.role === 'intent' || s.role === 'domain' || s.role === 'state') {
      byRole.set(s.role, {
        role: s.role,
        modelId: migrateLegacyEncoder(s.modelId),
        weight:
          typeof s.weight === 'number' && Number.isFinite(s.weight)
            ? Math.max(0, Math.min(1, s.weight))
            : 0.33,
        enabled: s.enabled !== false,
      });
    }
  }

  const mergedSlots: [EmbeddingSlotConfig, EmbeddingSlotConfig, EmbeddingSlotConfig] = [
    byRole.get('intent') ?? defaults.slots[0],
    byRole.get('domain') ?? defaults.slots[1],
    byRole.get('state') ?? defaults.slots[2],
  ];

  const fusionMode: EnsembleFusionMode =
    raw.fusionMode === 'max' || raw.fusionMode === 'cascade' ? raw.fusionMode : 'weighted_sum';

  return {
    slots: mergedSlots,
    fusionMode,
    parallelLoad: raw.parallelLoad !== false,
  };
}

export class EnsembleModelManager {
  private readonly caches = new Map<EncoderModelId, Map<string, number[]>>([
    ['e5-small-v2', new Map()],
    ['e5-base-v2', new Map()],
    ['e5-large-v2', new Map()],
    ['local-subword-bm25', new Map()],
    ['bge-m3', new Map()],
  ]);
  private readonly statusMap = new Map<EmbeddingSlotRole, 'idle' | 'loading' | 'ready' | 'error'>([
    ['intent', 'idle'],
    ['domain', 'ready'],
    ['state', 'ready'],
  ]);
  private readonly latencyMap = new Map<EmbeddingSlotRole, number | null>([
    ['intent', null],
    ['domain', null],
    ['state', null],
  ]);
  private readonly backendMap = new Map<EncoderModelId, 'onnx' | 'local-fallback'>([
    ['e5-small-v2', 'local-fallback'],
    ['e5-base-v2', 'local-fallback'],
    ['e5-large-v2', 'local-fallback'],
    ['local-subword-bm25', 'local-fallback'],
    ['bge-m3', 'local-fallback'],
  ]);

  constructor(
    private readonly getOnnxExtractorFn: (modelId: EncoderModelId) => Promise<FeatureExtractor>,
    private readonly hasLocalLfsModelFn: (modelId: EncoderModelId) => boolean,
    private readonly onNotify?: () => void
  ) {}

  getDimensions(modelId: EncoderModelId): number {
    return MODEL_SPECS[modelId]?.dimensions ?? 256;
  }

  getStatus(role: EmbeddingSlotRole): 'idle' | 'loading' | 'ready' | 'error' {
    return this.statusMap.get(role) ?? 'idle';
  }

  setStatus(role: EmbeddingSlotRole, status: 'idle' | 'loading' | 'ready' | 'error'): void {
    this.statusMap.set(role, status);
    this.onNotify?.();
  }

  clearCaches(): void {
    for (const c of this.caches.values()) {
      c.clear();
    }
  }

  async loadSlot(slot: EmbeddingSlotConfig): Promise<void> {
    if (!slot.enabled) {
      this.statusMap.set(slot.role, 'idle');
      return;
    }
    if (slot.modelId === 'local-subword-bm25') {
      this.backendMap.set('local-subword-bm25', 'local-fallback');
      this.statusMap.set(slot.role, 'ready');
      return;
    }

    const canRunOnnx = slot.modelId === 'e5-small-v2' || this.hasLocalLfsModelFn(slot.modelId);
    if (!canRunOnnx) {
      this.backendMap.set(slot.modelId, 'local-fallback');
      this.statusMap.set(slot.role, 'ready');
      return;
    }

    this.statusMap.set(slot.role, 'loading');
    try {
      await this.getOnnxExtractorFn(slot.modelId);
      this.backendMap.set(slot.modelId, 'onnx');
      this.statusMap.set(slot.role, 'ready');
    } catch {
      this.backendMap.set(slot.modelId, 'local-fallback');
      this.statusMap.set(slot.role, 'ready');
    }
  }

  async loadAll(slots: EmbeddingSlotConfig[], parallel = true): Promise<void> {
    if (parallel) {
      await Promise.all(slots.map((s) => this.loadSlot(s)));
    } else {
      for (const s of slots) {
        await this.loadSlot(s);
      }
    }
    this.onNotify?.();
  }

  async embedTexts(
    modelId: EncoderModelId,
    texts: string[],
    role?: EmbeddingSlotRole
  ): Promise<number[][]> {
    const startNs = process.hrtime.bigint();
    const cache = this.caches.get(modelId) ?? new Map<string, number[]>();
    this.caches.set(modelId, cache);
    const dims = this.getDimensions(modelId);
    const spec = MODEL_SPECS[modelId] ?? MODEL_SPECS['local-subword-bm25'];

    const formattedList = texts.map((t) =>
      modelId === 'bge-m3' && !this.hasLocalLfsModelFn('bge-m3')
        ? `Represent this sentence: ${t}`
        : t
    );
    const missing = Array.from(new Set(formattedList)).filter((k) => k.length > 0 && !cache.has(k));

    if (missing.length > 0) {
      const canRunOnnx =
        spec.supportsOnnx &&
        (modelId === 'e5-small-v2' || this.hasLocalLfsModelFn(modelId));

      if (canRunOnnx) {
        try {
          const ext = await this.getOnnxExtractorFn(modelId);
          const pooling = spec.pooling === 'cls' ? 'cls' : 'mean';
          for (let i = 0; i < missing.length; i += 16) {
            const batch = missing.slice(i, i + 16);
            const out = await ext(batch, { pooling, normalize: true });
            const vecs = out.tolist();
            batch.forEach((key, idx) => {
              cache.set(key, vecs[idx]);
            });
          }
          this.backendMap.set(modelId, 'onnx');
        } catch {
          this.backendMap.set(modelId, 'local-fallback');
          for (const key of missing) {
            cache.set(key, computeLocalDenseVector(key, dims));
          }
        }
      } else {
        this.backendMap.set(modelId, 'local-fallback');
        for (const key of missing) {
          const cleanForLocal =
            modelId === 'bge-m3' ? key.replace(/^Represent this sentence:\s*/, '') : key;
          cache.set(key, computeLocalDenseVector(cleanForLocal, dims));
        }
      }
    }

    const elapsedMs =
      Math.round((Number(process.hrtime.bigint() - startNs) / 1_000_000) * 100) / 100;
    if (role) {
      this.statusMap.set(role, 'ready');
      this.latencyMap.set(role, elapsedMs);
    }

    return formattedList.map((key) => {
      const cached = cache.get(key);
      if (cached) return cached;
      const cleanForLocal =
        modelId === 'bge-m3' ? key.replace(/^Represent this sentence:\s*/, '') : key;
      return computeLocalDenseVector(cleanForLocal, dims);
    });
  }

  getCachedVector(modelId: EncoderModelId, key: string): number[] | undefined {
    return this.caches.get(modelId)?.get(key);
  }

  getSlotStatuses(ensemble: EnsembleConfig): EnsembleSlotRuntimeStatus[] {
    return ensemble.slots.map((slot) => ({
      role: slot.role,
      modelId: slot.modelId,
      status: slot.enabled ? this.getStatus(slot.role) : 'idle',
      dimensions: this.getDimensions(slot.modelId),
      cachedCount: this.caches.get(slot.modelId)?.size ?? 0,
      lastLatencyMs: this.latencyMap.get(slot.role) ?? null,
      backend: this.backendMap.get(slot.modelId) ?? 'local-fallback',
    }));
  }
}

export class UnifiedRouterService {
  private readonly rootDir: string;
  private readonly dataDir: string;
  private readonly packagesDir: string;
  private readonly stateFile: string;
  private readonly knowledgeFile: string;
  private state: PersistedState;
  private libraryKnowledge: LibraryKnowledgeState;
  private packageStores: LoadedPackageStore[] = [];

  private readonly e5EmbeddingCache = new Map<string, number[]>();
  private readonly onnxExtractors = new Map<EncoderModelId, Promise<FeatureExtractor>>();
  private e5Status: 'idle' | 'loading' | 'ready' | 'error' = 'idle';

  private readonly agentState: AgentStateStore;
  private readonly ensembleManager: EnsembleModelManager;
  private readonly progressTracker: ProjectProgressTracker;

  private isEvaluatingOrFitting = false;
  private lastOpenAiError: string | null = null;
  private lastOpenAiLatencyMs: number | null = null;
  private lastRouterError: string | null = null;
  private lastRouteLatencyMs: number | null = null;
  private lastEmbedLatencyMs: number | null = null;
  private lastRagLatencyMs: number | null = null;
  private lastRagError: string | null = null;
  private mcpCallCount = 0;
  private readonly mcpLogs: McpStdioLogEntry[] = [];
  private readonly redTeamHistory: RedTeamCampaignReport[] = [];
  private stateFileMtimeMs = 0;

  constructor(
    rootDir: string,
    private readonly chatgptAuth: ChatGptAuthManager,
    private readonly telemetry: TelemetryCollector
  ) {
    this.rootDir = rootDir;
    this.dataDir = path.join(rootDir, 'data');
    this.packagesDir = path.join(this.dataDir, 'packages');
    this.stateFile = path.join(this.dataDir, 'router-state.json');
    this.knowledgeFile = path.join(this.dataDir, 'library-knowledge.json');

    this.agentState = new AgentStateStore();
    this.ensembleManager = new EnsembleModelManager(
      (modelId) => this.getOnnxExtractor(modelId),
      (modelId) => this.hasLocalLfsModel(modelId),
      () => this.telemetry.notify()
    );

    this.state = this.loadState();
    this.syncLoadedPackageStoresIntoConnectors(false);

    const stateSlotModel = (): EncoderModelId =>
      this.getEffectiveEnsembleConfig().slots.find((s) => s.role === 'state')?.modelId ?? 'bge-m3';

    this.progressTracker = new ProjectProgressTracker({
      sessionId: `sr-session-${Date.now().toString(36)}`,
      agentState: this.agentState,
      embedStateTexts: (texts) => this.ensembleManager.embedTexts(stateSlotModel(), texts, 'state'),
    });

    if (this.state.agentState) {
      this.agentState.loadSnapshot(this.state.agentState);
    }
    if (this.state.progressState && this.state.progressState.milestones.length > 0) {
      this.progressTracker.restoreState(this.state.progressState);
    } else {
      // Seed synchronous milestone shells first, then embed async in warmUp/first eval
      void this.progressTracker.setMilestones(structuredClone(SEED_PROJECT_MILESTONES)).then((ps) => {
        this.state.progressState = ps;
        this.saveState();
      });
    }

    this.saveState();
    this.libraryKnowledge = this.loadLibraryKnowledge();
    this.saveLibraryKnowledge();
  }

  private loadState(): PersistedState {
    try {
      if (fs.existsSync(this.stateFile)) {
        const raw = fs.readFileSync(this.stateFile, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<PersistedState>;
        if (Array.isArray(parsed.routes) && Array.isArray(parsed.evalCases) && parsed.config) {
          const migratedRoutes = parsed.routes.map((r) => ({
            ...r,
            targetModel: migrateLegacyTargetModel(r.targetModel),
          }));
          const migratedConfig: RouterConfig = {
            ...DEFAULT_ROUTER_CONFIG,
            ...parsed.config,
            encoderModel: migrateLegacyEncoder(parsed.config.encoderModel),
            encoderEnsemble: normalizeEnsembleConfig(parsed.config.encoderEnsemble),
            mcpEnabled: parsed.config.mcpEnabled ?? DEFAULT_ROUTER_CONFIG.mcpEnabled,
            ragEnabledByDefault:
              parsed.config.ragEnabledByDefault ?? DEFAULT_ROUTER_CONFIG.ragEnabledByDefault,
          };
          const instructions: SystemInstructionsConfig = {
            embedding: {
              ...DEFAULT_SYSTEM_INSTRUCTIONS.embedding,
              ...(parsed.instructions?.embedding ?? {}),
            },
            chatgpt: {
              ...DEFAULT_SYSTEM_INSTRUCTIONS.chatgpt,
              ...(parsed.instructions?.chatgpt ?? {}),
            },
          };
          const ragConnectors = Array.isArray(parsed.ragConnectors)
            ? parsed.ragConnectors
            : structuredClone(SEED_RAG_CONNECTORS);
          const ragChunks = Array.isArray(parsed.ragChunks) ? parsed.ragChunks : [];

          return {
            routes: migratedRoutes,
            evalCases: parsed.evalCases,
            config: migratedConfig,
            instructions,
            ragConnectors,
            ragChunks,
            progressState: parsed.progressState,
            agentState: parsed.agentState,
          };
        }
      }
    } catch {
      // Fallback to deterministic seed state
    }

    return {
      routes: structuredClone(SEED_ROUTES),
      evalCases: structuredClone(SEED_EVAL_CASES),
      config: structuredClone(DEFAULT_ROUTER_CONFIG),
      instructions: structuredClone(DEFAULT_SYSTEM_INSTRUCTIONS),
      ragConnectors: structuredClone(SEED_RAG_CONNECTORS),
      ragChunks: [],
    };
  }

  private saveState(): void {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2), 'utf-8');
      this.stateFileMtimeMs = fs.statSync(this.stateFile).mtimeMs;
    } catch (err) {
      console.error('Failed to persist router state:', err);
    }
  }

  private ensurePackageRoutesRegistered(): boolean {
    let changed = false;
    const hasReaPkg = this.packageStores.some(
      (s) => s.manifest.id.includes('rea-agents') || s.manifest.packageName.includes('rea-agents')
    );
    if (hasReaPkg) {
      const existingIdx = this.state.routes.findIndex(
        (r) => r.id === 'route-rea-agents' || r.name === 'rea_agents'
      );
      if (existingIdx === -1) {
        const seedReaRoute = SEED_ROUTES.find((r) => r.id === 'route-rea-agents');
        if (seedReaRoute) {
          this.state.routes.push(structuredClone(seedReaRoute));
          changed = true;
        }
      }
    }
    return changed;
  }

  private syncLoadedPackageStoresIntoConnectors(persistIfChanged = false): void {
    this.packageStores = loadAllPackageVectorStores(this.packagesDir);
    let changed = this.ensurePackageRoutesRegistered();

    for (const store of this.packageStores) {
      const m = store.manifest;
      const pkgUrl = `package://${m.sourceArchive}`;
      const existingIdx = this.state.ragConnectors.findIndex((c) => c.id === m.connectorId);

      if (existingIdx === -1) {
        this.state.ragConnectors.push({
          id: m.connectorId,
          name: m.connectorName,
          url: pkgUrl,
          method: 'GET',
          headers: {},
          parserMode: 'auto',
          boundRouteIds: [],
          chunkSize: 1800,
          chunkOverlap: 120,
          enabled: true,
          lastSyncedAt: m.ingestedAt,
          lastStatus: 'ok',
          lastLatencyMs: m.latencyMs,
          lastError: null,
          chunkCount: m.chunkCount,
        });
        changed = true;
      } else {
        const existing = this.state.ragConnectors[existingIdx];
        if (
          existing.chunkCount !== m.chunkCount ||
          existing.url !== pkgUrl ||
          existing.lastStatus !== 'ok'
        ) {
          this.state.ragConnectors[existingIdx] = {
            ...existing,
            name: m.connectorName,
            url: pkgUrl,
            lastSyncedAt: m.ingestedAt,
            lastStatus: 'ok',
            lastLatencyMs: m.latencyMs,
            lastError: null,
            chunkCount: m.chunkCount,
          };
          changed = true;
        }
      }
    }

    if (changed && persistIfChanged) {
      this.saveState();
    }
  }

  reloadPackagesFromDisk(): {
    packages: IngestedPackageManifest[];
    connectors: RagConnector[];
    routes: RouteDefinition[];
    chunksCount: number;
  } {
    this.state = this.loadState();
    this.syncLoadedPackageStoresIntoConnectors(true);
    this.e5EmbeddingCache.clear();
    this.ensembleManager.clearCaches();
    this.telemetry.notify();
    return {
      packages: this.getIngestedPackages(),
      connectors: this.state.ragConnectors,
      routes: this.state.routes,
      chunksCount: this.getTotalRagChunksCount(),
    };
  }

  reloadStateIfModified(): boolean {
    try {
      if (!fs.existsSync(this.stateFile)) return false;
      const mtimeMs = fs.statSync(this.stateFile).mtimeMs;
      if (this.stateFileMtimeMs === 0) {
        this.stateFileMtimeMs = mtimeMs;
        return false;
      }
      if (mtimeMs > this.stateFileMtimeMs) {
        this.state = this.loadState();
        this.syncLoadedPackageStoresIntoConnectors(false);
        this.stateFileMtimeMs = mtimeMs;
        this.e5EmbeddingCache.clear();
        this.ensembleManager.clearCaches();
        if (this.state.progressState) {
          this.progressTracker.restoreState(this.state.progressState);
        }
        if (this.state.agentState) {
          this.agentState.loadSnapshot(this.state.agentState);
        }
        return true;
      }
    } catch {
      // Ignore stat/read race gracefully
    }
    return false;
  }

  getEffectiveEnsembleConfig(): EnsembleConfig {
    return normalizeEnsembleConfig(this.state.config.encoderEnsemble);
  }

  private loadLibraryKnowledge(): LibraryKnowledgeState {
    try {
      if (fs.existsSync(this.knowledgeFile)) {
        const raw = fs.readFileSync(this.knowledgeFile, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<LibraryKnowledgeState>;
        if (Array.isArray(parsed.blueprints) && parsed.blueprints.length === 2) {
          return {
            version: parsed.version ?? DEFAULT_LIBRARY_KNOWLEDGE.version,
            updatedAt: parsed.updatedAt ?? new Date().toISOString(),
            notes: typeof parsed.notes === 'string' ? parsed.notes : DEFAULT_LIBRARY_KNOWLEDGE.notes,
            blueprints: parsed.blueprints as LibraryKnowledgeState['blueprints'],
            comparisonMatrix: Array.isArray(parsed.comparisonMatrix)
              ? parsed.comparisonMatrix
              : structuredClone(DEFAULT_LIBRARY_KNOWLEDGE.comparisonMatrix),
          };
        }
      }
    } catch {
      // Fallback to seeded library knowledge
    }
    return structuredClone(DEFAULT_LIBRARY_KNOWLEDGE);
  }

  private saveLibraryKnowledge(): void {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }
      fs.writeFileSync(
        this.knowledgeFile,
        JSON.stringify(this.libraryKnowledge, null, 2),
        'utf-8'
      );
    } catch (err) {
      console.error('Failed to persist library knowledge:', err);
    }
  }

  getLibraryKnowledge(): LibraryKnowledgeState {
    return this.libraryKnowledge;
  }

  updateLibraryKnowledge(patch: Partial<LibraryKnowledgeState>): LibraryKnowledgeState {
    const nextBlueprints =
      Array.isArray(patch.blueprints) && patch.blueprints.length === 2
        ? (patch.blueprints as LibraryKnowledgeState['blueprints'])
        : this.libraryKnowledge.blueprints;

    this.libraryKnowledge = {
      ...this.libraryKnowledge,
      notes: typeof patch.notes === 'string' ? patch.notes : this.libraryKnowledge.notes,
      blueprints: nextBlueprints,
      comparisonMatrix: Array.isArray(patch.comparisonMatrix)
        ? patch.comparisonMatrix
        : this.libraryKnowledge.comparisonMatrix,
      updatedAt: new Date().toISOString(),
    };
    this.saveLibraryKnowledge();
    return this.libraryKnowledge;
  }

  resetLibraryKnowledge(): LibraryKnowledgeState {
    this.libraryKnowledge = {
      ...structuredClone(DEFAULT_LIBRARY_KNOWLEDGE),
      updatedAt: new Date().toISOString(),
    };
    this.saveLibraryKnowledge();
    return this.libraryKnowledge;
  }

  getTotalRagChunksCount(): number {
    const pkgChunks = this.packageStores.reduce((sum, s) => sum + s.chunks.length, 0);
    return this.state.ragChunks.length + pkgChunks;
  }

  getIngestedPackages(): IngestedPackageManifest[] {
    this.reloadStateIfModified();
    return this.packageStores.map((s) => s.manifest);
  }

  getAvailablePackageArchives(): DiscoveredZipArchive[] {
    return discoverZipArchives(this.rootDir);
  }

  getPackageManifest(packageIdOrConnectorId: string): IngestedPackageManifest | null {
    this.reloadStateIfModified();
    const store = this.packageStores.find(
      (s) =>
        s.manifest.id === packageIdOrConnectorId ||
        s.manifest.connectorId === packageIdOrConnectorId
    );
    return store?.manifest ?? null;
  }

  getTelemetryStateInput(expressPort: number) {
    const activeProfile = this.chatgptAuth.getActiveProfile();
    const loopback = this.chatgptAuth.getLoopbackRuntimeStatus();
    const ensemble = this.getEffectiveEnsembleConfig();
    const progress = this.progressTracker.getState();
    const activeFocusLabel =
      progress.milestones.find((m) => m.id === progress.currentFocusId)?.label ?? null;
    const pkgVectorsCount = this.packageStores.reduce((sum, s) => sum + s.chunks.length, 0);

    return {
      expressPort,
      chatGptConnected: Boolean(activeProfile?.connected),
      chatGptSharing: Boolean(activeProfile?.sharing),
      chatGptEmail: activeProfile?.email ?? activeProfile?.subject ?? null,
      pendingAuthCount: loopback.pendingOAuthCount + loopback.pendingDeviceCount,
      lastOpenAiError: this.lastOpenAiError,
      lastOpenAiLatencyMs: this.lastOpenAiLatencyMs,
      activeRouteCount: this.state.routes.filter((r) => r.enabled).length,
      totalRouteCount: this.state.routes.length,
      isEvaluatingOrFitting: this.isEvaluatingOrFitting,
      lastRouterError: this.lastRouterError,
      lastRouteLatencyMs: this.lastRouteLatencyMs,
      encoderModel: this.state.config.encoderModel,
      e5Status: this.e5Status,
      e5CachedCount: this.e5EmbeddingCache.size + pkgVectorsCount,
      lastEmbedLatencyMs: this.lastEmbedLatencyMs,
      loopbackListening: loopback.listening,
      loopbackPort: loopback.port,
      mcpEnabled: this.state.config.mcpEnabled,
      mcpCallCount: this.mcpCallCount,
      ragConnectorCount: this.state.ragConnectors.filter((c) => c.enabled).length,
      ragChunkCount: this.getTotalRagChunksCount(),
      packageCount: this.packageStores.length,
      lastRagLatencyMs: this.lastRagLatencyMs,
      lastRagError: this.lastRagError,
      ensembleActive: ensemble.slots.some((s) => s.enabled),
      fusionMode: ensemble.fusionMode,
      slotStatuses: this.ensembleManager.getSlotStatuses(ensemble),
      progressOverall: progress.overallProgress,
      activeFocusLabel,
    };
  }

  getWorkspaceData() {
    this.reloadStateIfModified();
    return {
      routes: this.state.routes,
      evalCases: this.state.evalCases,
      config: this.state.config,
      instructions: this.state.instructions,
      ragConnectors: this.state.ragConnectors,
      ragChunksCount: this.getTotalRagChunksCount(),
      ingestedPackages: this.packageStores.map((s) => s.manifest),
      availablePackageArchives: this.getAvailablePackageArchives(),
      progressState: this.progressTracker.getState(),
      agentState: this.agentState.getSnapshot(),
    };
  }

  getRoutes(): RouteDefinition[] {
    this.reloadStateIfModified();
    return this.state.routes;
  }

  getConfig(): RouterConfig {
    this.reloadStateIfModified();
    return this.state.config;
  }

  getInstructions(): SystemInstructionsConfig {
    this.reloadStateIfModified();
    return this.state.instructions;
  }

  getRagConnectors(): RagConnector[] {
    this.reloadStateIfModified();
    return this.state.ragConnectors;
  }

  getWebhookRagChunks(): RagChunk[] {
    this.reloadStateIfModified();
    return this.state.ragChunks;
  }

  getRagChunks(connectorId?: string): RagChunk[] {
    this.reloadStateIfModified();
    const mapPackageChunk = (
      store: LoadedPackageStore,
      ch: LoadedPackageStore['chunks'][number]
    ): RagChunk => ({
      id: ch.id,
      connectorId: ch.connectorId,
      connectorName: ch.connectorName,
      sourceUrl: `package://${store.manifest.sourceArchive}#${ch.filePath}`,
      text: ch.text,
      chunkIndex: ch.chunkIndex,
      fetchedAt: ch.fetchedAt,
    });

    if (connectorId) {
      const pkgStore = this.packageStores.find(
        (s) => s.manifest.connectorId === connectorId || s.manifest.id === connectorId
      );
      if (pkgStore) {
        return pkgStore.chunks.map((ch) => mapPackageChunk(pkgStore, ch));
      }
      return this.state.ragChunks.filter((c) => c.connectorId === connectorId);
    }

    const allPkgChunks: RagChunk[] = [];
    for (const store of this.packageStores) {
      for (const ch of store.chunks) {
        allPkgChunks.push(mapPackageChunk(store, ch));
      }
    }
    return [...this.state.ragChunks, ...allPkgChunks];
  }

  getLocalModelInventory(): LocalModelInventoryItem[] {
    return inspectLocalModelRegistry(this.rootDir);
  }

  hasLocalLfsModel(modelId: EncoderModelId): boolean {
    if (modelId === 'local-subword-bm25') return true;
    const item = inspectLocalModelRegistry(this.rootDir).find((m) => m.id === modelId);
    return Boolean(item?.installedInLfs);
  }

  getProvidersMetadata() {
    const ensemble = this.getEffectiveEnsembleConfig();
    return {
      activeEncoder: this.state.config.encoderModel,
      e5Status: this.e5Status,
      e5CachedCount: this.e5EmbeddingCache.size,
      encoders: ENCODER_PROVIDERS,
      localModels: this.getLocalModelInventory(),
      ensemble,
      slotStatuses: this.ensembleManager.getSlotStatuses(ensemble),
    };
  }

  getProgressState(): ProjectProgressState {
    this.reloadStateIfModified();
    return this.progressTracker.getState();
  }

  getAgentStateSnapshot(): AgentStateSnapshot {
    this.reloadStateIfModified();
    return this.agentState.getSnapshot();
  }

  clearAgentRouteOverride(): AgentStateSnapshot {
    this.agentState.set('routeOverride', null);
    this.state.agentState = this.agentState.getSnapshot();
    this.saveState();
    this.telemetry.notify();
    return this.state.agentState;
  }

  async setMilestones(milestones: ProjectMilestone[]): Promise<ProjectProgressState> {
    const endTrack = this.telemetry.beginSpan('embedding_state->progress_tracker');
    try {
      const next = await this.progressTracker.setMilestones(milestones);
      this.state.progressState = next;
      this.state.agentState = this.agentState.getSnapshot();
      this.saveState();
      endTrack('ok');
      return next;
    } catch (err) {
      endTrack('error');
      throw err;
    }
  }

  async evaluateProgressOutput(outputText: string): Promise<{
    state: ProjectProgressState;
    newlyCompleted: MilestoneProgress[];
    autoAdvanceRoute: string | null;
    agentState: AgentStateSnapshot;
  }> {
    const endStateEdge = this.telemetry.beginSpan('router->embedding_state');
    const endTrack = this.telemetry.beginSpan('embedding_state->progress_tracker');
    try {
      const res = await this.progressTracker.updateProgress(outputText);
      this.state.progressState = res.state;
      this.state.agentState = this.agentState.getSnapshot();
      this.saveState();
      endStateEdge('ok');
      endTrack('ok');
      return {
        ...res,
        agentState: this.state.agentState,
      };
    } catch (err) {
      endStateEdge('error');
      endTrack('error');
      throw err;
    }
  }

  recordMcpLog(entry: McpStdioLogEntry): void {
    if (entry.direction === 'stdin') {
      this.mcpCallCount += 1;
    }
    this.mcpLogs.unshift(entry);
    if (this.mcpLogs.length > 60) {
      this.mcpLogs.length = 60;
    }
    this.telemetry.notify();
  }

  getMcpLogs(): McpStdioLogEntry[] {
    return [...this.mcpLogs];
  }

  private async getOnnxExtractor(
    modelId: EncoderModelId = 'e5-small-v2',
    opts?: { allowRemote?: boolean }
  ): Promise<FeatureExtractor> {
    const resolvedId: EncoderModelId = MODEL_SPECS[modelId]?.supportsOnnx
      ? modelId
      : 'e5-small-v2';
    let existing = this.onnxExtractors.get(resolvedId);
    if (!existing) {
      const target = resolveTransformersModelTarget(resolvedId, this.rootDir);
      if (resolvedId === 'e5-small-v2') {
        this.e5Status = 'loading';
        this.telemetry.notify();
      }
      existing = (async () => {
        const { env, pipeline } = await import('@huggingface/transformers');
        if (target.localFilesOnly) {
          env.localModelPath = target.modelsRoot;
        }
        const allowRemote = opts?.allowRemote ?? true;
        const extractor = (await pipeline('feature-extraction', target.spec.hfRepo, {
          dtype: target.dtype,
          local_files_only: target.localFilesOnly || !allowRemote ? true : false,
        })) as unknown as FeatureExtractor;
        if (resolvedId === 'e5-small-v2') {
          this.e5Status = 'ready';
          this.telemetry.notify();
        }
        return extractor;
      })().catch((err) => {
        if (resolvedId === 'e5-small-v2') {
          this.e5Status = 'error';
          this.telemetry.notify();
        }
        this.onnxExtractors.delete(resolvedId);
        throw err;
      });
      this.onnxExtractors.set(resolvedId, existing);
    }
    return existing;
  }

  private async getE5Extractor(): Promise<FeatureExtractor> {
    return this.getOnnxExtractor('e5-small-v2');
  }

  private collectPassageDescriptors(routes: RouteDefinition[], includeRagChunks = false) {
    const passageOverrideMap = new Map<string, RouteInstructionOverride | undefined>();
    const items: Array<{ raw: string; formatted: string }> = [];

    for (const r of routes) {
      if (!r.enabled) continue;
      for (const u of r.utterances) {
        if (!passageOverrideMap.has(u)) {
          passageOverrideMap.set(u, r.instructionOverrides);
        }
        items.push({
          raw: u,
          formatted: formatEmbeddingText(
            u,
            'passage',
            this.state.instructions.embedding,
            r.instructionOverrides
          ),
        });
      }
    }

    if (includeRagChunks) {
      for (const chunk of this.state.ragChunks) {
        if (!passageOverrideMap.has(chunk.text)) {
          passageOverrideMap.set(chunk.text, undefined);
        }
        items.push({
          raw: chunk.text,
          formatted: formatEmbeddingText(
            chunk.text,
            'passage',
            this.state.instructions.embedding
          ),
        });
      }
    }

    return { passageOverrideMap, items };
  }

  async warmUpEmbeddings(): Promise<void> {
    const ensemble = this.getEffectiveEnsembleConfig();
    if (ensemble.slots.some((s) => s.enabled)) {
      await this.ensembleManager.loadAll(ensemble.slots, ensemble.parallelLoad);
      await this.progressTracker.ensureMilestonesEmbedded();
    }
    if (this.state.config.encoderModel !== 'e5-small-v2') return;
    const endBridge = this.telemetry.beginSpan('router->bridge');
    try {
      const { items } = this.collectPassageDescriptors(this.state.routes, true);
      const uniqueMissing = Array.from(new Set(items.map((i) => i.formatted))).filter(
        (p) => p.length > 0 && !this.e5EmbeddingCache.has(p)
      );
      if (uniqueMissing.length === 0) {
        endBridge('ok');
        return;
      }

      const endEmbed = this.telemetry.beginSpan('bridge->embedding');
      try {
        const ext = await this.getE5Extractor();
        for (let i = 0; i < uniqueMissing.length; i += 24) {
          const batch = uniqueMissing.slice(i, i + 24);
          const out = await ext(batch, { pooling: 'mean', normalize: true });
          const vecs = out.tolist();
          batch.forEach((key, idx) => {
            this.e5EmbeddingCache.set(key, vecs[idx]);
          });
        }
        this.lastEmbedLatencyMs = endEmbed('ok');
      } catch (err) {
        endEmbed('error');
        throw err;
      }
      endBridge('ok');
    } catch (err) {
      endBridge('error');
      console.warn('E5 warmup failed:', (err as Error).message);
    }
  }

  async buildVectorLookup(
    queryTexts: string[],
    routes: RouteDefinition[],
    encoderModel: EncoderModelId,
    includeRagChunks = false
  ): Promise<{
    lookup: VectorLookup;
    encoderUsed: string;
  }> {
    const endBridge = this.telemetry.beginSpan('router->bridge');
    const embInstr = this.state.instructions.embedding;
    const { passageOverrideMap, items } = this.collectPassageDescriptors(
      routes,
      includeRagChunks
    );

    const onnxCapable =
      encoderModel === 'e5-small-v2' ||
      (MODEL_SPECS[encoderModel]?.supportsOnnx && this.hasLocalLfsModel(encoderModel));

    if (onnxCapable) {
      try {
        const spec = MODEL_SPECS[encoderModel];
        const useE5Prefix = encoderModel !== 'bge-m3';
        const formattedQueries = queryTexts.map((q) =>
          useE5Prefix ? formatEmbeddingText(q, 'query', embInstr) : q.trim()
        );
        const formattedPassages = items.map((i) => (useE5Prefix ? i.formatted : i.raw));
        const cachePrefix = `${encoderModel}::`;
        const missing = Array.from(
          new Set([...formattedQueries, ...formattedPassages])
        ).filter((k) => k.length > 0 && !this.e5EmbeddingCache.has(`${cachePrefix}${k}`));

        if (missing.length > 0) {
          const endEmbed = this.telemetry.beginSpan('bridge->embedding');
          try {
            const ext = await this.getOnnxExtractor(encoderModel);
            const pooling = spec.pooling === 'cls' ? 'cls' : 'mean';
            for (let i = 0; i < missing.length; i += 16) {
              const batch = missing.slice(i, i + 16);
              const out = await ext(batch, { pooling, normalize: true });
              const vecs = out.tolist();
              batch.forEach((key, idx) => {
                this.e5EmbeddingCache.set(`${cachePrefix}${key}`, vecs[idx]);
              });
            }
            this.lastEmbedLatencyMs = endEmbed('ok');
          } catch (err) {
            endEmbed('error');
            throw err;
          }
        }

        const localFallback = createLocalVectorLookup(spec.dimensions);
        const originTag = this.hasLocalLfsModel(encoderModel) ? 'Git LFS ONNX' : 'ONNX';
        endBridge('ok');
        return {
          encoderUsed: `${spec.hfRepo} (${originTag} ${spec.dimensions}d)`,
          lookup: {
            getVector: (text: string) => {
              const qKey = useE5Prefix ? formatEmbeddingText(text, 'query', embInstr) : text.trim();
              const pKey = useE5Prefix
                ? formatEmbeddingText(
                    text,
                    'passage',
                    embInstr,
                    passageOverrideMap.get(text)
                  )
                : text;
              return (
                this.e5EmbeddingCache.get(`${cachePrefix}${qKey}`) ??
                this.e5EmbeddingCache.get(`${cachePrefix}${pKey}`) ??
                localFallback.getVector(text)
              );
            },
            getQueryVector: (text: string) => {
              const qKey = useE5Prefix ? formatEmbeddingText(text, 'query', embInstr) : text.trim();
              return (
                this.e5EmbeddingCache.get(`${cachePrefix}${qKey}`) ?? localFallback.getVector(text)
              );
            },
            getPassageVector: (text: string) => {
              const pKey = useE5Prefix
                ? formatEmbeddingText(
                    text,
                    'passage',
                    embInstr,
                    passageOverrideMap.get(text)
                  )
                : text;
              return (
                this.e5EmbeddingCache.get(`${cachePrefix}${pKey}`) ?? localFallback.getVector(text)
              );
            },
          },
        };
      } catch (err) {
        console.warn(`${encoderModel} encoder fallback to local subword:`, (err as Error).message);
      }
    }

    const dims = this.ensembleManager.getDimensions(encoderModel);
    const baseLocal = createLocalVectorLookup(dims);
    const endLocalEmbed = this.telemetry.beginSpan('bridge->embedding');
    const wrappedLocal: VectorLookup = {
      getVector: (text: string) =>
        baseLocal.getVector(formatEmbeddingText(text, 'query', embInstr)),
      getQueryVector: (text: string) =>
        baseLocal.getVector(formatEmbeddingText(text, 'query', embInstr)),
      getPassageVector: (text: string) =>
        baseLocal.getVector(
          formatEmbeddingText(text, 'passage', embInstr, passageOverrideMap.get(text))
        ),
    };
    this.lastEmbedLatencyMs = endLocalEmbed('ok');
    endBridge('ok');
    return {
      lookup: wrappedLocal,
      encoderUsed:
        encoderModel === 'bge-m3'
          ? 'BAAI/bge-m3 (1024d Projection)'
          : encoderModel === 'e5-large-v2'
            ? 'intfloat/e5-large-v2 (1024d Projection)'
            : encoderModel === 'e5-base-v2'
              ? 'intfloat/e5-base-v2 (768d Projection)'
              : 'Local Subword + BM25 Hybrid',
    };
  }

  private async buildSlotVectorLookup(
    slot: EmbeddingSlotConfig,
    queryTexts: string[],
    routes: RouteDefinition[],
    includeRagChunks: boolean
  ): Promise<EnsembleSlotLookup> {
    const roleEdgeMap: Record<EmbeddingSlotRole, TelemetryEdgeId> = {
      intent: 'router->embedding_intent',
      domain: 'router->embedding_domain',
      state: 'router->embedding_state',
    };
    const edgeId = roleEdgeMap[slot.role];
    const endSlotSpan = this.telemetry.beginSpan(edgeId);

    try {
      const embInstr = this.state.instructions.embedding;
      const { passageOverrideMap, items } = this.collectPassageDescriptors(routes, includeRagChunks);
      const formattedQueries = queryTexts.map((q) => formatEmbeddingText(q, 'query', embInstr));
      const formattedPassages = items.map((i) => i.formatted);
      const uniqueTexts = Array.from(new Set([...formattedQueries, ...formattedPassages])).filter(
        Boolean
      );

      await this.ensembleManager.embedTexts(slot.modelId, uniqueTexts, slot.role);
      const dims = this.ensembleManager.getDimensions(slot.modelId);
      const fallback = createLocalVectorLookup(dims);

      const cacheKeyFor = (raw: string) =>
        slot.modelId === 'bge-m3' ? `Represent this sentence: ${raw}` : raw;

      const lookup: VectorLookup = {
        getVector: (text: string) => {
          const qText = formatEmbeddingText(text, 'query', embInstr);
          const pText = formatEmbeddingText(
            text,
            'passage',
            embInstr,
            passageOverrideMap.get(text)
          );
          return (
            this.ensembleManager.getCachedVector(slot.modelId, cacheKeyFor(qText)) ??
            this.ensembleManager.getCachedVector(slot.modelId, cacheKeyFor(pText)) ??
            fallback.getVector(qText)
          );
        },
        getQueryVector: (text: string) => {
          const qText = formatEmbeddingText(text, 'query', embInstr);
          return (
            this.ensembleManager.getCachedVector(slot.modelId, cacheKeyFor(qText)) ??
            fallback.getVector(qText)
          );
        },
        getPassageVector: (text: string) => {
          const pText = formatEmbeddingText(
            text,
            'passage',
            embInstr,
            passageOverrideMap.get(text)
          );
          return (
            this.ensembleManager.getCachedVector(slot.modelId, cacheKeyFor(pText)) ??
            fallback.getVector(pText)
          );
        },
      };

      const dur = endSlotSpan('ok');
      const fusionEdgeMap: Record<EmbeddingSlotRole, TelemetryEdgeId> = {
        intent: 'embedding_intent->ensemble',
        domain: 'embedding_domain->ensemble',
        state: 'embedding_state->ensemble',
      };
      this.telemetry.recordPulse(fusionEdgeMap[slot.role], dur, 'ok');

      return {
        role: slot.role,
        lookup,
        weight: slot.weight,
        enabled: slot.enabled,
      };
    } catch (err) {
      endSlotSpan('error');
      throw err;
    }
  }

  async embedTest(text: string, encoderModel?: EncoderModelId) {
    const clean = text.trim() || 'What time is it in Tokyo right now?';
    const model = migrateLegacyEncoder(encoderModel ?? this.state.config.encoderModel);
    const formattedQuery = formatEmbeddingText(
      clean,
      'query',
      this.state.instructions.embedding
    );
    const startNs = process.hrtime.bigint();
    const { lookup, encoderUsed } = await this.buildVectorLookup([clean], [], model, false);
    const vec = lookup.getQueryVector ? lookup.getQueryVector(clean) : lookup.getVector(clean);
    const elapsedMs = Math.round((Number(process.hrtime.bigint() - startNs) / 1_000_000) * 100) / 100;
    this.lastEmbedLatencyMs = elapsedMs;
    return {
      text: clean,
      formattedQuery,
      encoderModel: model,
      encoderUsed,
      dimensions: vec.length,
      preview: vec.slice(0, 8).map((v) => Math.round(v * 10000) / 10000),
      latencyMs: elapsedMs,
    };
  }

  async executeProviderFunction(
    providerId: string,
    args: Record<string, unknown>,
    query: string,
    opts?: {
      matchedRoute?: RouteDefinition | null;
      ragMatches?: RagRetrievalMatch[];
    }
  ): Promise<{ result: ProviderExecutionResult; systemPromptUsed: string | null }> {
    const startNs = process.hrtime.bigint();
    const isOpenAiLlm =
      providerId === 'openai:chatgpt-flagship' || providerId === 'openai:chatgpt-fast';

    const resolvedSystemPrompt = resolveChatGptSystemPrompt(this.state.instructions.chatgpt, {
      route: opts?.matchedRoute,
      ragMatches: opts?.ragMatches,
    });

    if (isOpenAiLlm) {
      const activeProfile = this.chatgptAuth.getActiveProfile();
      if (activeProfile && activeProfile.sharing) {
        const endChatGpt = this.telemetry.beginSpan('router->chatgpt');
        try {
          const pref = providerId === 'openai:chatgpt-fast' ? 'fast' : 'flagship';
          const result = await this.chatgptAuth.streamResponses({
            profileId: activeProfile.profileId,
            preference: pref,
            input: query,
            instructions: resolvedSystemPrompt,
            timeoutMs: 12_000,
          });
          const elapsedMs = endChatGpt('ok');
          this.lastOpenAiError = null;
          this.lastOpenAiLatencyMs = elapsedMs;
          return {
            systemPromptUsed: resolvedSystemPrompt,
            result: {
              providerId,
              providerKind: 'llm',
              handlerName:
                pref === 'fast'
                  ? 'executeChatGptFastProvider'
                  : 'executeChatGptFlagshipProvider',
              latencyMs: elapsedMs,
              status: 'ok',
              output: {
                model: result.model,
                account: activeProfile.email ?? activeProfile.subject,
                responseText: result.text,
                ragChunksInjected: opts?.ragMatches?.length ?? 0,
              },
            },
          };
        } catch (err) {
          endChatGpt('error');
          this.lastOpenAiError = (err as Error).message;
          console.warn(
            `OpenAI Responses execution error (${providerId}):`,
            (err as Error).message
          );
        }
      }
    }

    const localRes = executeLocalProviderFunction(providerId, args, query);
    if (providerId === 'tool:rea_agents_rag' && opts?.ragMatches && opts.ragMatches.length > 0) {
      const topMatches = opts.ragMatches.slice(0, 5);
      localRes.output = {
        ...(typeof localRes.output === 'object' && localRes.output !== null
          ? localRes.output
          : {}),
        groundedMatchCount: topMatches.length,
        citations: topMatches.map((m, idx) => ({
          rank: idx + 1,
          score: m.score,
          denseScore: m.denseScore,
          sparseScore: m.sparseScore,
          filePath: m.filePath ?? m.sourceUrl,
          category: m.category ?? 'rag',
          excerpt: m.text.slice(0, 320),
        })),
      };
    }
    const elapsedMs =
      Math.round((Number(process.hrtime.bigint() - startNs) / 1_000_000) * 100) / 100;
    return {
      systemPromptUsed: isOpenAiLlm ? resolvedSystemPrompt : null,
      result: {
        ...localRes,
        latencyMs: elapsedMs,
      },
    };
  }

  private async extractDynamicParameters(
    query: string,
    schema: FunctionSchema
  ): Promise<ExtractedFunctionCall> {
    const activeProfile = this.chatgptAuth.getActiveProfile();
    if (activeProfile && activeProfile.sharing) {
      const endChatGpt = this.telemetry.beginSpan('router->chatgpt');
      try {
        const paramSpec = schema.parameters
          .map(
            (p) => `${p.name} (${p.type}${p.required ? ', required' : ''}): ${p.description}`
          )
          .join('\n');
        const res = await this.chatgptAuth.streamResponses({
          profileId: activeProfile.profileId,
          preference: 'fast',
          instructions: this.state.instructions.chatgpt.extractionSystemPrompt,
          input: `Function: ${schema.name}\nDescription: ${schema.description}\nParameters:\n${paramSpec}\n\nUser prompt: ${query}`,
          timeoutMs: 5000,
        });
        endChatGpt('ok');
        const cleanJson = res.text.replace(/^```json\s*|\s*```$/g, '').trim();
        const parsed = JSON.parse(cleanJson) as Record<
          string,
          string | number | boolean | null
        >;
        return {
          name: schema.name,
          arguments: parsed,
          extractionMethod: 'openai-chatgpt-plan',
        };
      } catch (err) {
        endChatGpt('error');
        console.warn('OpenAI parameter extraction fallback:', (err as Error).message);
      }
    }
    return extractDynamicParametersLocal(query, schema);
  }

  async ingestPackageArchive(opts?: {
    archivePath?: string;
    chunkSize?: number;
    chunkOverlap?: number;
    encoderModel?: EncoderModelId;
    filterProfile?: ArchiveFilterProfile;
    batchSize?: number;
    maxChars?: number;
    allowRemoteModelDownload?: boolean;
    onProgress?: (processedChunks: number, totalChunks: number) => void;
  }): Promise<{
    manifest: IngestedPackageManifest;
    connector: RagConnector;
  }> {
    const startNs = process.hrtime.bigint();
    const endRag = this.telemetry.beginSpan('router->rag_connector');
    const archivePath =
      opts?.archivePath?.trim() || 'public/assets/aistudio/rea-rea-agents-6.8.0_a6250980.zip';
    const filterProfile: ArchiveFilterProfile = opts?.filterProfile ?? 'full-scripts';

    try {
      const extracted = extractAndChunkZipArchive({
        archivePath,
        rootDir: this.rootDir,
        chunkSize: opts?.chunkSize ?? 1800,
        chunkOverlap: opts?.chunkOverlap ?? 120,
        filterProfile,
      });

      const targetEncoder: EncoderModelId = migrateLegacyEncoder(
        opts?.encoderModel ?? 'e5-small-v2'
      );
      const spec = MODEL_SPECS[targetEncoder] ?? MODEL_SPECS['e5-small-v2'];
      const dims = spec.dimensions;
      const vectors = new Float32Array(extracted.chunks.length * dims);
      const lfsAvailable = this.hasLocalLfsModel(targetEncoder);
      let encoderLabel = `${spec.hfRepo} (${lfsAvailable ? 'Git LFS ONNX' : spec.supportsOnnx ? 'ONNX' : 'Local'} ${dims}d)`;

      if (spec.supportsOnnx) {
        try {
          const endBridge = this.telemetry.beginSpan('router->bridge');
          const endEmbed = this.telemetry.beginSpan('bridge->embedding');
          const ext = await this.getOnnxExtractor(targetEncoder, {
            allowRemote: opts?.allowRemoteModelDownload ?? true,
          });
          const embInstr = this.state.instructions.embedding;
          const batchSize = Math.max(1, Math.min(32, opts?.batchSize ?? 4));
          const maxCharsCap = opts?.maxChars ?? (targetEncoder === 'bge-m3' ? 2400 : 1100);
          const pooling = spec.pooling === 'cls' ? 'cls' : 'mean';

          for (let i = 0; i < extracted.chunks.length; i += batchSize) {
            const batchChunks = extracted.chunks.slice(i, i + batchSize);
            const batchTexts = batchChunks.map((ch) =>
              targetEncoder === 'bge-m3'
                ? ch.text.slice(0, maxCharsCap)
                : formatEmbeddingText(ch.text, 'passage', {
                    ...embInstr,
                    maxChars: maxCharsCap,
                  })
            );
            const out = await ext(batchTexts, { pooling, normalize: true });
            const vecs = out.tolist();
            for (let j = 0; j < vecs.length; j++) {
              const row = vecs[j];
              const base = (i + j) * dims;
              for (let d = 0; d < dims; d++) {
                vectors[base + d] = row[d] ?? 0;
              }
              normalizeVectorInPlace(vectors, base, dims);
            }
            opts?.onProgress?.(
              Math.min(extracted.chunks.length, i + batchChunks.length),
              extracted.chunks.length
            );
            if ((i / batchSize) % 25 === 0) {
              await new Promise((resolve) => setTimeout(resolve, 0));
            }
          }
          this.lastEmbedLatencyMs = endEmbed('ok');
          endBridge('ok');
        } catch (err) {
          console.warn(
            `Package ingestion ${targetEncoder} ONNX failed, falling back to deterministic ${dims}d vector:`,
            (err as Error).message
          );
          encoderLabel = `${targetEncoder} (local-${dims}d-fallback)`;
          for (let i = 0; i < extracted.chunks.length; i++) {
            const vec = computeLocalDenseVector(extracted.chunks[i].text, dims);
            const base = i * dims;
            for (let d = 0; d < dims; d++) vectors[base + d] = vec[d] ?? 0;
          }
        }
      } else {
        for (let i = 0; i < extracted.chunks.length; i++) {
          const vec = computeLocalDenseVector(extracted.chunks[i].text, dims);
          const base = i * dims;
          for (let d = 0; d < dims; d++) vectors[base + d] = vec[d] ?? 0;
        }
      }

      const latencyMs =
        Math.round((Number(process.hrtime.bigint() - startNs) / 1_000_000) * 100) / 100;

      const manifest = savePackageVectorStore({
        packagesDir: this.packagesDir,
        manifest: {
          id: extracted.packageId,
          packageName: extracted.packageName,
          version: extracted.version,
          sourceArchive: extracted.sourceArchive,
          connectorId: extracted.connectorId,
          connectorName: extracted.connectorName,
          encoderModel: encoderLabel,
          filterProfile,
          dimensions: dims,
          chunkCount: extracted.chunks.length,
          fileCount: extracted.fileCount,
          totalChars: extracted.totalChars,
          categories: extracted.categories,
          ingestedAt: new Date().toISOString(),
          latencyMs,
        },
        chunks: extracted.chunks,
        vectors,
      });

      this.syncLoadedPackageStoresIntoConnectors(false);
      this.saveState();
      this.lastRagLatencyMs = latencyMs;
      this.lastRagError = null;
      endRag('ok');
      this.telemetry.notify();

      const connector = this.state.ragConnectors.find((c) => c.id === manifest.connectorId)!;
      return { manifest, connector };
    } catch (err) {
      this.lastRagError = (err as Error).message;
      endRag('error');
      throw err;
    }
  }

  private async resolvePackageQueryVector(
    query: string,
    store: LoadedPackageStore,
    config: RouterConfig,
    existingLookup?: VectorLookup
  ): Promise<number[] | null> {
    if (config.mode === 'sparse') return null;

    const targetDims = store.manifest.dimensions;
    const storeEncLabel = store.manifest.encoderModel.toLowerCase();

    if (existingLookup) {
      const candidate = existingLookup.getQueryVector
        ? existingLookup.getQueryVector(query)
        : existingLookup.getVector(query);
      if (candidate.length === targetDims) {
        return candidate;
      }
    }

    if (targetDims === 384) {
      const { lookup } = await this.buildVectorLookup([query], [], 'e5-small-v2', false);
      return lookup.getQueryVector ? lookup.getQueryVector(query) : lookup.getVector(query);
    }

    if (targetDims === 768 && this.hasLocalLfsModel('e5-base-v2')) {
      const { lookup } = await this.buildVectorLookup([query], [], 'e5-base-v2', false);
      return lookup.getQueryVector ? lookup.getQueryVector(query) : lookup.getVector(query);
    }

    if (targetDims === 1024) {
      const preferredModel: EncoderModelId = storeEncLabel.includes('e5-large')
        ? 'e5-large-v2'
        : 'bge-m3';
      if (this.hasLocalLfsModel(preferredModel)) {
        const { lookup } = await this.buildVectorLookup([query], [], preferredModel, false);
        return lookup.getQueryVector ? lookup.getQueryVector(query) : lookup.getVector(query);
      }
    }

    const fallback = createLocalVectorLookup(targetDims);
    return fallback.getVector(query);
  }

  private async scoreAllAllowedRagSources(opts: {
    query: string;
    allowedConnectorIds: Set<string>;
    config: RouterConfig;
    lookup: VectorLookup;
    topK: number;
    e5QueryLookup?: VectorLookup;
  }): Promise<RagRetrievalMatch[]> {
    const candidateChunks = this.state.ragChunks.filter((ch) =>
      opts.allowedConnectorIds.has(ch.connectorId)
    );
    const webhookMatches =
      candidateChunks.length > 0
        ? scoreRagChunks(opts.query, candidateChunks, opts.config, opts.lookup, {
            topK: opts.topK,
          })
        : [];

    const activePkgStores = this.packageStores.filter((s) =>
      opts.allowedConnectorIds.has(s.manifest.connectorId)
    );

    const packageMatches: RagRetrievalMatch[] = [];
    for (const store of activePkgStores) {
      const preferredLookup =
        store.manifest.dimensions === 384 && opts.e5QueryLookup
          ? opts.e5QueryLookup
          : opts.lookup;
      const qVec = await this.resolvePackageQueryVector(
        opts.query,
        store,
        opts.config,
        preferredLookup
      );
      const hits = scorePackageVectorStore(opts.query, store, opts.config, qVec, {
        topK: opts.topK,
      });
      packageMatches.push(...hits);
    }

    return [...webhookMatches, ...packageMatches]
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.topK);
  }

  async syncRagConnector(connectorId: string): Promise<{
    connector: RagConnector;
    chunkCount: number;
    latencyMs: number;
  }> {
    const idx = this.state.ragConnectors.findIndex((c) => c.id === connectorId);
    if (idx === -1) {
      throw new Error('RAG connector not found.');
    }

    const connector = this.state.ragConnectors[idx];
    if (connector.url.startsWith('package://')) {
      const archiveRel = connector.url.slice('package://'.length);
      const res = await this.ingestPackageArchive({ archivePath: archiveRel });
      return {
        connector: res.connector,
        chunkCount: res.manifest.chunkCount,
        latencyMs: res.manifest.latencyMs,
      };
    }

    const endRag = this.telemetry.beginSpan('router->rag_connector');

    try {
      const { chunks, latencyMs } = await fetchAndChunkConnector(connector);
      this.state.ragChunks = [
        ...this.state.ragChunks.filter((c) => c.connectorId !== connector.id),
        ...chunks,
      ];
      const updated: RagConnector = {
        ...connector,
        lastSyncedAt: new Date().toISOString(),
        lastStatus: 'ok',
        lastLatencyMs: latencyMs,
        lastError: null,
        chunkCount: chunks.length,
      };
      this.state.ragConnectors[idx] = updated;
      this.lastRagLatencyMs = latencyMs;
      this.lastRagError = null;
      this.saveState();
      endRag('ok');

      // Warm embeddings for new chunks asynchronously
      void this.warmUpEmbeddings();

      return { connector: updated, chunkCount: chunks.length, latencyMs };
    } catch (err) {
      const errMsg = (err as Error).message || 'Failed to fetch connector';
      const updated: RagConnector = {
        ...connector,
        lastSyncedAt: new Date().toISOString(),
        lastStatus: 'error',
        lastError: errMsg,
      };
      this.state.ragConnectors[idx] = updated;
      this.lastRagError = errMsg;
      this.saveState();
      endRag('error');
      throw err;
    }
  }

  async queryRag(opts: {
    query: string;
    connectorIds?: string[];
    routeId?: string | null;
    topK?: number;
  }): Promise<RagQueryResult> {
    this.reloadStateIfModified();
    const startNs = process.hrtime.bigint();
    const query = opts.query.trim();
    if (!query) {
      throw new Error('RAG query is required.');
    }

    const enabledConnectors = this.state.ragConnectors.filter((c) => {
      if (!c.enabled) return false;
      if (opts.connectorIds && opts.connectorIds.length > 0) {
        return opts.connectorIds.includes(c.id);
      }
      if (opts.routeId && c.boundRouteIds.length > 0) {
        return c.boundRouteIds.includes(opts.routeId);
      }
      return true;
    });

    const allowedIds = new Set(enabledConnectors.map((c) => c.id));
    const hasWebhookChunks = this.state.ragChunks.some((ch) => allowedIds.has(ch.connectorId));

    const { lookup, encoderUsed } =
      this.state.config.mode === 'sparse'
        ? { lookup: createLocalVectorLookup(), encoderUsed: 'Sparse BM25 / Lexical' }
        : await this.buildVectorLookup(
            [query],
            [],
            this.state.config.encoderModel,
            hasWebhookChunks
          );

    const endRag = this.telemetry.beginSpan('router->rag_connector');
    const matches = await this.scoreAllAllowedRagSources({
      query,
      allowedConnectorIds: allowedIds,
      config: this.state.config,
      lookup,
      topK: opts.topK ?? 3,
      e5QueryLookup: this.state.config.encoderModel === 'e5-small-v2' ? lookup : undefined,
    });
    const latencyMs =
      Math.round((Number(process.hrtime.bigint() - startNs) / 1_000_000) * 100) / 100;
    this.lastRagLatencyMs = latencyMs;
    endRag('ok');

    return {
      query,
      matches,
      latencyMs,
      encoderUsed,
      connectorCount: enabledConnectors.length,
    };
  }

  async routePrompt(opts: {
    query: string;
    mode?: RouterConfig['mode'];
    alpha?: number;
    aggregation?: RouterConfig['aggregation'];
    encoderModel?: EncoderModelId;
    executeProvider?: boolean;
    useRag?: boolean;
    transport?: 'http' | 'mcp';
  }): Promise<RouteDecisionResult> {
    this.reloadStateIfModified();
    const query = opts.query.trim();
    if (!query) {
      throw new Error('Prompt query is required.');
    }

    const edgeTransport = opts.transport === 'mcp' ? 'mcp->router' : 'express->router';
    const endTransport = this.telemetry.beginSpan(edgeTransport);
    const startNs = process.hrtime.bigint();

    try {
      const activeConfig: RouterConfig = {
        ...this.state.config,
        ...(opts.mode ? { mode: opts.mode } : {}),
        ...(typeof opts.alpha === 'number' ? { alpha: opts.alpha } : {}),
        ...(opts.aggregation ? { aggregation: opts.aggregation } : {}),
        ...(opts.encoderModel ? { encoderModel: migrateLegacyEncoder(opts.encoderModel) } : {}),
      };

      const useRag =
        opts.useRag !== undefined ? opts.useRag : activeConfig.ragEnabledByDefault;

      const ensembleCfg = this.getEffectiveEnsembleConfig();
      const enabledEnsembleSlots = ensembleCfg.slots.filter((s) => s.enabled);
      const useEnsemble = activeConfig.mode !== 'sparse' && enabledEnsembleSlots.length > 0 && !opts.encoderModel;

      let lookup: VectorLookup;
      let encoderUsed: string;
      let scored: {
        matchedRoute: RouteDefinition | null;
        topScore: number;
        allScores: RouteScoreBreakdown[];
        perEncoderBreakdown?: Partial<Record<EmbeddingSlotRole, RouteScoreBreakdown[]>>;
      };

      let e5QueryLookup: VectorLookup | undefined;
      if (useEnsemble) {
        const endEnsemble = this.telemetry.beginSpan('ensemble->router');
        const slotLookups = await Promise.all(
          enabledEnsembleSlots.map((slot) =>
            this.buildSlotVectorLookup(slot, [query], this.state.routes, useRag)
          )
        );
        const runner = new EmbeddingEnsembleRunner({
          slots: slotLookups.map((sl) => ({
            ...sl,
            modelId: enabledEnsembleSlots.find((c) => c.role === sl.role)?.modelId ?? 'e5-small-v2',
          })),
          fusionMode: ensembleCfg.fusionMode,
        });
        scored = scoreRoutesEnsemble(query, this.state.routes, activeConfig, runner.toVectorLookup());
        endEnsemble('ok');
        // Primary lookup for RAG chunk scoring (prefer domain -> intent -> first enabled)
        lookup =
          slotLookups.find((s) => s.role === 'domain')?.lookup ??
          slotLookups[0].lookup;
        const e5SlotIdx = enabledEnsembleSlots.findIndex((s) => s.modelId === 'e5-small-v2');
        if (e5SlotIdx !== -1) {
          e5QueryLookup = slotLookups[e5SlotIdx]?.lookup;
        }
        encoderUsed = `3-Slot Ensemble (${ensembleCfg.fusionMode}: ${enabledEnsembleSlots
          .map((s) => `${s.role}=${s.modelId}`)
          .join(', ')})`;
      } else {
        const single =
          activeConfig.mode === 'sparse'
            ? { lookup: createLocalVectorLookup(), encoderUsed: 'Sparse BM25 / Lexical' }
            : await this.buildVectorLookup(
                [query],
                this.state.routes,
                activeConfig.encoderModel,
                useRag
              );
        lookup = single.lookup;
        encoderUsed = single.encoderUsed;
        if (activeConfig.encoderModel === 'e5-small-v2' && activeConfig.mode !== 'sparse') {
          e5QueryLookup = lookup;
        }
        scored = scoreRoutes(query, this.state.routes, activeConfig, lookup);
      }

      let ragMatches: RagRetrievalMatch[] = [];
      if (useRag && (this.state.ragChunks.length > 0 || this.packageStores.length > 0)) {
        const matchedRouteId = scored.matchedRoute?.id ?? null;
        const allowedConnectors = new Set(
          this.state.ragConnectors
            .filter(
              (c) =>
                c.enabled &&
                (c.boundRouteIds.length === 0 ||
                  (matchedRouteId ? c.boundRouteIds.includes(matchedRouteId) : false))
            )
            .map((c) => c.id)
        );
        if (allowedConnectors.size > 0) {
          const endRagLookup = this.telemetry.beginSpan('router->rag_connector');
          ragMatches = await this.scoreAllAllowedRagSources({
            query,
            allowedConnectorIds: allowedConnectors,
            config: activeConfig,
            lookup,
            topK: scored.matchedRoute?.targetModel === 'tool:rea_agents_rag' ? 5 : 3,
            e5QueryLookup,
          });
          this.lastRagLatencyMs = endRagLookup('ok');
        }
      }

      let functionCall: ExtractedFunctionCall | null = null;
      if (
        scored.matchedRoute &&
        scored.matchedRoute.routeType === 'dynamic' &&
        scored.matchedRoute.functionSchema
      ) {
        functionCall = await this.extractDynamicParameters(
          query,
          scored.matchedRoute.functionSchema
        );
      }

      let providerExecution: ProviderExecutionResult | null = null;
      let systemPromptUsed: string | null = null;
      if (opts.executeProvider !== false) {
        const targetProvider = scored.matchedRoute?.targetModel ?? 'fallback-none';
        const args = functionCall?.arguments ?? {};
        const execOut = await this.executeProviderFunction(targetProvider, args, query, {
          matchedRoute: scored.matchedRoute,
          ragMatches,
        });
        providerExecution = execOut.result;
        systemPromptUsed = execOut.systemPromptUsed;
      }

      // Update EM-3 Project Progress Tracker after turn execution
      const progressText =
        typeof providerExecution?.output === 'string'
          ? `${query} ${providerExecution.output}`
          : providerExecution?.output && typeof providerExecution.output === 'object'
            ? `${query} ${JSON.stringify(providerExecution.output)}`
            : query;
      let progressAutoAdvanceRoute: string | null = null;
      try {
        const progRes = await this.evaluateProgressOutput(progressText);
        progressAutoAdvanceRoute = progRes.autoAdvanceRoute;
      } catch {
        // Non-blocking if milestone evaluation fails
      }

      const elapsedMs =
        Math.round((Number(process.hrtime.bigint() - startNs) / 1_000_000) * 100) / 100;
      this.lastRouteLatencyMs = elapsedMs;
      this.lastRouterError = null;
      endTransport('ok');

      return {
        query,
        matchedRoute: scored.matchedRoute ? scored.matchedRoute.name : null,
        matchedRouteId: scored.matchedRoute ? scored.matchedRoute.id : null,
        matchedRouteType: scored.matchedRoute ? scored.matchedRoute.routeType : null,
        targetModel: scored.matchedRoute ? scored.matchedRoute.targetModel : null,
        topScore: scored.topScore,
        thresholdUsed: scored.matchedRoute
          ? scored.matchedRoute.scoreThreshold
          : scored.allScores[0]?.threshold ?? null,
        latencyMs: elapsedMs,
        encoderUsed,
        mode: activeConfig.mode,
        alpha: activeConfig.alpha,
        aggregation: activeConfig.aggregation,
        functionCall,
        providerExecution,
        ragMatches,
        appliedInstructions: {
          embeddingQueryPreview: formatEmbeddingText(
            query,
            'query',
            this.state.instructions.embedding,
            scored.matchedRoute?.instructionOverrides
          ),
          chatgptSystemPrompt: systemPromptUsed,
        },
        allScores: scored.allScores,
        perEncoderBreakdown: scored.perEncoderBreakdown,
        ensembleFusionMode: useEnsemble ? ensembleCfg.fusionMode : undefined,
        progressAutoAdvanceRoute,
      };
    } catch (err) {
      this.lastRouterError = (err as Error).message;
      endTransport('error');
      throw err;
    }
  }

  async evaluate(): Promise<EvalReport> {
    this.reloadStateIfModified();
    this.isEvaluatingOrFitting = true;
    this.telemetry.notify();
    const endRouter = this.telemetry.beginSpan('express->router');
    try {
      const queryTexts = this.state.evalCases.map((c) => c.query);
      const { lookup, encoderUsed } =
        this.state.config.mode === 'sparse'
          ? { lookup: createLocalVectorLookup(), encoderUsed: 'Sparse BM25 / Lexical' }
          : await this.buildVectorLookup(
              queryTexts,
              this.state.routes,
              this.state.config.encoderModel,
              false
            );

      const report = evaluateDataset(
        this.state.evalCases,
        this.state.routes,
        this.state.config,
        lookup,
        encoderUsed
      );
      endRouter('ok');
      return report;
    } catch (err) {
      endRouter('error');
      throw err;
    } finally {
      this.isEvaluatingOrFitting = false;
      this.telemetry.notify();
    }
  }

  async fit(): Promise<FitReport> {
    this.reloadStateIfModified();
    this.isEvaluatingOrFitting = true;
    this.telemetry.notify();
    const endRouter = this.telemetry.beginSpan('express->router');
    try {
      const queryTexts = this.state.evalCases.map((c) => c.query);
      const { lookup } =
        this.state.config.mode === 'sparse'
          ? { lookup: createLocalVectorLookup() }
          : await this.buildVectorLookup(
              queryTexts,
              this.state.routes,
              this.state.config.encoderModel,
              false
            );

      const fitReport = optimizeRouteThresholds(
        this.state.evalCases,
        this.state.routes,
        this.state.config,
        lookup
      );
      this.state.routes = fitReport.updatedRoutes;
      this.saveState();
      endRouter('ok');
      return fitReport;
    } catch (err) {
      endRouter('error');
      throw err;
    } finally {
      this.isEvaluatingOrFitting = false;
      this.telemetry.notify();
    }
  }

  createRoute(body: Partial<RouteDefinition>): RouteDefinition {
    const name = (body.name ?? '').trim();
    const utterances = Array.isArray(body.utterances)
      ? body.utterances.map((u) => String(u).trim()).filter(Boolean)
      : [];

    if (!name) throw new Error('Route name is required.');
    if (utterances.length === 0) throw new Error('At least one example utterance is required.');
    if (this.state.routes.some((r) => r.name.toLowerCase() === name.toLowerCase())) {
      const err = new Error(`Route "${name}" already exists.`) as Error & { status?: number };
      err.status = 409;
      throw err;
    }

    const overrides =
      body.instructionOverrides &&
      (body.instructionOverrides.embeddingContextPrefix?.trim() ||
        body.instructionOverrides.chatgptSystemInstruction?.trim())
        ? {
            embeddingContextPrefix:
              body.instructionOverrides.embeddingContextPrefix?.trim() || undefined,
            chatgptSystemInstruction:
              body.instructionOverrides.chatgptSystemInstruction?.trim() || undefined,
          }
        : undefined;

    const newRoute: RouteDefinition = {
      id: `route-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name,
      description: (body.description ?? '').trim() || `Semantic route for ${name}`,
      utterances,
      scoreThreshold:
        typeof body.scoreThreshold === 'number'
          ? Math.max(0.05, Math.min(0.99, body.scoreThreshold))
          : this.state.config.defaultThreshold,
      routeType: body.routeType === 'dynamic' ? 'dynamic' : 'static',
      targetModel: (body.targetModel ?? '').trim() || 'openai:chatgpt-flagship',
      enabled: body.enabled !== false,
      functionSchema:
        body.routeType === 'dynamic' && body.functionSchema
          ? body.functionSchema
          : undefined,
      instructionOverrides: overrides,
      createdAt: new Date().toISOString(),
    };

    this.state.routes = [newRoute, ...this.state.routes];
    this.saveState();
    void this.warmUpEmbeddings();
    return newRoute;
  }

  updateRoute(id: string, body: Partial<RouteDefinition>): RouteDefinition {
    const idx = this.state.routes.findIndex((r) => r.id === id);
    if (idx === -1) {
      const err = new Error('Route not found.') as Error & { status?: number };
      err.status = 404;
      throw err;
    }
    const existing = this.state.routes[idx];
    const updatedName = body.name !== undefined ? body.name.trim() : existing.name;
    if (!updatedName) throw new Error('Route name cannot be empty.');

    const updatedUtterances =
      body.utterances !== undefined
        ? body.utterances.map((u) => String(u).trim()).filter(Boolean)
        : existing.utterances;
    if (updatedUtterances.length === 0) {
      throw new Error('At least one utterance is required.');
    }

    let instructionOverrides = existing.instructionOverrides;
    if (body.instructionOverrides !== undefined) {
      const embPrefix = body.instructionOverrides?.embeddingContextPrefix?.trim();
      const gptPrompt = body.instructionOverrides?.chatgptSystemInstruction?.trim();
      instructionOverrides =
        embPrefix || gptPrompt
          ? {
              embeddingContextPrefix: embPrefix || undefined,
              chatgptSystemInstruction: gptPrompt || undefined,
            }
          : undefined;
    }

    const updated: RouteDefinition = {
      ...existing,
      name: updatedName,
      description:
        body.description !== undefined ? body.description.trim() : existing.description,
      utterances: updatedUtterances,
      scoreThreshold:
        typeof body.scoreThreshold === 'number'
          ? Math.max(0.05, Math.min(0.99, body.scoreThreshold))
          : existing.scoreThreshold,
      routeType: body.routeType ?? existing.routeType,
      targetModel:
        body.targetModel !== undefined ? body.targetModel.trim() : existing.targetModel,
      enabled: body.enabled !== undefined ? body.enabled : existing.enabled,
      functionSchema:
        (body.routeType ?? existing.routeType) === 'dynamic'
          ? body.functionSchema ?? existing.functionSchema
          : undefined,
      instructionOverrides,
    };

    this.state.routes[idx] = updated;
    this.saveState();
    void this.warmUpEmbeddings();
    return updated;
  }

  deleteRoute(id: string): boolean {
    const before = this.state.routes.length;
    this.state.routes = this.state.routes.filter((r) => r.id !== id);
    if (this.state.routes.length === before) return false;
    this.saveState();
    return true;
  }

  updateConfig(body: Partial<RouterConfig> & { calibrateThresholds?: boolean }) {
    const prevEncoder = this.state.config.encoderModel;
    const nextEncoder = migrateLegacyEncoder(
      body.encoderModel ?? this.state.config.encoderModel
    );
    const providerMeta = ENCODER_PROVIDERS.find((p) => p.id === nextEncoder);
    const nextEnsemble = body.encoderEnsemble
      ? normalizeEnsembleConfig(body.encoderEnsemble)
      : this.getEffectiveEnsembleConfig();

    this.state.config = {
      mode: body.mode ?? this.state.config.mode,
      alpha:
        typeof body.alpha === 'number'
          ? Math.max(0, Math.min(1, body.alpha))
          : this.state.config.alpha,
      aggregation: body.aggregation ?? this.state.config.aggregation,
      defaultThreshold:
        typeof body.defaultThreshold === 'number'
          ? Math.max(0.05, Math.min(0.99, body.defaultThreshold))
          : body.calibrateThresholds && providerMeta
            ? providerMeta.recommendedThreshold
            : this.state.config.defaultThreshold,
      encoderModel: nextEncoder,
      encoderEnsemble: nextEnsemble,
      mcpEnabled:
        typeof body.mcpEnabled === 'boolean'
          ? body.mcpEnabled
          : this.state.config.mcpEnabled,
      ragEnabledByDefault:
        typeof body.ragEnabledByDefault === 'boolean'
          ? body.ragEnabledByDefault
          : this.state.config.ragEnabledByDefault,
    };

    if (body.calibrateThresholds && prevEncoder !== nextEncoder && providerMeta) {
      this.state.routes = this.state.routes.map((r) => ({
        ...r,
        scoreThreshold: providerMeta.recommendedThreshold,
      }));
    }

    if (body.encoderEnsemble) {
      void this.ensembleManager.loadAll(nextEnsemble.slots, nextEnsemble.parallelLoad);
    }

    this.saveState();
    this.telemetry.notify();
    return {
      config: this.state.config,
      routes: this.state.routes,
      slotStatuses: this.ensembleManager.getSlotStatuses(nextEnsemble),
    };
  }

  updateInstructions(patch: {
    embedding?: Partial<SystemInstructionsConfig['embedding']>;
    chatgpt?: Partial<SystemInstructionsConfig['chatgpt']>;
  }): SystemInstructionsConfig {
    const prevEmb = JSON.stringify(this.state.instructions.embedding);
    this.state.instructions = {
      embedding: {
        ...this.state.instructions.embedding,
        ...(patch.embedding ?? {}),
        maxChars:
          typeof patch.embedding?.maxChars === 'number'
            ? Math.max(64, Math.min(4096, patch.embedding.maxChars))
            : this.state.instructions.embedding.maxChars,
      },
      chatgpt: {
        ...this.state.instructions.chatgpt,
        ...(patch.chatgpt ?? {}),
      },
    };
    this.saveState();

    if (JSON.stringify(this.state.instructions.embedding) !== prevEmb) {
      this.e5EmbeddingCache.clear();
      void this.warmUpEmbeddings();
    }
    this.telemetry.notify();
    return this.state.instructions;
  }

  createRagConnector(body: Partial<RagConnector>): RagConnector {
    const name = (body.name ?? '').trim();
    const url = (body.url ?? '').trim();
    if (!name) throw new Error('Connector name is required.');
    if (!url) throw new Error('Connector URL is required.');
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Connector URL must begin with http:// or https://');
    }

    const connector: RagConnector = {
      id: `rag-conn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name,
      url: parsed.toString(),
      method: body.method === 'POST' ? 'POST' : 'GET',
      headers: body.headers ?? {},
      requestBody: body.requestBody,
      parserMode: body.parserMode ?? 'auto',
      jsonPath: body.jsonPath?.trim() || undefined,
      boundRouteIds: Array.isArray(body.boundRouteIds) ? body.boundRouteIds : [],
      chunkSize:
        typeof body.chunkSize === 'number'
          ? Math.max(100, Math.min(1800, body.chunkSize))
          : 380,
      chunkOverlap:
        typeof body.chunkOverlap === 'number'
          ? Math.max(0, Math.min(400, body.chunkOverlap))
          : 40,
      enabled: body.enabled !== false,
      lastSyncedAt: null,
      lastStatus: 'idle',
      lastLatencyMs: null,
      lastError: null,
      chunkCount: 0,
    };

    this.state.ragConnectors = [connector, ...this.state.ragConnectors];
    this.saveState();
    this.telemetry.notify();
    return connector;
  }

  updateRagConnector(id: string, body: Partial<RagConnector>): RagConnector {
    const idx = this.state.ragConnectors.findIndex((c) => c.id === id);
    if (idx === -1) {
      const err = new Error('RAG connector not found.') as Error & { status?: number };
      err.status = 404;
      throw err;
    }
    const existing = this.state.ragConnectors[idx];
    const isPackageConn = existing.url.startsWith('package://');
    const nextUrl = body.url !== undefined ? body.url.trim() : existing.url;
    let resolvedUrl = existing.url;
    if (!isPackageConn) {
      const parsed = new URL(nextUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Connector URL must begin with http:// or https://');
      }
      resolvedUrl = parsed.toString();
    }

    const updated: RagConnector = {
      ...existing,
      name: body.name !== undefined ? body.name.trim() || existing.name : existing.name,
      url: resolvedUrl,
      method: body.method ?? existing.method,
      headers: body.headers ?? existing.headers,
      requestBody: body.requestBody !== undefined ? body.requestBody : existing.requestBody,
      parserMode: body.parserMode ?? existing.parserMode,
      jsonPath: body.jsonPath !== undefined ? body.jsonPath.trim() || undefined : existing.jsonPath,
      boundRouteIds: body.boundRouteIds ?? existing.boundRouteIds,
      chunkSize: body.chunkSize ?? existing.chunkSize,
      chunkOverlap: body.chunkOverlap ?? existing.chunkOverlap,
      enabled: body.enabled !== undefined ? body.enabled : existing.enabled,
    };

    this.state.ragConnectors[idx] = updated;
    this.saveState();
    this.telemetry.notify();
    return updated;
  }

  deleteRagConnector(id: string): boolean {
    const before = this.state.ragConnectors.length;
    this.state.ragConnectors = this.state.ragConnectors.filter((c) => c.id !== id);
    if (this.state.ragConnectors.length === before) return false;
    this.state.ragChunks = this.state.ragChunks.filter((ch) => ch.connectorId !== id);
    if (deletePackageVectorStoreByConnector(this.packagesDir, id)) {
      this.syncLoadedPackageStoresIntoConnectors(false);
    }
    this.saveState();
    this.telemetry.notify();
    return true;
  }

  addEvalCase(query: string, expectedRoute: string | null): EvalCase {
    const clean = query.trim();
    if (!clean) throw new Error('Evaluation query is required.');
    const newCase: EvalCase = {
      id: `eval-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      query: clean,
      expectedRoute: expectedRoute ? expectedRoute.trim() : null,
    };
    this.state.evalCases = [newCase, ...this.state.evalCases];
    this.saveState();
    return newCase;
  }

  deleteEvalCase(id: string): boolean {
    const before = this.state.evalCases.length;
    this.state.evalCases = this.state.evalCases.filter((c) => c.id !== id);
    if (this.state.evalCases.length === before) return false;
    this.saveState();
    return true;
  }

  async getTrinityHealth(trinityUrl?: string | null) {
    const endRag = this.telemetry.beginSpan('router->rag_connector');
    try {
      const result = await checkTrinityHealth(trinityUrl);
      this.lastRagLatencyMs = result.latencyMs;
      this.lastRagError = null;
      endRag('ok');
      return result;
    } catch (err) {
      this.lastRagError = (err as Error).message;
      endRag('error');
      throw err;
    }
  }

  async trinityQuery(opts: {
    queryText: string;
    k?: number;
    tierFilter?: string | null;
    minKappa?: number;
    trinityUrl?: string | null;
  }) {
    const endRag = this.telemetry.beginSpan('router->rag_connector');
    try {
      const result = await queryTrinityRag(opts);
      this.lastRagLatencyMs = result.latencyMs;
      this.lastRagError = null;
      endRag('ok');
      return result;
    } catch (err) {
      this.lastRagError = (err as Error).message;
      endRag('error');
      throw err;
    }
  }

  async trinityContext(opts: {
    queryText: string;
    k?: number;
    trinityUrl?: string | null;
  }) {
    const endRag = this.telemetry.beginSpan('router->rag_connector');
    try {
      const result = await fetchTrinityContext(opts);
      this.lastRagLatencyMs = result.latencyMs;
      this.lastRagError = null;
      endRag('ok');
      return result;
    } catch (err) {
      this.lastRagError = (err as Error).message;
      endRag('error');
      throw err;
    }
  }

  async trinityIngest(opts: {
    content: string;
    source?: string;
    sessionId?: string;
    kappa?: number;
    metadata?: Record<string, unknown>;
    trinityUrl?: string | null;
  }) {
    const endRag = this.telemetry.beginSpan('router->rag_connector');
    try {
      const result = await ingestTrinityChunk(opts);
      this.lastRagLatencyMs = result.latencyMs;
      this.lastRagError = null;
      endRag('ok');
      return result;
    } catch (err) {
      this.lastRagError = (err as Error).message;
      endRag('error');
      throw err;
    }
  }

  async runRedTeamCampaign(options: RedTeamCampaignOptions = {}): Promise<RedTeamCampaignReport> {
    this.reloadStateIfModified();
    const ensembleConfig = this.getEffectiveEnsembleConfig();
    const allTexts = this.state.routes.flatMap((r) => r.utterances);

    const slotLookups: EnsembleSlotLookup[] = [];
    for (const slot of ensembleConfig.slots) {
      if (slot.enabled) {
        const sl = await this.buildSlotVectorLookup(slot, [], this.state.routes, false);
        slotLookups.push(sl);
      }
    }

    const ensembleLookup = {
      slots: slotLookups,
      fusionMode: ensembleConfig.fusionMode,
    };

    const report = runRedTeamCampaign(
      this.state.routes,
      this.state.config,
      ensembleLookup,
      options
    );

    this.redTeamHistory.unshift(report);
    if (this.redTeamHistory.length > 20) {
      this.redTeamHistory.pop();
    }
    this.telemetry.notify();
    return report;
  }

  getRedTeamHistory(): RedTeamCampaignReport[] {
    return this.redTeamHistory;
  }

  applyGuardrailPatch(targetRouteName: string, suggestedUtterances: string[]): {
    updatedRoute: RouteDefinition;
    addedCount: number;
    routes: RouteDefinition[];
  } {
    this.reloadStateIfModified();
    const res = applyGuardrailPatch(this.state.routes, targetRouteName, suggestedUtterances);
    this.state.routes = res.updatedRoutes;
    this.saveState();

    const updated = this.state.routes.find((r) => r.name === targetRouteName) || this.state.routes[0];

    // Mark recommendation as applied in the latest campaign
    if (this.redTeamHistory.length > 0) {
      for (const rec of this.redTeamHistory[0].recommendations) {
        if (rec.targetRouteName === targetRouteName) {
          rec.applied = true;
        }
      }
    }

    this.telemetry.notify();
    return {
      updatedRoute: updated,
      addedCount: res.addedCount,
      routes: this.state.routes,
    };
  }

  resetWorkspace() {
    this.agentState.reset();
    this.state = {
      routes: structuredClone(SEED_ROUTES),
      evalCases: structuredClone(SEED_EVAL_CASES),
      config: structuredClone(DEFAULT_ROUTER_CONFIG),
      instructions: structuredClone(DEFAULT_SYSTEM_INSTRUCTIONS),
      ragConnectors: structuredClone(SEED_RAG_CONNECTORS),
      ragChunks: [],
    };
    this.syncLoadedPackageStoresIntoConnectors(false);
    this.e5EmbeddingCache.clear();
    this.ensembleManager.clearCaches();
    void this.progressTracker.setMilestones(structuredClone(SEED_PROJECT_MILESTONES)).then((ps) => {
      this.state.progressState = ps;
      this.saveState();
    });
    this.saveState();
    this.telemetry.notify();
    return this.getWorkspaceData();
  }
}
