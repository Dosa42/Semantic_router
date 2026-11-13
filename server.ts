import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ChatGptAuthManager,
  buildPopupCompletionHtml,
  buildPopupErrorHtml,
} from './src/lib/chatgptAuth.ts';
import {
  ENCODER_PROVIDERS,
  ROUTE_PROVIDER_FUNCTIONS,
  executeLocalProviderFunction,
} from './src/lib/providers.ts';
import { TelemetryCollector } from './src/lib/telemetry.ts';
import {
  createLocalVectorLookup,
  evaluateDataset,
  extractDynamicParametersLocal,
  optimizeRouteThresholds,
  scoreRoutes,
  type VectorLookup,
} from './src/lib/routerEngine.ts';
import { DEFAULT_ROUTER_CONFIG, SEED_EVAL_CASES, SEED_ROUTES } from './src/lib/seedData.ts';
import type {
  EncoderModelId,
  EvalCase,
  ExtractedFunctionCall,
  FunctionSchema,
  OpenAiFlowMode,
  ProviderExecutionResult,
  RouteDecisionResult,
  RouteDefinition,
  RouterConfig,
} from './src/lib/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'router-state.json');

interface PersistedState {
  routes: RouteDefinition[];
  evalCases: EvalCase[];
  config: RouterConfig;
}

function migrateLegacyTargetModel(target: string): string {
  if (target === 'gemini-4-hydrogen') return 'openai:chatgpt-flagship';
  if (target === 'gemini-3.1-flash-lite') return 'openai:chatgpt-fast';
  return target;
}

function migrateLegacyEncoder(enc: string | undefined): EncoderModelId {
  if (enc === 'local-subword-bm25') return 'local-subword-bm25';
  return 'e5-small-v2';
}

function loadState(): PersistedState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf-8');
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
        };
        return {
          routes: migratedRoutes,
          evalCases: parsed.evalCases,
          config: migratedConfig,
        };
      }
    }
  } catch {
    // Fallback to deterministic seed state
  }
  return {
    routes: structuredClone(SEED_ROUTES),
    evalCases: structuredClone(SEED_EVAL_CASES),
    config: { ...DEFAULT_ROUTER_CONFIG },
  };
}

function saveState(state: PersistedState): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to persist router state:', err);
  }
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

function resolveAppOrigin(req: express.Request): string {
  const envUrl = (process.env.APP_URL ?? '').trim().replace(/\/+$/, '');
  if (envUrl && envUrl !== 'MY_APP_URL') {
    return envUrl;
  }
  const proto = (req.headers['x-forwarded-proto'] as string)?.split(',')[0] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
  return `${proto}://${host}`;
}

function getOrCreateBrowserSessionId(req: express.Request, res: express.Response): string {
  const cookies = parseCookies(req.headers.cookie);
  const existing = cookies.chatgpt_sid;
  if (existing && existing.length >= 16) return existing;
  const fresh = crypto.randomBytes(18).toString('base64url');
  res.cookie('chatgpt_sid', fresh, {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
  return fresh;
}

// Local HuggingFace E5 ONNX embedding singleton & cache
const e5EmbeddingCache = new Map<string, number[]>();

type FeatureExtractor = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean }
) => Promise<{ tolist: () => number[][] }>;

let e5PipelinePromise: Promise<FeatureExtractor> | null = null;
let e5Status: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
const telemetry = new TelemetryCollector();

async function getE5Extractor(): Promise<FeatureExtractor> {
  if (!e5PipelinePromise) {
    e5Status = 'loading';
    telemetry.notify();
    e5PipelinePromise = (async () => {
      const { pipeline } = await import('@huggingface/transformers');
      const extractor = (await pipeline('feature-extraction', 'Xenova/e5-small-v2', {
        dtype: 'q8',
      })) as unknown as FeatureExtractor;
      e5Status = 'ready';
      telemetry.notify();
      return extractor;
    })().catch((err) => {
      e5Status = 'error';
      e5PipelinePromise = null;
      telemetry.notify();
      throw err;
    });
  }
  return e5PipelinePromise;
}

function collectRouteUtterances(routes: RouteDefinition[]): string[] {
  const texts: string[] = [];
  for (const r of routes) {
    if (!r.enabled) continue;
    for (const u of r.utterances) texts.push(u);
  }
  return texts;
}

