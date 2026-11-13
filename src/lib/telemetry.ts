import type {
  EncoderModelId,
  EnsembleFusionMode,
  EnsembleSlotRuntimeStatus,
  TelemetryEdgeId,
  TelemetryEdgeState,
  TelemetryEndpointMetric,
  TelemetryPortBinding,
  TelemetrySnapshot,
  TelemetrySubsystemId,
  TelemetrySubsystemStatus,
  TelemetryTraceEvent,
} from './types.ts';

const SENSITIVE_KEYS = new Set([
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'access_token',
  'refresh_token',
  'id_token',
  'client_secret',
  'clientsecret',
  'authorization',
  'codeverifier',
  'code_verifier',
  'cookie',
  'password',
  'secret',
]);

export function sanitizeTelemetryPayload(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (depth > 5) return '[TRUNCATED]';

  if (typeof value === 'string') {
    if (value.length > 500) {
      return `${value.slice(0, 500)}… (+${value.length - 500} chars)`;
    }
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (Array.isArray(value)) {
    const sliced = value.slice(0, 12).map((item) => sanitizeTelemetryPayload(item, depth + 1));
    if (value.length > 12) {
      sliced.push(`… (+${value.length - 12} items)`);
    }
    return sliced;
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [key, val] of entries.slice(0, 24)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        out[key] = '[REDACTED]';
      } else {
        out[key] = sanitizeTelemetryPayload(val, depth + 1);
      }
    }
    if (entries.length > 24) {
      out.__truncatedKeys = entries.length - 24;
    }
    return out;
  }

  return String(value);
}

export function classifyEndpointTelemetry(
  method: string,
  reqPath: string
): {
  routePattern: string;
  subsystem: TelemetrySubsystemId;
  targetNode: string;
} {
  const cleanMethod = method.toUpperCase();
  const pathOnly = reqPath.split('?')[0] || '/';

  if (
    pathOnly.startsWith('/api/auth/openai') ||
    pathOnly.startsWith('/auth/openai') ||
    pathOnly.startsWith('/auth/callback')
  ) {
    return {
      routePattern: `${cleanMethod} ${pathOnly}`,
      subsystem: 'ai_model',
      targetNode: 'openai-oauth-llm',
    };
  }
  if (pathOnly.startsWith('/api/providers/embed-test')) {
    return {
      routePattern: `${cleanMethod} ${pathOnly}`,
      subsystem: 'embedding_model',
      targetNode: 'e5-onnx-worker',
    };
  }
  if (pathOnly === '/api/providers' || pathOnly.startsWith('/api/providers/execute')) {
    const isEmbedInfo = pathOnly === '/api/providers';
    return {
      routePattern: `${cleanMethod} ${pathOnly}`,
      subsystem: isEmbedInfo ? 'embedding_model' : 'ai_model',
      targetNode: isEmbedInfo ? 'e5-onnx-worker' : 'openai-oauth-llm',
    };
  }
  if (pathOnly.startsWith('/api/routes/') && pathOnly.split('/').length === 4) {
    return {
      routePattern: `${cleanMethod} /api/routes/:id`,
      subsystem: 'semantic_router',
      targetNode: 'semantic-router-rag',
    };
  }
  if (pathOnly.startsWith('/api/eval-cases/') && pathOnly.split('/').length === 4) {
    return {
      routePattern: `${cleanMethod} /api/eval-cases/:id`,
      subsystem: 'semantic_router',
      targetNode: 'semantic-router-rag',
    };
  }
  if (pathOnly.startsWith('/api/rag/connectors/') && pathOnly.endsWith('/sync')) {
    return {
      routePattern: `${cleanMethod} /api/rag/connectors/:id/sync`,
      subsystem: 'semantic_router',
      targetNode: 'rag-connector',
    };
  }
  if (pathOnly.startsWith('/api/rag/connectors/') && pathOnly.split('/').length === 5) {
    return {
      routePattern: `${cleanMethod} /api/rag/connectors/:id`,
      subsystem: 'semantic_router',
      targetNode: 'rag-connector',
    };
  }
  if (pathOnly.startsWith('/api/progress')) {
    return {
      routePattern: `${cleanMethod} ${pathOnly}`,
      subsystem: 'embedding_state',
      targetNode: 'em3-progress-tracker',
    };
  }
  if (pathOnly.startsWith('/api/agent-state')) {
    return {
      routePattern: `${cleanMethod} ${pathOnly}`,
      subsystem: 'ensemble_fusion',
      targetNode: 'agent-state-store',
    };
  }
  if (pathOnly.startsWith('/api/mcp')) {
    return {
      routePattern: `${cleanMethod} ${pathOnly}`,
      subsystem: 'semantic_router',
      targetNode: 'mcp-stdio-bridge',
    };
  }
  return {
    routePattern: `${cleanMethod} ${pathOnly}`,
    subsystem: 'semantic_router',
    targetNode: 'semantic-router-rag',
  };
}

