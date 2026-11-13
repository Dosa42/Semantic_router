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
  createdAt: string;
}

export interface RouterConfig {
  mode: RoutingMode;
  alpha: number; // 0 = pure sparse, 1 = pure dense
  aggregation: AggregationStrategy;
  defaultThreshold: number;
  encoderModel: EncoderModelId;
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
  protocol: 'HTTP' | 'HTTPS' | 'ONNX';
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

export interface TelemetrySnapshot {
  timestamp: string;
  uptimeSec: number;
  expressPort: number;
  loopbackListening: boolean;
  loopbackPort: number | null;
  activeFlowEdge: string | null;
  subsystems: TelemetrySubsystemStatus[];
  ports: TelemetryPortBinding[];
  endpoints: TelemetryEndpointMetric[];
  recentTraces: TelemetryTraceEvent[];
}
