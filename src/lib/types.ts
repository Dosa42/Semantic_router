export type RouteType = 'static' | 'dynamic';
export type RoutingMode = 'hybrid' | 'dense' | 'sparse';
export type AggregationStrategy = 'max' | 'mean' | 'top_k_mean';
export type EncoderModelId = 'e5-small-v2' | 'local-subword-bm25';

export interface FunctionParameter {
  name: string;
  type: 'string' | 'number' | 'boolean';
  description: string;
  required: boolean;
}

export interface FunctionSchema {
  name: string;
  description: string;
  parameters: FunctionParameter[];
}

export interface RouteInstructionOverride {
  embeddingContextPrefix?: string;
  chatgptSystemInstruction?: string;
}

export interface RouteDefinition {
  id: string;
  name: string;
  description: string;
  utterances: string[];
  scoreThreshold: number;
  routeType: RouteType;
  targetModel: string;
  enabled: boolean;
  functionSchema?: FunctionSchema;
  instructionOverrides?: RouteInstructionOverride;
  createdAt: string;
}

export interface EmbeddingInstructionsConfig {
  queryTemplate: string;
  passageTemplate: string;
  taskInstruction: string;
  lowercaseInput: boolean;
  stripExtraWhitespace: boolean;
  maxChars: number;
}

export interface ChatGptInstructionsConfig {
  responseSystemPrompt: string;
  extractionSystemPrompt: string;
  ragContextTemplate: string;
  enforceCitations: boolean;
  conciseMode: boolean;
}

export interface SystemInstructionsConfig {
  embedding: EmbeddingInstructionsConfig;
  chatgpt: ChatGptInstructionsConfig;
}

export interface RouterConfig {
  mode: RoutingMode;
  alpha: number; // 0 = pure sparse, 1 = pure dense
  aggregation: AggregationStrategy;
  defaultThreshold: number;
  encoderModel: EncoderModelId;
  mcpEnabled: boolean;
  ragEnabledByDefault: boolean;
}

export interface UtteranceMatch {
  utterance: string;
  score: number;
  denseScore: number;
  sparseScore: number;
}

export interface RouteScoreBreakdown {
  routeId: string;
  routeName: string;
  routeType: RouteType;
  targetModel: string;
  score: number;
  denseScore: number;
  sparseScore: number;
  threshold: number;
  passed: boolean;
  margin: number;
  topUtterance: string;
  utteranceMatches: UtteranceMatch[];
}

export interface ExtractedFunctionCall {
  name: string;
  arguments: Record<string, string | number | boolean | null>;
  extractionMethod: 'openai-chatgpt-plan' | 'local-slot-parser';
}

export interface ProviderExecutionResult {
  providerId: string;
  providerKind: 'tool' | 'llm' | 'guardrail' | 'fallback';
  handlerName: string;
  latencyMs: number;
  status: 'ok' | 'blocked' | 'fallback' | 'auth_required';
  output: Record<string, unknown> | string;
}

export type RagParserMode = 'auto' | 'json' | 'text' | 'html';

export interface RagConnector {
  id: string;
  name: string;
  url: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  requestBody?: string;
  parserMode: RagParserMode;
  jsonPath?: string;
  boundRouteIds: string[];
  chunkSize: number;
  chunkOverlap: number;
  enabled: boolean;
  lastSyncedAt: string | null;
  lastStatus: 'idle' | 'ok' | 'error';
  lastLatencyMs: number | null;
  lastError: string | null;
  chunkCount: number;
}

export interface RagChunk {
  id: string;
  connectorId: string;
  connectorName: string;
  sourceUrl: string;
  text: string;
  chunkIndex: number;
  fetchedAt: string;
}

export interface RagRetrievalMatch {
  chunkId: string;
  connectorId: string;
  connectorName: string;
  sourceUrl: string;
  text: string;
  score: number;
  denseScore: number;
  sparseScore: number;
}

export interface RagQueryResult {
  query: string;
  matches: RagRetrievalMatch[];
  latencyMs: number;
  encoderUsed: string;
  connectorCount: number;
}

export interface RouteDecisionResult {
  query: string;
  matchedRoute: string | null;
  matchedRouteId: string | null;
  matchedRouteType: RouteType | null;
  targetModel: string | null;
  topScore: number;
  thresholdUsed: number | null;
  latencyMs: number;
  encoderUsed: string;
  mode: RoutingMode;
  alpha: number;
  aggregation: AggregationStrategy;
  functionCall: ExtractedFunctionCall | null;
  providerExecution?: ProviderExecutionResult | null;
  ragMatches?: RagRetrievalMatch[];
  appliedInstructions?: {
    embeddingQueryPreview: string;
    chatgptSystemPrompt: string | null;
  };
  allScores: RouteScoreBreakdown[];
}

export interface EvalCase {
  id: string;
  query: string;
  expectedRoute: string | null;
}

export interface EvalPrediction {
  id: string;
  query: string;
  expectedRoute: string | null;
  predictedRoute: string | null;
  topScore: number;
  thresholdUsed: number | null;
  correct: boolean;
}

export interface RouteMetric {
  routeName: string;
  support: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
  currentThreshold: number;
}

export interface EvalReport {
  accuracy: number;
  totalCases: number;
  correctCases: number;
  matchedCount: number;
  fallbackCount: number;
  falsePositiveRate: number;
  encoderUsed: string;
  predictions: EvalPrediction[];
  routeMetrics: RouteMetric[];
}

export interface FitThresholdChange {
  routeId: string;
  routeName: string;
  previousThreshold: number;
  optimizedThreshold: number;
}