export interface SubsystemStateInput {
  expressPort: number;
  chatGptConnected: boolean;
  chatGptSharing: boolean;
  chatGptEmail: string | null;
  pendingAuthCount: number;
  lastOpenAiError: string | null;
  lastOpenAiLatencyMs: number | null;
  activeRouteCount: number;
  totalRouteCount: number;
  isEvaluatingOrFitting: boolean;
  lastRouterError: string | null;
  lastRouteLatencyMs: number | null;
  encoderModel: EncoderModelId;
  e5Status: 'idle' | 'loading' | 'ready' | 'error';
  e5CachedCount: number;
  lastEmbedLatencyMs: number | null;
  loopbackListening: boolean;
  loopbackPort: number | null;
  mcpEnabled?: boolean;
  mcpCallCount?: number;
  ragConnectorCount?: number;
  ragChunkCount?: number;
  lastRagLatencyMs?: number | null;
  lastRagError?: string | null;
  ensembleActive?: boolean;
  fusionMode?: EnsembleFusionMode;
  slotStatuses?: EnsembleSlotRuntimeStatus[];
  progressOverall?: number;
  activeFocusLabel?: string | null;
}

export function computeSubsystemSignals(input: SubsystemStateInput): {
  subsystems: TelemetrySubsystemStatus[];
  ports: TelemetryPortBinding[];
} {
  // 1. Left: AI Model (OpenAI Sign in with ChatGPT + Responses API)
  let aiLamp: TelemetrySubsystemStatus['lamp'] = 'red';
  let aiStatusText = 'AUTH_REQ';
  let aiDetail = 'Sign in with ChatGPT required for OpenAI routes';
  if (input.lastOpenAiError) {
    aiLamp = 'red';
    aiStatusText = 'ERROR';
    aiDetail = input.lastOpenAiError;
  } else if (input.chatGptConnected && input.chatGptSharing) {
    aiLamp = 'green';
    aiStatusText = 'READY';
    aiDetail = input.chatGptEmail
      ? `Plan sharing active (${input.chatGptEmail})`
      : 'ChatGPT plan usage active';
  } else if (input.chatGptConnected || input.pendingAuthCount > 0) {
    aiLamp = 'yellow';
    aiStatusText = input.pendingAuthCount > 0 ? 'PENDING' : 'ID_ONLY';
    aiDetail =
      input.pendingAuthCount > 0
        ? 'OAuth / device flow awaiting user consent'
        : 'Signed in without chatgpt.tokens.use.direct scope';
  }

  // 2. Middle: Semantic Router RAG (Hybrid / Dense / Sparse route index + MCP + Connectors)
  let routerLamp: TelemetrySubsystemStatus['lamp'] = 'green';
  let routerStatusText = 'ONLINE';
  const ragSuffix =
    typeof input.ragChunkCount === 'number'
      ? ` · ${input.ragChunkCount} RAG chunks`
      : '';
  let routerDetail = `${input.activeRouteCount}/${input.totalRouteCount} routes${ragSuffix}`;
  if (input.lastRouterError || input.activeRouteCount === 0) {
    routerLamp = 'red';
    routerStatusText = input.activeRouteCount === 0 ? 'NO_ROUTES' : 'ERROR';
    routerDetail = input.lastRouterError ?? 'Zero enabled semantic routes in index';
  } else if (input.isEvaluatingOrFitting) {
    routerLamp = 'yellow';
    routerStatusText = 'OPTIMIZING';
    routerDetail = 'Evaluating dataset / fitting route thresholds';
  }

  // 3. Right: Embedding Model (aggregate + per-slot EM-1/EM-2/EM-3 + Ensemble Fusion)
  let embedLamp: TelemetrySubsystemStatus['lamp'] = 'yellow';
  let embedStatusText = 'WARMING';
  let embedDetail = 'Loading Xenova/e5-small-v2 q8 ONNX weights';
  if (input.encoderModel === 'local-subword-bm25') {
    embedLamp = 'green';
    embedStatusText = 'READY';
    embedDetail = 'Subword 256d + BM25 lexical index ready';
  } else if (input.e5Status === 'error') {
    embedLamp = 'red';
    embedStatusText = 'ERROR';
    embedDetail = 'ONNX pipeline failed; fallback active';
  } else if (input.e5Status === 'ready') {
    embedLamp = 'green';
    embedStatusText = 'READY';
    embedDetail = `384d vectors · ${input.e5CachedCount} cached`;
  } else if (input.e5Status === 'idle') {
    embedLamp = 'yellow';
    embedStatusText = 'IDLE';
    embedDetail = 'Awaiting ONNX warmup request';
  }

  const slotMap = new Map((input.slotStatuses ?? []).map((s) => [s.role, s]));
  const mapSlotLamp = (
    role: 'intent' | 'domain' | 'state',
    fallbackLamp: TelemetrySubsystemStatus['lamp']
  ): TelemetrySubsystemStatus['lamp'] => {
    const slot = slotMap.get(role);
    if (!slot) return fallbackLamp;
    if (slot.status === 'ready') return 'green';
    if (slot.status === 'error') return 'red';
    return 'yellow';
  };

  const intentSlot = slotMap.get('intent');
  const domainSlot = slotMap.get('domain');
  const stateSlot = slotMap.get('state');

  const subsystems: TelemetrySubsystemStatus[] = [
    {
      id: 'ai_model',
      label: 'AI Model',
      target: 'OpenAI ChatGPT',
      lamp: aiLamp,
      statusText: aiStatusText,
      detail: aiDetail,
      portOrRuntime: ':443 HTTPS',
      lastLatencyMs: input.lastOpenAiLatencyMs,
    },
    {
      id: 'semantic_router',
      label: 'Router & RAG',
      target: 'HTTP + MCP Engine',
      lamp: routerLamp,
      statusText: routerStatusText,
      detail: routerDetail,
      portOrRuntime:
        input.mcpEnabled === false ? `:${input.expressPort} HTTP` : `:${input.expressPort} + stdio`,
      lastLatencyMs: input.lastRouteLatencyMs,
    },
    {
      id: 'embedding_model',
      label: 'Embedding LM',
      target: input.encoderModel === 'e5-small-v2' ? 'e5-small-v2' : input.encoderModel,
      lamp: embedLamp,
      statusText: embedStatusText,
      detail: embedDetail,
      portOrRuntime: 'ONNX 384d',
      lastLatencyMs: input.lastEmbedLatencyMs,
    },
    {
      id: 'embedding_intent',
      label: 'EM-1 Intent',
      target: intentSlot?.modelId ?? 'e5-small-v2',
      lamp: mapSlotLamp('intent', embedLamp),
      statusText: intentSlot ? intentSlot.status.toUpperCase() : embedStatusText,
      detail: intentSlot
        ? `${intentSlot.dimensions}d (${intentSlot.backend}) · ${intentSlot.cachedCount} cached`
        : '384d intent classification slot',
      portOrRuntime: `IPC · ${intentSlot?.dimensions ?? 384}d`,
      lastLatencyMs: intentSlot?.lastLatencyMs ?? input.lastEmbedLatencyMs,
    },
    {
      id: 'embedding_domain',
      label: 'EM-2 Domain',
      target: domainSlot?.modelId ?? 'local-subword-bm25',
      lamp: mapSlotLamp('domain', 'green'),
      statusText: domainSlot ? domainSlot.status.toUpperCase() : 'READY',
      detail: domainSlot
        ? `${domainSlot.dimensions}d (${domainSlot.backend}) · ${domainSlot.cachedCount} cached`
        : '256d domain + BM25 hybrid slot',
      portOrRuntime: `IPC · ${domainSlot?.dimensions ?? 256}d`,
      lastLatencyMs: domainSlot?.lastLatencyMs ?? input.lastEmbedLatencyMs,
    },
    {
      id: 'embedding_state',
      label: 'EM-3 State',
      target: stateSlot?.modelId ?? 'bge-m3',
      lamp: mapSlotLamp('state', 'green'),
      statusText: stateSlot ? stateSlot.status.toUpperCase() : 'READY',
      detail:
        typeof input.progressOverall === 'number'
          ? `Progress ${(input.progressOverall * 100).toFixed(0)}%${
              input.activeFocusLabel ? ` · ${input.activeFocusLabel}` : ''
            }`
          : '1024d milestone state tracker',
      portOrRuntime: `IPC · ${stateSlot?.dimensions ?? 1024}d`,
      lastLatencyMs: stateSlot?.lastLatencyMs ?? input.lastEmbedLatencyMs,
    },
    {
      id: 'ensemble_fusion',
      label: 'Ensemble Fusion',
      target: input.fusionMode ?? 'weighted_sum',
      lamp: input.ensembleActive ? 'green' : 'yellow',
      statusText: input.ensembleActive ? 'ACTIVE' : 'SINGLE',
      detail: input.ensembleActive
        ? `3-slot fusion (${input.fusionMode ?? 'weighted_sum'})`
        : 'Single-encoder compatibility mode',
      portOrRuntime: 'IPC Fusion',
      lastLatencyMs: input.lastRouteLatencyMs,
    },
  ];

  const ports: TelemetryPortBinding[] = [
    {
      port: input.expressPort,
      protocol: 'HTTP',
      service: 'Express API Gateway + Vite',
      state: 'listening',
      detail: `0.0.0.0:${input.expressPort} (/api/* & SSE)`,
      subsystem: 'semantic_router',
    },
    {
      port: 0,
      protocol: 'STDIO',
      service: 'MCP JSON-RPC 2.0 Server',
      state: input.mcpEnabled === false ? 'standby' : 'listening',
      detail:
        input.mcpEnabled === false
          ? 'Disabled in router settings'
          : `stdin/stdout active · ${input.mcpCallCount ?? 0} calls`,
      subsystem: 'semantic_router',
    },
    {
      port: 0,
      protocol: 'IPC',
      service: 'EmbeddingsBridge Orchestrator',
      state: 'ready',
      detail: `${input.e5CachedCount} cached formatted vectors`,
      subsystem: 'embedding_model',
    },
    {
      port: 0,
      protocol: 'ONNX',
      service: 'Xenova/e5-small-v2 Feature Extractor',
      state:
        input.e5Status === 'error'
          ? 'error'
          : input.e5Status === 'ready'
            ? 'ready'
            : 'warming',
      detail: `${input.encoderModel} inference worker`,
      subsystem: 'embedding_model',
    },
    {
      port: 0,
      protocol: 'IPC',
      service: 'Ensemble Fusion & Progress Tracker',
      state: input.ensembleActive ? 'ready' : 'standby',
      detail: `${input.fusionMode ?? 'weighted_sum'} fusion · ${
        typeof input.progressOverall === 'number'
          ? `${Math.round(input.progressOverall * 100)}% milestone alignment`
          : 'EM-3 state tracking'
      }`,
      subsystem: 'ensemble_fusion',
    },
    {
      port: 443,
      protocol: 'HTTPS',
      service: 'RAG Webhook / URL Connectors',
      state: input.lastRagError
        ? 'error'
        : (input.ragConnectorCount ?? 0) > 0
          ? 'egress'
          : 'standby',
      detail: `${input.ragConnectorCount ?? 0} connectors · ${input.ragChunkCount ?? 0} chunks`,
      subsystem: 'semantic_router',
    },
    {
      port: input.loopbackPort ?? 1455,
      protocol: 'HTTP',
      service: 'OAuth Loopback Callback Listener',
      state: input.loopbackListening ? 'listening' : 'standby',
      detail: input.loopbackListening
        ? `127.0.0.1:${input.loopbackPort ?? 1455}/auth/callback active`
        : 'Binds 127.0.0.1:1455 during PKCE sign-in',
      subsystem: 'ai_model',
    },
    {
      port: 443,
      protocol: 'HTTPS',
      service: 'auth.openai.com & api.openai.com/v1',
      state: input.lastOpenAiError ? 'error' : input.chatGptConnected ? 'egress' : 'standby',
      detail: 'OIDC PKCE + Device Auth + Responses SSE',
      subsystem: 'ai_model',
    },
  ];

  return { subsystems, ports };
}