async function warmUpE5(routes: RouteDefinition[]): Promise<void> {
  try {
    const passages = collectRouteUtterances(routes).map((u) => `passage: ${u.trim()}`);
    const uniqueMissing = Array.from(new Set(passages)).filter((p) => !e5EmbeddingCache.has(p));
    if (uniqueMissing.length === 0) return;
    const ext = await getE5Extractor();
    for (let i = 0; i < uniqueMissing.length; i += 24) {
      const batch = uniqueMissing.slice(i, i + 24);
      const out = await ext(batch, { pooling: 'mean', normalize: true });
      const vecs = out.tolist();
      batch.forEach((key, idx) => {
        e5EmbeddingCache.set(key, vecs[idx]);
      });
    }
    telemetry.notify();
  } catch (err) {
    console.warn('E5 warmup failed:', (err as Error).message);
  }
}

async function buildVectorLookup(
  queryTexts: string[],
  passageTexts: string[],
  encoderModel: EncoderModelId
): Promise<{
  lookup: VectorLookup;
  encoderUsed: string;
}> {
  if (encoderModel === 'e5-small-v2') {
    try {
      const ext = await getE5Extractor();
      const prefixed = Array.from(
        new Set([
          ...queryTexts.map((q) => `query: ${q.trim()}`),
          ...passageTexts.map((p) => `passage: ${p.trim()}`),
        ])
      ).filter((k) => k.length > 9 && !e5EmbeddingCache.has(k));

      if (prefixed.length > 0) {
        for (let i = 0; i < prefixed.length; i += 24) {
          const batch = prefixed.slice(i, i + 24);
          const out = await ext(batch, { pooling: 'mean', normalize: true });
          const vecs = out.tolist();
          batch.forEach((key, idx) => {
            e5EmbeddingCache.set(key, vecs[idx]);
          });
        }
      }

      const localFallback = createLocalVectorLookup();
      return {
        encoderUsed: 'intfloat/e5-small-v2 (ONNX 384d)',
        lookup: {
          getVector(text: string) {
            return (
              e5EmbeddingCache.get(`query: ${text.trim()}`) ??
              e5EmbeddingCache.get(`passage: ${text.trim()}`) ??
              localFallback.getVector(text)
            );
          },
          getQueryVector(text: string) {
            return e5EmbeddingCache.get(`query: ${text.trim()}`) ?? localFallback.getVector(text);
          },
          getPassageVector(text: string) {
            return e5EmbeddingCache.get(`passage: ${text.trim()}`) ?? localFallback.getVector(text);
          },
        },
      };
    } catch (err) {
      console.warn('E5 encoder fallback to local subword:', (err as Error).message);
    }
  }

  return {
    lookup: createLocalVectorLookup(),
    encoderUsed: 'Local Subword + BM25 Hybrid',
  };
}

