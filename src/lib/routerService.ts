import fs from 'node:fs';
import path from 'node:path';
import { AgentStateStore } from './agentState.ts';
import type { ChatGptAuthManager } from './chatgptAuth.ts';
import { EmbeddingEnsembleRunner } from './embeddingEnsemble.ts';
import { formatEmbeddingText, resolveChatGptSystemPrompt } from './instructions.ts';
import { ProjectProgressTracker } from './progressTracker.ts';
import {
  ENCODER_PROVIDERS,
  executeLocalProviderFunction,
} from './providers.ts';
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
  LibraryKnowledgeState,
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
  options: { pooling: 'mean'; normalize: boolean }
) => Promise<{ tolist: () => number[][] }>;

function migrateLegacyTargetModel(target: string): string {
  if (target === 'gemini-4-hydrogen') return 'openai:chatgpt-flagship';
  if (target === 'gemini-3.1-flash-lite') return 'openai:chatgpt-fast';
  return target;
}

function migrateLegacyEncoder(enc: string | undefined): EncoderModelId {
  if (enc === 'local-subword-bm25') return 'local-subword-bm25';
  if (enc === 'bge-m3') return 'bge-m3';
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
    ['local-subword-bm25', 'local-fallback'],
    ['bge-m3', 'local-fallback'],
  ]);

  constructor(
    private readonly getE5ExtractorFn: () => Promise<FeatureExtractor>,
    private readonly onNotify?: () => void
  ) {}

  getDimensions(modelId: EncoderModelId): number {
    if (modelId === 'e5-small-v2') return 384;
    if (modelId === 'bge-m3') return 1024;
    return 256;
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
    if (slot.modelId === 'bge-m3') {
      // Deterministic 1024-dim semantic projection is ready immediately; remote ONNX is optional
      this.backendMap.set('bge-m3', 'local-fallback');
      this.statusMap.set(slot.role, 'ready');
      return;
    }
    // e5-small-v2
    this.statusMap.set(slot.role, 'loading');
    try {
      await this.getE5ExtractorFn();
      this.backendMap.set('e5-small-v2', 'onnx');
      this.statusMap.set(slot.role, 'ready');
    } catch {
      this.backendMap.set('e5-small-v2', 'local-fallback');
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

    const formattedList = texts.map((t) =>
      modelId === 'bge-m3' ? `Represent this sentence: ${t}` : t
    );
    const missing = Array.from(new Set(formattedList)).filter((k) => k.length > 0 && !cache.has(k));

    if (missing.length > 0) {
      if (modelId === 'e5-small-v2') {
        try {
          const ext = await this.getE5ExtractorFn();
          for (let i = 0; i < missing.length; i += 24) {
            const batch = missing.slice(i, i + 24);
            const out = await ext(batch, { pooling: 'mean', normalize: true });
            const vecs = out.tolist();
            batch.forEach((key, idx) => {
              cache.set(key, vecs[idx]);
            });
          }
          this.backendMap.set('e5-small-v2', 'onnx');
        } catch {
          this.backendMap.set('e5-small-v2', 'local-fallback');
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
  private readonly dataDir: string;
  private readonly stateFile: string;
  private readonly knowledgeFile: string;
  private state: PersistedState;
  private libraryKnowledge: LibraryKnowledgeState;

  private readonly e5EmbeddingCache = new Map<string, number[]>();
  private e5PipelinePromise: Promise<FeatureExtractor> | null = null;
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
    this.dataDir = path.join(rootDir, 'data');
    this.stateFile = path.join(this.dataDir, 'router-state.json');
    this.knowledgeFile = path.join(this.dataDir, 'library-knowledge.json');

    this.agentState = new AgentStateStore();
    this.ensembleManager = new EnsembleModelManager(
      () => this.getE5Extractor(),
      () => this.telemetry.notify()
    );

    this.state = this.loadState();

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

  getTelemetryStateInput(expressPort: number) {
    const activeProfile = this.chatgptAuth.getActiveProfile();
    const loopback = this.chatgptAuth.getLoopbackRuntimeStatus();
    const ensemble = this.getEffectiveEnsembleConfig();
    const progress = this.progressTracker.getState();
    const activeFocusLabel =
      progress.milestones.find((m) => m.id === progress.currentFocusId)?.label ?? null;

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
      e5CachedCount: this.e5EmbeddingCache.size,
      lastEmbedLatencyMs: this.lastEmbedLatencyMs,
      loopbackListening: loopback.listening,
      loopbackPort: loopback.port,
      mcpEnabled: this.state.config.mcpEnabled,
      mcpCallCount: this.mcpCallCount,
      ragConnectorCount: this.state.ragConnectors.filter((c) => c.enabled).length,
      ragChunkCount: this.state.ragChunks.length,
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
      ragChunksCount: this.state.ragChunks.length,
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

  getRagChunks(connectorId?: string): RagChunk[] {
    this.reloadStateIfModified();
    if (!connectorId) return this.state.ragChunks;
    return this.state.ragChunks.filter((c) => c.connectorId === connectorId);
  }

  getProvidersMetadata() {
    const ensemble = this.getEffectiveEnsembleConfig();
    return {
      activeEncoder: this.state.config.encoderModel,
      e5Status: this.e5Status,
      e5CachedCount: this.e5EmbeddingCache.size,
      encoders: ENCODER_PROVIDERS,
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

  private async getE5Extractor(): Promise<FeatureExtractor> {
    if (!this.e5PipelinePromise) {
      this.e5Status = 'loading';
      this.telemetry.notify();
      this.e5PipelinePromise = (async () => {
        const { pipeline } = await import('@huggingface/transformers');
        const extractor = (await pipeline('feature-extraction', 'Xenova/e5-small-v2', {
          dtype: 'q8',
        })) as unknown as FeatureExtractor;
        this.e5Status = 'ready';
        this.telemetry.notify();
        return extractor;
      })().catch((err) => {
        this.e5Status = 'error';
        this.e5PipelinePromise = null;
        this.telemetry.notify();
        throw err;
      });
    }
    return this.e5PipelinePromise;
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

    if (encoderModel === 'e5-small-v2') {
      try {
        const formattedQueries = queryTexts.map((q) =>
          formatEmbeddingText(q, 'query', embInstr)
        );
        const formattedPassages = items.map((i) => i.formatted);
        const missing = Array.from(
          new Set([...formattedQueries, ...formattedPassages])
        ).filter((k) => k.length > 0 && !this.e5EmbeddingCache.has(k));

        if (missing.length > 0) {
          const endEmbed = this.telemetry.beginSpan('bridge->embedding');
          try {
            const ext = await this.getE5Extractor();
            for (let i = 0; i < missing.length; i += 24) {
              const batch = missing.slice(i, i + 24);
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
        }

        const localFallback = createLocalVectorLookup();
        endBridge('ok');
        return {
          encoderUsed: 'intfloat/e5-small-v2 (ONNX 384d)',
          lookup: {
            getVector: (text: string) => {
              const qKey = formatEmbeddingText(text, 'query', embInstr);
              const pKey = formatEmbeddingText(
                text,
                'passage',
                embInstr,
                passageOverrideMap.get(text)
              );
              return (
                this.e5EmbeddingCache.get(qKey) ??
                this.e5EmbeddingCache.get(pKey) ??
                localFallback.getVector(text)
              );
            },
            getQueryVector: (text: string) => {
              const qKey = formatEmbeddingText(text, 'query', embInstr);
              return this.e5EmbeddingCache.get(qKey) ?? localFallback.getVector(text);
            },
            getPassageVector: (text: string) => {
              const pKey = formatEmbeddingText(
                text,
                'passage',
                embInstr,
                passageOverrideMap.get(text)
              );
              return this.e5EmbeddingCache.get(pKey) ?? localFallback.getVector(text);
            },
          },
        };
      } catch (err) {
        console.warn('E5 encoder fallback to local subword:', (err as Error).message);
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
    const candidateChunks = this.state.ragChunks.filter((ch) => allowedIds.has(ch.connectorId));

    const { lookup, encoderUsed } =
      this.state.config.mode === 'sparse'
        ? { lookup: createLocalVectorLookup(), encoderUsed: 'Sparse BM25 / Lexical' }
        : await this.buildVectorLookup([query], [], this.state.config.encoderModel, true);

    const matches = scoreRagChunks(query, candidateChunks, this.state.config, lookup, {
      topK: opts.topK ?? 3,
    });
    const latencyMs =
      Math.round((Number(process.hrtime.bigint() - startNs) / 1_000_000) * 100) / 100;
    this.lastRagLatencyMs = latencyMs;
    if (matches.length > 0) {
      this.telemetry.recordPulse('router->rag_connector', latencyMs, 'ok');
    }

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
        scored = scoreRoutes(query, this.state.routes, activeConfig, lookup);
      }

      let ragMatches: RagRetrievalMatch[] = [];
      if (useRag && this.state.ragChunks.length > 0) {
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
        const scopedChunks = this.state.ragChunks.filter((ch) =>
          allowedConnectors.has(ch.connectorId)
        );
        if (scopedChunks.length > 0) {
          const endRagLookup = this.telemetry.beginSpan('router->rag_connector');
          ragMatches = scoreRagChunks(query, scopedChunks, activeConfig, lookup, { topK: 3 });
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
    const nextUrl = body.url !== undefined ? body.url.trim() : existing.url;
    const parsed = new URL(nextUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Connector URL must begin with http:// or https://');
    }

    const updated: RagConnector = {
      ...existing,
      name: body.name !== undefined ? body.name.trim() || existing.name : existing.name,
      url: parsed.toString(),
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