const DEFAULT_EDGE_DEFS: Array<{
  id: TelemetryEdgeId;
  from: string;
  to: string;
  label: string;
  portOrChannel: string;
  protocol: string;
}> = [
  {
    id: 'browser->express',
    from: 'browser',
    to: 'express',
    label: 'HTTP/SSE',
    portOrChannel: ':3000',
    protocol: 'HTTP',
  },
  {
    id: 'mcp->router',
    from: 'mcp',
    to: 'router',
    label: 'stdin/stdout',
    portOrChannel: 'stdio',
    protocol: 'MCP',
  },
  {
    id: 'express->router',
    from: 'express',
    to: 'router',
    label: '/api/*',
    portOrChannel: ':3000',
    protocol: 'IPC',
  },
  {
    id: 'router->bridge',
    from: 'router',
    to: 'bridge',
    label: 'Embed IPC',
    portOrChannel: 'IPC',
    protocol: 'IPC',
  },
  {
    id: 'bridge->embedding',
    from: 'bridge',
    to: 'embedding',
    label: 'ONNX 384d',
    portOrChannel: 'ONNX',
    protocol: 'ONNX',
  },
  {
    id: 'router->embedding_intent',
    from: 'router',
    to: 'embedding_intent',
    label: 'EM-1 Intent',
    portOrChannel: '384d',
    protocol: 'ONNX',
  },
  {
    id: 'router->embedding_domain',
    from: 'router',
    to: 'embedding_domain',
    label: 'EM-2 Domain',
    portOrChannel: '256d',
    protocol: 'IPC',
  },
  {
    id: 'router->embedding_state',
    from: 'router',
    to: 'embedding_state',
    label: 'EM-3 State',
    portOrChannel: '1024d',
    protocol: 'IPC',
  },
  {
    id: 'embedding_intent->ensemble',
    from: 'embedding_intent',
    to: 'ensemble',
    label: 'Score Intent',
    portOrChannel: 'vec',
    protocol: 'IPC',
  },
  {
    id: 'embedding_domain->ensemble',
    from: 'embedding_domain',
    to: 'ensemble',
    label: 'Score Domain',
    portOrChannel: 'vec',
    protocol: 'IPC',
  },
  {
    id: 'embedding_state->ensemble',
    from: 'embedding_state',
    to: 'ensemble',
    label: 'Score State',
    portOrChannel: 'vec',
    protocol: 'IPC',
  },
  {
    id: 'ensemble->router',
    from: 'ensemble',
    to: 'router',
    label: 'Fused Decision',
    portOrChannel: 'IPC',
    protocol: 'IPC',
  },
  {
    id: 'embedding_state->progress_tracker',
    from: 'embedding_state',
    to: 'progress_tracker',
    label: 'Milestones',
    portOrChannel: '1024d',
    protocol: 'IPC',
  },
  {
    id: 'router->rag_connector',
    from: 'router',
    to: 'rag_connector',
    label: 'Webhook',
    portOrChannel: ':443',
    protocol: 'HTTPS',
  },
  {
    id: 'router->chatgpt',
    from: 'router',
    to: 'chatgpt',
    label: 'Responses',
    portOrChannel: ':443',
    protocol: 'HTTPS',
  },
  {
    id: 'chatgpt->loopback',
    from: 'chatgpt',
    to: 'loopback',
    label: 'PKCE Auth',
    portOrChannel: ':1455',
    protocol: 'HTTP',
  },
];