async function startServer() {
  const PORT = Number(process.env.PORT) || 3000;
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const chatgptAuth = new ChatGptAuthManager(__dirname);
  let state = loadState();
  saveState(state);

  let isEvaluatingOrFitting = false;
  let lastOpenAiError: string | null = null;
  let lastOpenAiLatencyMs: number | null = null;
  let lastRouterError: string | null = null;
  let lastRouteLatencyMs: number | null = null;
  let lastEmbedLatencyMs: number | null = null;

  telemetry.attachStateProvider(() => {
    const activeProfile = chatgptAuth.getActiveProfile();
    const loopback = chatgptAuth.getLoopbackRuntimeStatus();
    return {
      expressPort: PORT,
      chatGptConnected: Boolean(activeProfile?.connected),
      chatGptSharing: Boolean(activeProfile?.sharing),
      chatGptEmail: activeProfile?.email ?? activeProfile?.subject ?? null,
      pendingAuthCount: loopback.pendingOAuthCount + loopback.pendingDeviceCount,
      lastOpenAiError,
      lastOpenAiLatencyMs,
      activeRouteCount: state.routes.filter((r) => r.enabled).length,
      totalRouteCount: state.routes.length,
      isEvaluatingOrFitting,
      lastRouterError,
      lastRouteLatencyMs,
      encoderModel: state.config.encoderModel,
      e5Status,
      e5CachedCount: e5EmbeddingCache.size,
      lastEmbedLatencyMs,
      loopbackListening: loopback.listening,
      loopbackPort: loopback.port,
    };
  });

  // Live API & OAuth telemetry interceptor (excludes /api/telemetry* to avoid recursion)
  app.use((req, res, next) => {
    const reqPath = req.path || req.originalUrl || '/';
    const isMonitored =
      (reqPath.startsWith('/api/') && !reqPath.startsWith('/api/telemetry')) ||
      reqPath.startsWith('/auth/');
    if (!isMonitored) {
      next();
      return;
    }

    const startNs = process.hrtime.bigint();
    let capturedBody: unknown = null;
    const origJson = res.json.bind(res);
    res.json = ((body?: unknown) => {
      capturedBody = body;
      return origJson(body);
    }) as typeof res.json;

    const origSend = res.send.bind(res);
    res.send = ((body?: unknown) => {
      if (capturedBody === null) {
        if (typeof body === 'string') {
          capturedBody = body.startsWith('<!doctype') || body.startsWith('<html')
            ? { htmlResponse: true, bytes: body.length }
            : body;
        } else {
          capturedBody = body ?? null;
        }
      }
      return origSend(body);
    }) as typeof res.send;

    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
      telemetry.recordHttpEvent({
        method: req.method,
        path: reqPath,
        status: res.statusCode,
        durationMs,
        requestBody:
          req.method !== 'GET' && req.body && Object.keys(req.body).length > 0
            ? req.body
            : Object.keys(req.query ?? {}).length > 0
              ? { query: req.query }
              : null,
        responseBody: capturedBody,
      });
    });

    next();
  });

  async function executeProviderFunction(
    providerId: string,
    args: Record<string, unknown>,
    query: string
  ): Promise<ProviderExecutionResult> {
    const startNs = process.hrtime.bigint();
    const isOpenAiLlm =
      providerId === 'openai:chatgpt-flagship' || providerId === 'openai:chatgpt-fast';

    if (isOpenAiLlm) {
      const activeProfile = chatgptAuth.getActiveProfile();
      if (activeProfile && activeProfile.sharing) {
        try {
          const pref = providerId === 'openai:chatgpt-fast' ? 'fast' : 'flagship';
          const result = await chatgptAuth.streamResponses({
            profileId: activeProfile.profileId,
            preference: pref,
            input: query,
            instructions:
              'You are a concise backend execution target dispatched by Semantic Router. Reply directly and accurately.',
            timeoutMs: 12_000,
          });
          const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
          lastOpenAiError = null;
          lastOpenAiLatencyMs = Math.round(elapsedMs * 100) / 100;
          return {
            providerId,
            providerKind: 'llm',
            handlerName:
              pref === 'fast' ? 'executeChatGptFastProvider' : 'executeChatGptFlagshipProvider',
            latencyMs: lastOpenAiLatencyMs,
            status: 'ok',
            output: {
              model: result.model,
              account: activeProfile.email ?? activeProfile.subject,
              responseText: result.text,
            },
          };
        } catch (err) {
          lastOpenAiError = (err as Error).message;
          console.warn(`OpenAI Responses execution error (${providerId}):`, (err as Error).message);
        }
      }
    }

    const localRes = executeLocalProviderFunction(providerId, args, query);
    const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
    return {
      ...localRes,
      latencyMs: Math.round(elapsedMs * 100) / 100,
    };
  }

  async function extractDynamicParameters(
    query: string,
    schema: FunctionSchema
  ): Promise<ExtractedFunctionCall> {
    const activeProfile = chatgptAuth.getActiveProfile();
    if (activeProfile && activeProfile.sharing) {
      try {
        const paramSpec = schema.parameters
          .map((p) => `${p.name} (${p.type}${p.required ? ', required' : ''}): ${p.description}`)
          .join('\n');
        const res = await chatgptAuth.streamResponses({
          profileId: activeProfile.profileId,
          preference: 'fast',
          instructions:
            'Extract JSON function arguments strictly matching the schema. Return ONLY raw valid JSON object with keys matching parameter names.',
          input: `Function: ${schema.name}\nDescription: ${schema.description}\nParameters:\n${paramSpec}\n\nUser prompt: ${query}`,
          timeoutMs: 5000,
        });
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
        console.warn('OpenAI parameter extraction fallback:', (err as Error).message);
      }
    }
    return extractDynamicParametersLocal(query, schema);
  }

  // --- Sign in with ChatGPT (OpenAI OAuth2 + PKCE + OIDC) endpoints ---

  app.get('/api/auth/openai/session', (req, res) => {
    getOrCreateBrowserSessionId(req, res);
    const origin = resolveAppOrigin(req);
    res.json({
      hostId: chatgptAuth.getHostId(),
      configuredClientId: chatgptAuth.getConfiguredClientId(),
      defaultFlowMode: chatgptAuth.getDefaultFlowMode(),
      appUrl: (process.env.APP_URL ?? '').trim() || null,
      webCallbackUrl: `${origin}/auth/openai/callback`,
      activeProfileId: chatgptAuth.getActiveProfile()?.profileId ?? null,
      activeProfile: chatgptAuth.getActiveProfile(),
      profiles: chatgptAuth.listProfiles(),
    });
  });

  app.post('/api/auth/openai/preview', async (req, res) => {
    try {
      const origin = resolveAppOrigin(req);
      const body = (req.body ?? {}) as {
        flowMode?: OpenAiFlowMode;
        profileId?: string | null;
        clientIdOverride?: string | null;
      };
      const flowMode: OpenAiFlowMode =
        body.flowMode === 'website_client' ||
        body.flowMode === 'device_code' ||
        body.flowMode === 'dynamic_agent'
          ? body.flowMode
          : chatgptAuth.getDefaultFlowMode();

      const preview = await chatgptAuth.previewAuthorizationRequest({
        webCallbackUrl: `${origin}/auth/openai/callback`,
        flowMode,
        profileId: body.profileId ?? null,
        clientIdOverride: body.clientIdOverride ?? null,
      });
      res.json(preview);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get('/api/auth/openai/url', async (req, res) => {
    try {
      const browserSessionId = getOrCreateBrowserSessionId(req, res);
      const origin = resolveAppOrigin(req);
      const flowMode =
        req.query.flowMode === 'website_client' ||
        req.query.flowMode === 'device_code' ||
        req.query.flowMode === 'dynamic_agent'
          ? (req.query.flowMode as OpenAiFlowMode)
          : undefined;
      const profileId = typeof req.query.profileId === 'string' ? req.query.profileId : null;
      const clientIdOverride =
        typeof req.query.clientIdOverride === 'string' ? req.query.clientIdOverride : null;
      const useLoopback = req.query.useLoopback !== 'false';

      const started = await chatgptAuth.createAuthorizationRequest({
        browserSessionId,
        webCallbackUrl: `${origin}/auth/openai/callback`,
        flowMode,
        profileId,
        clientIdOverride,
        useLoopback,
      });
      res.json(started);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/auth/openai/start', async (req, res) => {
    try {
      const browserSessionId = getOrCreateBrowserSessionId(req, res);
      const origin = resolveAppOrigin(req);
      const body = (req.body ?? {}) as {
        flowMode?: OpenAiFlowMode;
        profileId?: string | null;
        clientIdOverride?: string | null;
        useLoopback?: boolean;
      };
      const started = await chatgptAuth.createAuthorizationRequest({
        browserSessionId,
        webCallbackUrl: `${origin}/auth/openai/callback`,
        flowMode: body.flowMode,
        profileId: body.profileId ?? null,
        clientIdOverride: body.clientIdOverride ?? null,
        useLoopback: body.useLoopback !== false,
      });
      res.json(started);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/auth/openai/device/start', async (req, res) => {
    try {
      getOrCreateBrowserSessionId(req, res);
      const body = (req.body ?? {}) as { clientIdOverride?: string | null };
      const deviceSession = await chatgptAuth.startDeviceCodeAuth({
        clientIdOverride: body.clientIdOverride ?? null,
      });
      res.json(deviceSession);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/auth/openai/device/poll', async (req, res) => {
    const body = (req.body ?? {}) as { deviceAuthId?: string };
    const id = (body.deviceAuthId ?? '').trim();
    if (!id) {
      res.status(400).json({ status: 'error', error: 'deviceAuthId is required.' });
      return;
    }
    const result = await chatgptAuth.pollDeviceCodeAuth(id);
    res.json(result);
  });

  const handleOAuthCallback: express.RequestHandler = async (req, res) => {
    try {
      const profile = await chatgptAuth.completeAuthorizationCallback({
        code: typeof req.query.code === 'string' ? req.query.code : undefined,
        state: typeof req.query.state === 'string' ? req.query.state : undefined,
        clientId: typeof req.query.client_id === 'string' ? req.query.client_id : undefined,
        error: typeof req.query.error === 'string' ? req.query.error : undefined,
        errorDescription:
          typeof req.query.error_description === 'string'
            ? req.query.error_description
            : undefined,
      });
      res.status(200).type('html').send(buildPopupCompletionHtml(profile, '*'));
    } catch (err) {
      res.status(400).type('html').send(buildPopupErrorHtml((err as Error).message));
    }
  };

  app.get(
    ['/auth/openai/callback', '/auth/openai/callback/', '/auth/callback', '/auth/callback/'],
    handleOAuthCallback
  );

  app.post('/api/auth/openai/complete-redirect', async (req, res) => {
    try {
      const body = (req.body ?? {}) as { redirectUrl?: string };
      const rawUrl = (body.redirectUrl ?? '').trim();
      if (!rawUrl) {
        res.status(400).json({ error: 'Redirect callback URL is required.' });
        return;
      }
      const parsed = new URL(rawUrl);
      const profile = await chatgptAuth.completeAuthorizationCallback({
        code: parsed.searchParams.get('code') ?? undefined,
        state: parsed.searchParams.get('state') ?? undefined,
        clientId: parsed.searchParams.get('client_id') ?? undefined,
        error: parsed.searchParams.get('error') ?? undefined,
        errorDescription: parsed.searchParams.get('error_description') ?? undefined,
      });
      res.json({
        profile,
        profiles: chatgptAuth.listProfiles(),
        activeProfileId: profile.profileId,
      });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/auth/openai/select', (req, res) => {
    const body = (req.body ?? {}) as { profileId?: string };
    const profile = body.profileId ? chatgptAuth.selectProfile(body.profileId) : null;
    if (!profile) {
      res.status(404).json({ error: 'Selected ChatGPT profile not found.' });
      return;
    }
    res.json({
      activeProfile: profile,
      activeProfileId: profile.profileId,
      profiles: chatgptAuth.listProfiles(),
    });
  });

  app.post('/api/auth/openai/logout', async (req, res) => {
    const body = (req.body ?? {}) as { profileId?: string; removeProfile?: boolean };
    await chatgptAuth.logout(body.profileId, Boolean(body.removeProfile));
    res.json({
      activeProfile: chatgptAuth.getActiveProfile(),
      activeProfileId: chatgptAuth.getActiveProfile()?.profileId ?? null,
      profiles: chatgptAuth.listProfiles(),
    });
  });

  app.get('/api/auth/openai/models', async (_req, res) => {
    try {
      const models = await chatgptAuth.listModels();
      res.json({ models });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message, models: [] });
    }
  });

  app.post('/api/auth/openai/verify', async (req, res) => {
    try {
      const body = (req.body ?? {}) as { model?: string };
      const result = await chatgptAuth.streamResponses({
        model: body.model,
        preference: 'flagship',
        input: 'Reply with exactly: Token sharing works.',
        timeoutMs: 12_000,
      });
      res.json({
        ok: true,
        model: result.model,
        text: result.text,
      });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  });

  // --- Semantic Router API routes ---

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      routeCount: state.routes.length,
      chatGptConnected: Boolean(chatgptAuth.getActiveProfile()?.connected),
    });
  });

  app.get('/api/routes', (_req, res) => {
    res.json({
      routes: state.routes,
      evalCases: state.evalCases,
      config: state.config,
    });
  });

  app.post('/api/routes', (req, res) => {
    const body = req.body as Partial<RouteDefinition>;
    const name = (body.name ?? '').trim();
    const utterances = Array.isArray(body.utterances)
      ? body.utterances.map((u) => String(u).trim()).filter(Boolean)
      : [];

    if (!name) {
      res.status(400).json({ error: 'Route name is required.' });
      return;
    }
    if (utterances.length === 0) {
      res.status(400).json({ error: 'At least one example utterance is required.' });
      return;
    }
    if (state.routes.some((r) => r.name.toLowerCase() === name.toLowerCase())) {
      res.status(409).json({ error: `Route "${name}" already exists.` });
      return;
    }

    const newRoute: RouteDefinition = {
      id: `route-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name,
      description: (body.description ?? '').trim() || `Semantic route for ${name}`,
      utterances,
      scoreThreshold:
        typeof body.scoreThreshold === 'number'
          ? Math.max(0.05, Math.min(0.99, body.scoreThreshold))
          : state.config.defaultThreshold,
      routeType: body.routeType === 'dynamic' ? 'dynamic' : 'static',
      targetModel: (body.targetModel ?? '').trim() || 'openai:chatgpt-flagship',
      enabled: body.enabled !== false,
      functionSchema:
        body.routeType === 'dynamic' && body.functionSchema
          ? body.functionSchema
          : undefined,
      createdAt: new Date().toISOString(),
    };

    state.routes = [newRoute, ...state.routes];
    saveState(state);
    res.status(201).json({ route: newRoute });
  });

  app.put('/api/routes/:id', (req, res) => {
    const { id } = req.params;
    const idx = state.routes.findIndex((r) => r.id === id);
    if (idx === -1) {
      res.status(404).json({ error: 'Route not found.' });
      return;
    }

    const body = req.body as Partial<RouteDefinition>;
    const existing = state.routes[idx];

    const updatedName = body.name !== undefined ? body.name.trim() : existing.name;
    if (!updatedName) {
      res.status(400).json({ error: 'Route name cannot be empty.' });
      return;
    }

    const updatedUtterances =
      body.utterances !== undefined
        ? body.utterances.map((u) => String(u).trim()).filter(Boolean)
        : existing.utterances;

    if (updatedUtterances.length === 0) {
      res.status(400).json({ error: 'At least one utterance is required.' });
      return;
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
    };

    state.routes[idx] = updated;
    saveState(state);
    res.json({ route: updated });
  });

  app.delete('/api/routes/:id', (req, res) => {
    const { id } = req.params;
    const beforeLen = state.routes.length;
    state.routes = state.routes.filter((r) => r.id !== id);
    if (state.routes.length === beforeLen) {
      res.status(404).json({ error: 'Route not found.' });
      return;
    }
    saveState(state);
    res.json({ deletedId: id });
  });

  app.put('/api/config', (req, res) => {
    const body = req.body as Partial<RouterConfig> & { calibrateThresholds?: boolean };
    const prevEncoder = state.config.encoderModel;
    const nextEncoder = migrateLegacyEncoder(body.encoderModel ?? state.config.encoderModel);
    const providerMeta = ENCODER_PROVIDERS.find((p) => p.id === nextEncoder);

    state.config = {
      mode: body.mode ?? state.config.mode,
      alpha:
        typeof body.alpha === 'number'
          ? Math.max(0, Math.min(1, body.alpha))
          : state.config.alpha,
      aggregation: body.aggregation ?? state.config.aggregation,
      defaultThreshold:
        typeof body.defaultThreshold === 'number'
          ? Math.max(0.05, Math.min(0.99, body.defaultThreshold))
          : body.calibrateThresholds && providerMeta
            ? providerMeta.recommendedThreshold
            : state.config.defaultThreshold,
      encoderModel: nextEncoder,
    };

    if (body.calibrateThresholds && prevEncoder !== nextEncoder && providerMeta) {
      state.routes = state.routes.map((r) => ({
        ...r,
        scoreThreshold: providerMeta.recommendedThreshold,
      }));
    }

    saveState(state);
    res.json({ config: state.config, routes: state.routes });
  });

  app.get('/api/providers', (_req, res) => {
    res.json({
      activeEncoder: state.config.encoderModel,
      e5Status,
      e5CachedCount: e5EmbeddingCache.size,
      encoders: ENCODER_PROVIDERS,
      routeFunctions: ROUTE_PROVIDER_FUNCTIONS,
    });
  });

  // --- Live Telemetry & Monitoring API + SSE Stream ---

  app.get('/api/telemetry', (_req, res) => {
    res.json(telemetry.getSnapshot());
  });

  app.get('/api/telemetry/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const sendSnapshot = (snap: ReturnType<typeof telemetry.getSnapshot>) => {
      res.write(`data: ${JSON.stringify(snap)}\n\n`);
    };

    sendSnapshot(telemetry.getSnapshot());
    const unsubscribe = telemetry.subscribe(sendSnapshot);
    const keepAlive = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 15_000);

    req.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
      res.end();
    });
  });

  app.post('/api/telemetry/probe', async (_req, res) => {
    const embedStart = process.hrtime.bigint();
    try {
      const probeText = 'health probe embedding check';
      await buildVectorLookup([probeText], [], state.config.encoderModel);
      lastEmbedLatencyMs =
        Math.round((Number(process.hrtime.bigint() - embedStart) / 1_000_000) * 100) / 100;
    } catch (err) {
      console.warn('Probe embedding warning:', (err as Error).message);
    }
    telemetry.notify();
    res.json(telemetry.getSnapshot());
  });

  app.post('/api/providers/embed-test', async (req, res) => {
    const body = req.body as { text?: string; encoderModel?: EncoderModelId };
    const text = (body.text ?? '').trim() || 'What time is it in Tokyo right now?';
    const encoderModel = migrateLegacyEncoder(body.encoderModel ?? state.config.encoderModel);
    const startNs = process.hrtime.bigint();
    const { lookup, encoderUsed } = await buildVectorLookup([text], [], encoderModel);
    const vec = lookup.getQueryVector ? lookup.getQueryVector(text) : lookup.getVector(text);
    const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
    lastEmbedLatencyMs = Math.round(elapsedMs * 100) / 100;
    res.json({
      text,
      encoderModel,
      encoderUsed,
      dimensions: vec.length,
      preview: vec.slice(0, 8).map((v) => Math.round(v * 10000) / 10000),
      latencyMs: lastEmbedLatencyMs,
    });
  });

  app.post('/api/providers/execute', async (req, res) => {
    const body = req.body as {
      providerId?: string;
      arguments?: Record<string, unknown>;
      query?: string;
    };
    const providerId = (body.providerId ?? '').trim() || 'fallback-none';
    const result = await executeProviderFunction(
      providerId,
      body.arguments ?? {},
      (body.query ?? '').trim() || 'Sample test invocation'
    );
    res.json(result);
  });

  app.post('/api/route', async (req, res) => {
    const body = req.body as {
      query?: string;
      mode?: RouterConfig['mode'];
      alpha?: number;
      aggregation?: RouterConfig['aggregation'];
      encoderModel?: EncoderModelId;
      executeProvider?: boolean;
    };

    const query = (body.query ?? '').trim();
    if (!query) {
      res.status(400).json({ error: 'Prompt query is required.' });
      return;
    }

    const activeConfig: RouterConfig = {
      ...state.config,
      ...(body.mode ? { mode: body.mode } : {}),
      ...(typeof body.alpha === 'number' ? { alpha: body.alpha } : {}),
      ...(body.aggregation ? { aggregation: body.aggregation } : {}),
      ...(body.encoderModel ? { encoderModel: migrateLegacyEncoder(body.encoderModel) } : {}),
    };

    const startNs = process.hrtime.bigint();
    const passages = collectRouteUtterances(state.routes);
    const embedStartNs = process.hrtime.bigint();
    const { lookup, encoderUsed } =
      activeConfig.mode === 'sparse'
        ? { lookup: createLocalVectorLookup(), encoderUsed: 'Sparse BM25 / Lexical' }
        : await buildVectorLookup([query], passages, activeConfig.encoderModel);
    lastEmbedLatencyMs =
      Math.round((Number(process.hrtime.bigint() - embedStartNs) / 1_000_000) * 100) / 100;

    const scored = scoreRoutes(query, state.routes, activeConfig, lookup);
    let functionCall: ExtractedFunctionCall | null = null;
    if (
      scored.matchedRoute &&
      scored.matchedRoute.routeType === 'dynamic' &&
      scored.matchedRoute.functionSchema
    ) {
      functionCall = await extractDynamicParameters(
        query,
        scored.matchedRoute.functionSchema
      );
    }

    let providerExecution: ProviderExecutionResult | null = null;
    if (body.executeProvider !== false) {
      const targetProvider = scored.matchedRoute?.targetModel ?? 'fallback-none';
      const args = functionCall?.arguments ?? {};
      providerExecution = await executeProviderFunction(targetProvider, args, query);
    }

    const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
    lastRouteLatencyMs = Math.round(elapsedMs * 100) / 100;
    lastRouterError = null;

    const decision: RouteDecisionResult = {
      query,
      matchedRoute: scored.matchedRoute ? scored.matchedRoute.name : null,
      matchedRouteId: scored.matchedRoute ? scored.matchedRoute.id : null,
      matchedRouteType: scored.matchedRoute ? scored.matchedRoute.routeType : null,
      targetModel: scored.matchedRoute ? scored.matchedRoute.targetModel : null,
      topScore: scored.topScore,
      thresholdUsed: scored.matchedRoute
        ? scored.matchedRoute.scoreThreshold
        : scored.allScores[0]?.threshold ?? null,
      latencyMs: lastRouteLatencyMs,
      encoderUsed,
      mode: activeConfig.mode,
      alpha: activeConfig.alpha,
      aggregation: activeConfig.aggregation,
      functionCall,
      providerExecution,
      allScores: scored.allScores,
    };

    res.json(decision);
  });

  app.post('/api/evaluate', async (_req, res) => {
    isEvaluatingOrFitting = true;
    telemetry.notify();
    try {
      const queryTexts = state.evalCases.map((c) => c.query);
      const passageTexts = collectRouteUtterances(state.routes);
      const { lookup, encoderUsed } =
        state.config.mode === 'sparse'
          ? { lookup: createLocalVectorLookup(), encoderUsed: 'Sparse BM25 / Lexical' }
          : await buildVectorLookup(queryTexts, passageTexts, state.config.encoderModel);

      const report = evaluateDataset(
        state.evalCases,
        state.routes,
        state.config,
        lookup,
        encoderUsed
      );
      res.json(report);
    } finally {
      isEvaluatingOrFitting = false;
      telemetry.notify();
    }
  });

  app.post('/api/fit', async (_req, res) => {
    isEvaluatingOrFitting = true;
    telemetry.notify();
    try {
      const queryTexts = state.evalCases.map((c) => c.query);
      const passageTexts = collectRouteUtterances(state.routes);
      const { lookup } =
        state.config.mode === 'sparse'
          ? { lookup: createLocalVectorLookup() }
          : await buildVectorLookup(queryTexts, passageTexts, state.config.encoderModel);

      const fitReport = optimizeRouteThresholds(
        state.evalCases,
        state.routes,
        state.config,
        lookup
      );
      state.routes = fitReport.updatedRoutes;
      saveState(state);
      res.json(fitReport);
    } finally {
      isEvaluatingOrFitting = false;
      telemetry.notify();
    }
  });

  app.post('/api/eval-cases', (req, res) => {
    const body = req.body as { query?: string; expectedRoute?: string | null };
    const query = (body.query ?? '').trim();
    if (!query) {
      res.status(400).json({ error: 'Evaluation query is required.' });
      return;
    }
    const newCase: EvalCase = {
      id: `eval-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      query,
      expectedRoute: body.expectedRoute ? body.expectedRoute.trim() : null,
    };
    state.evalCases = [newCase, ...state.evalCases];
    saveState(state);
    res.status(201).json({ evalCase: newCase });
  });

  app.delete('/api/eval-cases/:id', (req, res) => {
    const { id } = req.params;
    const before = state.evalCases.length;
    state.evalCases = state.evalCases.filter((c) => c.id !== id);
    if (state.evalCases.length === before) {
      res.status(404).json({ error: 'Evaluation case not found.' });
      return;
    }
    saveState(state);
    res.json({ deletedId: id });
  });

  app.post('/api/reset', (_req, res) => {
    state = {
      routes: structuredClone(SEED_ROUTES),
      evalCases: structuredClone(SEED_EVAL_CASES),
      config: { ...DEFAULT_ROUTER_CONFIG },
    };
    saveState(state);
    res.json(state);
  });

  // Vite dev middleware vs production static serving
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.join(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Semantic Router Studio listening on http://0.0.0.0:${PORT}`);
    void warmUpE5(state.routes);
  });
}

startServer();