export interface FitReport {
  beforeAccuracy: number;
  afterAccuracy: number;
  totalCases: number;
  changes: FitThresholdChange[];
  updatedRoutes: RouteDefinition[];
}

export interface RoutingTraceEntry {
  id: string;
  timestamp: string;
  result: RouteDecisionResult;
}

export type OpenAiFlowMode = 'dynamic_agent' | 'device_code' | 'website_client';

export interface AuthorizeParamEntry {
  key: string;
  value: string;
  required: boolean;
  note: string;
}

export interface AuthorizePreviewResult {
  endpoint: string;
  authUrl: string;
  flowMode: OpenAiFlowMode;
  clientId: string;
  redirectUri: string;
  params: AuthorizeParamEntry[];
  warnings: string[];
}

export interface DeviceAuthSessionInfo {
  deviceAuthId: string;
  userCode: string;
  verificationUri: string;
  intervalSec: number;
  expiresAt: number;
  clientId: string;
}

export interface DeviceAuthPollResult {
  status: 'pending' | 'authorized' | 'expired' | 'error';
  intervalSec?: number;
  profile?: ChatGptProfile;
  error?: string;
}

export interface ChatGptProfile {
  profileId: string;
  issuedClientId: string;
  issuer: string;
  subject: string;
  email: string | null;
  name: string | null;
  workspaceId: string | null;
  grantedScopes: string[];
  sharing: boolean;
  connected: boolean;
  expiresAt: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatGptSessionState {
  hostId: string;
  configuredClientId: string | null;
  defaultFlowMode: OpenAiFlowMode;
  appUrl: string | null;
  webCallbackUrl: string;
  activeProfileId: string | null;
  activeProfile: ChatGptProfile | null;
  profiles: ChatGptProfile[];
}

export interface ChatGptModelInfo {
  slug: string;
  display_name: string;
}

export type TelemetryLampColor = 'green' | 'yellow' | 'red';
export type TelemetrySubsystemId = 'ai_model' | 'semantic_router' | 'embedding_model';

export interface TelemetrySubsystemStatus {
  id: TelemetrySubsystemId;
  label: string;
  target: string;
  lamp: TelemetryLampColor;
  statusText: string;
  detail: string;
  portOrRuntime: string;
  lastLatencyMs: number | null;
}

export interface TelemetryPortBinding {
  port: number;
  protocol: 'HTTP' | 'HTTPS' | 'ONNX' | 'STDIO' | 'IPC';
  service: string;
  state: 'listening' | 'standby' | 'egress' | 'ready' | 'warming' | 'error';
  detail: string;
  subsystem: TelemetrySubsystemId;
}

export interface TelemetryEndpointMetric {
  id: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  subsystem: TelemetrySubsystemId;
  targetNode: string;
  hits: number;
  errors: number;
  lastStatus: number | null;
  avgLatencyMs: number | null;
  lastLatencyMs: number | null;
  lastCalledAt: string | null;
}

export interface TelemetryTraceEvent {
  id: string;
  timestamp: string;
  method: string;
  path: string;
  routePattern: string;
  status: number;
  durationMs: number;
  subsystem: TelemetrySubsystemId;
  sourceNode: string;
  targetNode: string;
  requestBody: unknown;
  responseBody: unknown;
}

export type TelemetryEdgeId =
  | 'browser->express'
  | 'mcp->router'
  | 'express->router'
  | 'router->bridge'
  | 'bridge->embedding'
  | 'router->rag_connector'
  | 'router->chatgpt'
  | 'chatgpt->loopback';

export interface TelemetryEdgeState {
  id: TelemetryEdgeId;
  from: string;
  to: string;
  label: string;
  portOrChannel: string;
  protocol: string;
  activeCount: number;
  lastStartedAtMs: number | null;
  lastCompletedAtMs: number | null;
  lastDurationMs: number | null;
  hitCount: number;
  lastStatus: 'ok' | 'error' | 'active' | 'idle';
}

export interface TelemetrySnapshot {
  timestamp: string;
  uptimeSec: number;
  expressPort: number;
  loopbackListening: boolean;
  loopbackPort: number | null;
  mcpEnabled: boolean;
  mcpCallCount: number;
  ragConnectorCount: number;
  ragChunkCount: number;
  activeFlowEdge: string | null;
  edges: TelemetryEdgeState[];
  subsystems: TelemetrySubsystemStatus[];
  ports: TelemetryPortBinding[];
  endpoints: TelemetryEndpointMetric[];
  recentTraces: TelemetryTraceEvent[];
}

export interface McpStdioLogEntry {
  id: string;
  timestamp: string;
  direction: 'stdin' | 'stdout';
  method?: string;
  rpcId?: string | number | null;
  payload: unknown;
  durationMs?: number;
}

export type ArchitectureSideId = 'semantic-router-studio' | 'torrent-rag-uagl';

export interface ArchitectureBlueprint {
  id: ArchitectureSideId;
  title: string;
  stackLabel: string;
  summary: string;
  portsAndProtocols: string[];
  mermaidCode: string;
}

export interface ArchitectureComparisonRow {
  dimension: string;
  semanticRouterStudio: string;
  torrentRagUagl: string;
  sharedPattern: string;
}

export interface LibraryKnowledgeState {
  version: string;
  updatedAt: string;
  notes: string;
  blueprints: [ArchitectureBlueprint, ArchitectureBlueprint];
  comparisonMatrix: ArchitectureComparisonRow[];
}