const DEFAULT_ENDPOINTS: Array<{
  method: TelemetryEndpointMetric['method'];
  path: string;
  subsystem: TelemetrySubsystemId;
  targetNode: string;
}> = [
  { method: 'POST', path: '/api/route', subsystem: 'semantic_router', targetNode: 'semantic-router-rag' },
  { method: 'POST', path: '/api/evaluate', subsystem: 'semantic_router', targetNode: 'semantic-router-rag' },
  { method: 'POST', path: '/api/fit', subsystem: 'semantic_router', targetNode: 'semantic-router-rag' },
  { method: 'GET', path: '/api/routes', subsystem: 'semantic_router', targetNode: 'semantic-router-rag' },
  { method: 'GET', path: '/api/progress', subsystem: 'embedding_state', targetNode: 'em3-progress-tracker' },
  { method: 'POST', path: '/api/progress/evaluate', subsystem: 'embedding_state', targetNode: 'em3-progress-tracker' },
  { method: 'PUT', path: '/api/progress/milestones', subsystem: 'embedding_state', targetNode: 'em3-progress-tracker' },
  { method: 'GET', path: '/api/agent-state', subsystem: 'ensemble_fusion', targetNode: 'agent-state-store' },
  { method: 'GET', path: '/api/instructions', subsystem: 'embedding_model', targetNode: 'e5-onnx-worker' },
  { method: 'PUT', path: '/api/instructions', subsystem: 'embedding_model', targetNode: 'e5-onnx-worker' },
  { method: 'GET', path: '/api/rag/connectors', subsystem: 'semantic_router', targetNode: 'rag-connector' },
  { method: 'POST', path: '/api/rag/query', subsystem: 'semantic_router', targetNode: 'rag-connector' },
  { method: 'POST', path: '/api/mcp/stdio', subsystem: 'semantic_router', targetNode: 'mcp-stdio-bridge' },
  { method: 'POST', path: '/api/providers/embed-test', subsystem: 'embedding_model', targetNode: 'e5-onnx-worker' },
  { method: 'GET', path: '/api/providers', subsystem: 'embedding_model', targetNode: 'e5-onnx-worker' },
  { method: 'POST', path: '/api/providers/execute', subsystem: 'ai_model', targetNode: 'openai-oauth-llm' },
  { method: 'POST', path: '/api/auth/openai/preview', subsystem: 'ai_model', targetNode: 'openai-oauth-llm' },
  { method: 'POST', path: '/api/auth/openai/start', subsystem: 'ai_model', targetNode: 'openai-oauth-llm' },
  { method: 'POST', path: '/api/auth/openai/device/start', subsystem: 'ai_model', targetNode: 'openai-oauth-llm' },
  { method: 'POST', path: '/api/auth/openai/device/poll', subsystem: 'ai_model', targetNode: 'openai-oauth-llm' },
  { method: 'POST', path: '/api/auth/openai/verify', subsystem: 'ai_model', targetNode: 'openai-oauth-llm' },
  { method: 'GET', path: '/api/health', subsystem: 'semantic_router', targetNode: 'semantic-router-rag' },
];

export class TelemetryCollector {
  private readonly startedAt = Date.now();
  private readonly traces: TelemetryTraceEvent[] = [];
  private readonly endpointMap = new Map<string, TelemetryEndpointMetric>();
  private readonly edgeMap = new Map<TelemetryEdgeId, TelemetryEdgeState>();
  private readonly listeners = new Set<(snapshot: TelemetrySnapshot) => void>();
  private activeFlowEdge: string | null = null;
  private stateProvider: (() => SubsystemStateInput) | null = null;

  constructor() {
    for (const def of DEFAULT_ENDPOINTS) {
      const id = `${def.method} ${def.path}`;
      this.endpointMap.set(id, {
        id,
        method: def.method,
        path: def.path,
        subsystem: def.subsystem,
        targetNode: def.targetNode,
        hits: 0,
        errors: 0,
        lastStatus: null,
        avgLatencyMs: null,
        lastLatencyMs: null,
        lastCalledAt: null,
      });
    }

    for (const edgeDef of DEFAULT_EDGE_DEFS) {
      this.edgeMap.set(edgeDef.id, {
        ...edgeDef,
        activeCount: 0,
        lastStartedAtMs: null,
        lastCompletedAtMs: null,
        lastDurationMs: null,
        hitCount: 0,
        lastStatus: 'idle',
      });
    }
  }

  attachStateProvider(fn: () => SubsystemStateInput): void {
    this.stateProvider = fn;
  }

  subscribe(listener: (snapshot: TelemetrySnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  notify(): void {
    if (this.listeners.size === 0) return;
    const snap = this.getSnapshot();
    for (const fn of this.listeners) {
      try {
        fn(snap);
      } catch {
        // Ignore broken SSE stream
      }
    }
  }

  beginSpan(edgeId: TelemetryEdgeId): (status?: 'ok' | 'error') => number {
    const startNs = process.hrtime.bigint();
    const edge = this.edgeMap.get(edgeId);
    if (edge) {
      edge.activeCount += 1;
      edge.lastStartedAtMs = Date.now();
      edge.lastStatus = 'active';
      this.activeFlowEdge = edge.to;
      this.notify();
    }

    let ended = false;
    return (status: 'ok' | 'error' = 'ok') => {
      const durationMs = Math.round((Number(process.hrtime.bigint() - startNs) / 1_000_000) * 100) / 100;
      if (ended) return durationMs;
      ended = true;
      if (edge) {
        edge.activeCount = Math.max(0, edge.activeCount - 1);
        edge.lastCompletedAtMs = Date.now();
        edge.lastDurationMs = durationMs;
        edge.hitCount += 1;
        edge.lastStatus = edge.activeCount > 0 ? 'active' : status;
        this.notify();
      }
      return durationMs;
    };
  }

  recordPulse(edgeId: TelemetryEdgeId, durationMs: number, status: 'ok' | 'error' = 'ok'): void {
    const edge = this.edgeMap.get(edgeId);
    if (!edge) return;
    const now = Date.now();
    edge.lastStartedAtMs = now;
    edge.lastCompletedAtMs = now;
    edge.lastDurationMs = Math.round(durationMs * 100) / 100;
    edge.hitCount += 1;
    edge.lastStatus = status;
    this.activeFlowEdge = edge.to;
    this.notify();
  }

  recordHttpEvent(event: {
    method: string;
    path: string;
    status: number;
    durationMs: number;
    requestBody: unknown;
    responseBody: unknown;
  }): void {
    const info = classifyEndpointTelemetry(event.method, event.path);
    const nowIso = new Date().toISOString();
    const roundedMs = Math.round(event.durationMs * 100) / 100;

    const existing = this.endpointMap.get(info.routePattern);
    if (existing) {
      const totalHits = existing.hits + 1;
      const prevSum = (existing.avgLatencyMs ?? 0) * existing.hits;
      existing.hits = totalHits;
      if (event.status >= 400) existing.errors += 1;
      existing.lastStatus = event.status;
      existing.lastLatencyMs = roundedMs;
      existing.avgLatencyMs = Math.round(((prevSum + roundedMs) / totalHits) * 100) / 100;
      existing.lastCalledAt = nowIso;
    } else {
      const cleanMethod = event.method.toUpperCase();
      const methodEnum: TelemetryEndpointMetric['method'] =
        cleanMethod === 'POST' ||
        cleanMethod === 'PUT' ||
        cleanMethod === 'DELETE'
          ? cleanMethod
          : 'GET';
      this.endpointMap.set(info.routePattern, {
        id: info.routePattern,
        method: methodEnum,
        path: info.routePattern.replace(/^[A-Z]+\s+/, ''),
        subsystem: info.subsystem,
        targetNode: info.targetNode,
        hits: 1,
        errors: event.status >= 400 ? 1 : 0,
        lastStatus: event.status,
        avgLatencyMs: roundedMs,
        lastLatencyMs: roundedMs,
        lastCalledAt: nowIso,
      });
    }

    this.activeFlowEdge = info.targetNode;

    const trace: TelemetryTraceEvent = {
      id: `tel-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: nowIso,
      method: event.method.toUpperCase(),
      path: event.path,
      routePattern: info.routePattern,
      status: event.status,
      durationMs: roundedMs,
      subsystem: info.subsystem,
      sourceNode: 'express-gateway',
      targetNode: info.targetNode,
      requestBody: sanitizeTelemetryPayload(event.requestBody),
      responseBody: sanitizeTelemetryPayload(event.responseBody),
    };

    this.traces.unshift(trace);
    if (this.traces.length > 40) {
      this.traces.length = 40;
    }

    this.notify();
  }

  getSnapshot(): TelemetrySnapshot {
    const state: SubsystemStateInput = this.stateProvider
      ? this.stateProvider()
      : {
          expressPort: 3000,
          chatGptConnected: false,
          chatGptSharing: false,
          chatGptEmail: null,
          pendingAuthCount: 0,
          lastOpenAiError: null,
          lastOpenAiLatencyMs: null,
          activeRouteCount: 0,
          totalRouteCount: 0,
          isEvaluatingOrFitting: false,
          lastRouterError: null,
          lastRouteLatencyMs: null,
          encoderModel: 'e5-small-v2' as EncoderModelId,
          e5Status: 'idle' as const,
          e5CachedCount: 0,
          lastEmbedLatencyMs: null,
          loopbackListening: false,
          loopbackPort: null,
          mcpEnabled: true,
          mcpCallCount: 0,
          ragConnectorCount: 0,
          ragChunkCount: 0,
          lastRagLatencyMs: null,
          lastRagError: null,
        };

    const { subsystems, ports } = computeSubsystemSignals(state);

    const endpoints = Array.from(this.endpointMap.values()).sort((a, b) => {
      if (b.hits !== a.hits) return b.hits - a.hits;
      return a.path.localeCompare(b.path);
    });

    return {
      timestamp: new Date().toISOString(),
      uptimeSec: Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000)),
      expressPort: state.expressPort,
      loopbackListening: state.loopbackListening,
      loopbackPort: state.loopbackPort,
      mcpEnabled: state.mcpEnabled !== false,
      mcpCallCount: state.mcpCallCount ?? 0,
      ragConnectorCount: state.ragConnectorCount ?? 0,
      ragChunkCount: state.ragChunkCount ?? 0,
      ensembleActive: state.ensembleActive ?? false,
      progressOverall: state.progressOverall,
      activeFlowEdge: this.activeFlowEdge,
      edges: Array.from(this.edgeMap.values()).map((e) => ({ ...e })),
      subsystems,
      ports,
      endpoints,
      recentTraces: [...this.traces],
    };
  }
}
