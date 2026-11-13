import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ChatGptAuthManager,
  buildPopupCompletionHtml,
  buildPopupErrorHtml,
} from './src/lib/chatgptAuth.ts';
import { invokeSingleMcpJsonRpc } from './src/lib/mcpServer.ts';
import { ROUTE_PROVIDER_FUNCTIONS } from './src/lib/providers.ts';
import { UnifiedRouterService } from './src/lib/routerService.ts';
import { DEFAULT_SYSTEM_INSTRUCTIONS } from './src/lib/seedData.ts';
import { TelemetryCollector } from './src/lib/telemetry.ts';
import type {
  EncoderModelId,
  LibraryKnowledgeState,
  OpenAiFlowMode,
  ProjectMilestone,
  RagConnector,
  RedTeamCampaignOptions,
  RouteDefinition,
  RouterConfig,
  SystemInstructionsConfig,
} from './src/lib/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  const proto =
    (req.headers['x-forwarded-proto'] as string)?.split(',')[0] || req.protocol || 'http';
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

async function startServer() {
  const PORT = Number(process.env.PORT) || 3000;
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const telemetry = new TelemetryCollector();
  const chatgptAuth = new ChatGptAuthManager(__dirname);
  const service = new UnifiedRouterService(__dirname, chatgptAuth, telemetry);

  telemetry.attachStateProvider(() => service.getTelemetryStateInput(PORT));

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
    const endBrowserEdge = telemetry.beginSpan('browser->express');
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
          capturedBody =
            body.startsWith('<!doctype') || body.startsWith('<html')
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
      endBrowserEdge(res.statusCode >= 400 ? 'error' : 'ok');
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
      if (started.flowMode === 'dynamic_agent') {
        telemetry.recordPulse('chatgpt->loopback', 1.2, 'ok');
      }
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
      if (started.flowMode === 'dynamic_agent') {
        telemetry.recordPulse('chatgpt->loopback', 1.2, 'ok');
      }
      res.json(started);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/auth/openai/device/start', async (req, res) => {
    try {
      getOrCreateBrowserSessionId(req, res);
      const body = (req.body ?? {}) as { clientIdOverride?: string | null };
      const endAuth = telemetry.beginSpan('router->chatgpt');
      try {
        const deviceSession = await chatgptAuth.startDeviceCodeAuth({
          clientIdOverride: body.clientIdOverride ?? null,
        });
        endAuth('ok');
        res.json(deviceSession);
      } catch (err) {
        endAuth('error');
        throw err;
      }
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
    const endLoopback = telemetry.beginSpan('chatgpt->loopback');
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
      endLoopback('ok');
      res.status(200).type('html').send(buildPopupCompletionHtml(profile, '*'));
    } catch (err) {
      endLoopback('error');
      res.status(400).type('html').send(buildPopupErrorHtml((err as Error).message));
    }
  };

  app.get(
    ['/auth/openai/callback', '/auth/openai/callback/', '/auth/callback', '/auth/callback/'],
    handleOAuthCallback
  );

  app.post('/api/auth/openai/complete-redirect', async (req, res) => {
    const endLoopback = telemetry.beginSpan('chatgpt->loopback');
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
      endLoopback('ok');
      res.json({
        profile,
        profiles: chatgptAuth.listProfiles(),
        activeProfileId: profile.profileId,
      });
    } catch (err) {
      endLoopback('error');
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
    const endGpt = telemetry.beginSpan('router->chatgpt');
    try {
      const models = await chatgptAuth.listModels();
      endGpt('ok');
      res.json({ models });
    } catch (err) {
      endGpt('error');
      res.status(400).json({ error: (err as Error).message, models: [] });
    }
  });

  app.post('/api/auth/openai/verify', async (req, res) => {
    const endGpt = telemetry.beginSpan('router->chatgpt');
    try {
      const body = (req.body ?? {}) as { model?: string };
      const result = await chatgptAuth.streamResponses({
        model: body.model,
        preference: 'flagship',
        input: 'Reply with exactly: Token sharing works.',
        timeoutMs: 12_000,
      });
      endGpt('ok');
      res.json({
        ok: true,
        model: result.model,
        text: result.text,
      });
    } catch (err) {
      endGpt('error');
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  });

  // --- Semantic Router & Unified RAG API routes ---

  app.get('/api/health', (_req, res) => {
    const data = service.getWorkspaceData();
    res.json({
      ok: true,
      routeCount: data.routes.length,
      ragConnectorCount: data.ragConnectors.length,
      ragChunksCount: data.ragChunksCount,
      mcpEnabled: data.config.mcpEnabled,
      chatGptConnected: Boolean(chatgptAuth.getActiveProfile()?.connected),
    });
  });

  app.get('/api/routes', (_req, res) => {
    res.json(service.getWorkspaceData());
  });

  app.post('/api/routes', (req, res) => {
    try {
      const route = service.createRoute(req.body as Partial<RouteDefinition>);
      res.status(201).json({ route });
    } catch (err) {
      const status = (err as Error & { status?: number }).status ?? 400;
      res.status(status).json({ error: (err as Error).message });
    }
  });

  app.put('/api/routes/:id', (req, res) => {
    try {
      const route = service.updateRoute(req.params.id, req.body as Partial<RouteDefinition>);
      res.json({ route });
    } catch (err) {
      const status = (err as Error & { status?: number }).status ?? 400;
      res.status(status).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/routes/:id', (req, res) => {
    const deleted = service.deleteRoute(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Route not found.' });
      return;
    }
    res.json({ deletedId: req.params.id });
  });

  app.put('/api/config', (req, res) => {
    const body = req.body as Partial<RouterConfig> & { calibrateThresholds?: boolean };
    res.json(service.updateConfig(body));
  });

  // --- Dual System Instructions API ---

  app.get('/api/instructions', (_req, res) => {
    res.json({ instructions: service.getInstructions() });
  });

  app.put('/api/instructions', (req, res) => {
    const body = req.body as Partial<SystemInstructionsConfig>;
    const instructions = service.updateInstructions(body);
    res.json({ instructions });
  });

  app.post('/api/instructions/reset', (_req, res) => {
    const instructions = service.updateInstructions(structuredClone(DEFAULT_SYSTEM_INSTRUCTIONS));
    res.json({ instructions });
  });

  app.post('/api/embeddings/rewarm', async (_req, res) => {
    await service.warmUpEmbeddings();
    res.json({ ok: true, ...service.getProvidersMetadata() });
  });

  // --- EM-3 Project Progress Tracker & Shared Agent State API ---

  app.get('/api/progress', (_req, res) => {
    res.json({
      progressState: service.getProgressState(),
      agentState: service.getAgentStateSnapshot(),
    });
  });

  app.put('/api/progress/milestones', async (req, res) => {
    try {
      const body = (req.body ?? {}) as { milestones?: ProjectMilestone[] };
      const milestones = Array.isArray(body.milestones) ? body.milestones : [];
      const progressState = await service.setMilestones(milestones);
      res.json({
        progressState,
        agentState: service.getAgentStateSnapshot(),
      });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/progress/evaluate', async (req, res) => {
    try {
      const body = (req.body ?? {}) as { outputText?: string };
      const outputText = (body.outputText ?? '').trim();
      if (!outputText) {
        res.status(400).json({ error: 'outputText is required.' });
        return;
      }
      const result = await service.evaluateProgressOutput(outputText);
      res.json({
        progressState: result.state,
        newlyCompleted: result.newlyCompleted,
        autoAdvanceRoute: result.autoAdvanceRoute,
        agentState: result.agentState,
      });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get('/api/agent-state', (_req, res) => {
    res.json({ agentState: service.getAgentStateSnapshot() });
  });

  app.post('/api/agent-state/clear-override', (_req, res) => {
    res.json({ agentState: service.clearAgentRouteOverride() });
  });

  // --- Architecture Library Knowledge API ---

  app.get('/api/knowledge', (_req, res) => {
    res.json({ knowledge: service.getLibraryKnowledge() });
  });

  app.put('/api/knowledge', (req, res) => {
    const body = (req.body ?? {}) as Partial<LibraryKnowledgeState>;
    const knowledge = service.updateLibraryKnowledge(body);
    res.json({ knowledge });
  });

  app.post('/api/knowledge/reset', (_req, res) => {
    const knowledge = service.resetLibraryKnowledge();
    res.json({ knowledge });
  });

  // --- Autonomous Red-Team Bot & Guardrail Hardener API ---

  app.post('/api/redteam/run', async (req, res) => {
    try {
      const options = (req.body ?? {}) as RedTeamCampaignOptions;
      const report = await service.runRedTeamCampaign(options);
      res.json({ report });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/redteam/history', (_req, res) => {
    res.json({ history: service.getRedTeamHistory() });
  });

  app.post('/api/redteam/apply-patch', (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        targetRouteName?: string;
        suggestedUtterances?: string[];
      };
      if (!body.targetRouteName || !Array.isArray(body.suggestedUtterances)) {
        res.status(400).json({
          error: 'targetRouteName and suggestedUtterances array are required.',
        });
        return;
      }
      const result = service.applyGuardrailPatch(
        body.targetRouteName,
        body.suggestedUtterances
      );
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get('/api/frida/scripts', (_req, res) => {
    try {
      const fridaDir = path.join(__dirname, 'frida');
      const onnxHook = fs.existsSync(path.join(fridaDir, 'onnx_hook.js'))
        ? fs.readFileSync(path.join(fridaDir, 'onnx_hook.js'), 'utf-8')
        : '';
      const trinityHook = fs.existsSync(path.join(fridaDir, 'trinity_socket_hook.js'))
        ? fs.readFileSync(path.join(fridaDir, 'trinity_socket_hook.js'), 'utf-8')
        : '';
      const runner = fs.existsSync(path.join(fridaDir, 'run_instrumentation.sh'))
        ? fs.readFileSync(path.join(fridaDir, 'run_instrumentation.sh'), 'utf-8')
        : '';
      const readme = fs.existsSync(path.join(fridaDir, 'README.md'))
        ? fs.readFileSync(path.join(fridaDir, 'README.md'), 'utf-8')
        : '';

      res.json({
        scripts: {
          onnxHook,
          trinityHook,
          runner,
          readme,
        },
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // --- Unified RAG Server & External Webhook/URL Connectors ---

  app.get('/api/rag/demo-webhook', (_req, res) => {
    res.json({
      source: 'Semantic Router Studio Built-in Knowledge Webhook',
      updatedAt: new Date().toISOString(),
      documents: [
        {
          title: 'Aurelio Semantic Router Hybrid Scoring',
          content:
            'Semantic Router Studio blends dense bi-encoder cosine similarity (intfloat/e5-small-v2 384-dim) with sparse BM25/IDF token similarity using configurable alpha weighting and max/mean/top_k_mean aggregation.',
        },
        {
          title: 'SQL Analytics Optimization Best Practices',
          content:
            'For PostgreSQL analytical workloads, composite B-Tree indexes should order high-selectivity equality predicates first, followed by range/window partition columns. Window functions like ROW_NUMBER() and SUM() OVER (PARTITION BY ...) avoid self-joins.',
        },
        {
          title: 'MCP Stdio & Unified RAG Transport',
          content:
            'The unified Semantic Router & RAG Server exposes identical route_prompt, rag_retrieve, and sync_rag_connector capabilities over both HTTP (/api/*) and Model Context Protocol (stdin/stdout JSON-RPC 2.0).',
        },
        {
          title: 'Billing Refund Policy & Order Validation',
          content:
            'Duplicate credit card charges referencing order identifiers (ORD-XXXX or INV-XXX) qualify for automated review tickets via process_billing_refund when a valid reason is provided.',
        },
      ],
    });
  });

  app.get('/api/rag/connectors', (_req, res) => {
    res.json({
      connectors: service.getRagConnectors(),
      chunks: service.getRagChunks(),
    });
  });

  app.post('/api/rag/connectors', (req, res) => {
    try {
      const connector = service.createRagConnector(req.body as Partial<RagConnector>);
      res.status(201).json({ connector });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.put('/api/rag/connectors/:id', (req, res) => {
    try {
      const connector = service.updateRagConnector(
        req.params.id,
        req.body as Partial<RagConnector>
      );
      res.json({ connector });
    } catch (err) {
      const status = (err as Error & { status?: number }).status ?? 400;
      res.status(status).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/rag/connectors/:id', (req, res) => {
    const deleted = service.deleteRagConnector(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'RAG connector not found.' });
      return;
    }
    res.json({ deletedId: req.params.id });
  });

  app.post('/api/rag/connectors/:id/sync', async (req, res) => {
    try {
      const result = await service.syncRagConnector(req.params.id);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get('/api/rag/chunks', (req, res) => {
    const connectorId =
      typeof req.query.connectorId === 'string' ? req.query.connectorId : undefined;
    res.json({ chunks: service.getRagChunks(connectorId) });
  });

  app.post('/api/rag/query', async (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        query?: string;
        connectorIds?: string[];
        routeId?: string | null;
        topK?: number;
      };
      const result = await service.queryRag({
        query: body.query ?? '',
        connectorIds: body.connectorIds,
        routeId: body.routeId,
        topK: body.topK,
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // --- TRINITY :7700 RAG Bridge API routes ---

  app.get('/api/trinity/health', async (req, res) => {
    try {
      const trinityUrl =
        typeof req.query.trinityUrl === 'string' ? req.query.trinityUrl : undefined;
      const result = await service.getTrinityHealth(trinityUrl);
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  app.post('/api/trinity/query', async (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        queryText?: string;
        query_text?: string;
        k?: number;
        tierFilter?: string | null;
        minKappa?: number;
        trinityUrl?: string | null;
      };
      const result = await service.trinityQuery({
        queryText: body.queryText ?? body.query_text ?? '',
        k: body.k,
        tierFilter: body.tierFilter,
        minKappa: body.minKappa,
        trinityUrl: body.trinityUrl,
      });
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  app.post('/api/trinity/context', async (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        queryText?: string;
        query_text?: string;
        k?: number;
        trinityUrl?: string | null;
      };
      const result = await service.trinityContext({
        queryText: body.queryText ?? body.query_text ?? '',
        k: body.k,
        trinityUrl: body.trinityUrl,
      });
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  app.post('/api/trinity/ingest', async (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        content?: string;
        source?: string;
        sessionId?: string;
        kappa?: number;
        metadata?: Record<string, unknown>;
        trinityUrl?: string | null;
      };
      const result = await service.trinityIngest({
        content: body.content ?? '',
        source: body.source,
        sessionId: body.sessionId,
        kappa: body.kappa,
        metadata: body.metadata,
        trinityUrl: body.trinityUrl,
      });
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // --- Optional MCP Server (stdin/stdout) Live Bridge ---

  app.get('/api/mcp/logs', (_req, res) => {
    res.json({
      mcpEnabled: service.getConfig().mcpEnabled,
      logs: service.getMcpLogs(),
    });
  });

  app.post('/api/mcp/stdio', async (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        raw?: string;
        jsonrpc?: Record<string, unknown>;
      };
      const payload = body.raw?.trim() ? body.raw : body.jsonrpc;
      if (!payload) {
        res.status(400).json({ error: 'Provide raw JSON-RPC string or jsonrpc object.' });
        return;
      }
      const result = await invokeSingleMcpJsonRpc(service, telemetry, payload);
      res.json({
        ...result,
        logs: service.getMcpLogs(),
      });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // --- Providers & Telemetry ---

  app.get('/api/providers', (_req, res) => {
    res.json({
      ...service.getProvidersMetadata(),
      routeFunctions: ROUTE_PROVIDER_FUNCTIONS,
    });
  });

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
    try {
      await service.embedTest('health probe embedding check');
    } catch (err) {
      console.warn('Probe embedding warning:', (err as Error).message);
    }
    telemetry.notify();
    res.json(telemetry.getSnapshot());
  });

  app.post('/api/providers/embed-test', async (req, res) => {
    const body = req.body as { text?: string; encoderModel?: EncoderModelId };
    const result = await service.embedTest(body.text ?? '', body.encoderModel);
    res.json(result);
  });

  app.post('/api/providers/execute', async (req, res) => {
    const body = req.body as {
      providerId?: string;
      arguments?: Record<string, unknown>;
      query?: string;
    };
    const providerId = (body.providerId ?? '').trim() || 'fallback-none';
    const { result } = await service.executeProviderFunction(
      providerId,
      body.arguments ?? {},
      (body.query ?? '').trim() || 'Sample test invocation'
    );
    res.json(result);
  });

  app.post('/api/route', async (req, res) => {
    try {
      const body = req.body as {
        query?: string;
        mode?: RouterConfig['mode'];
        alpha?: number;
        aggregation?: RouterConfig['aggregation'];
        encoderModel?: EncoderModelId;
        executeProvider?: boolean;
        useRag?: boolean;
      };
      const decision = await service.routePrompt({
        query: body.query ?? '',
        mode: body.mode,
        alpha: body.alpha,
        aggregation: body.aggregation,
        encoderModel: body.encoderModel,
        executeProvider: body.executeProvider,
        useRag: body.useRag,
        transport: 'http',
      });
      res.json(decision);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/evaluate', async (_req, res) => {
    const report = await service.evaluate();
    res.json(report);
  });

  app.post('/api/fit', async (_req, res) => {
    const fitReport = await service.fit();
    res.json(fitReport);
  });

  app.post('/api/eval-cases', (req, res) => {
    try {
      const body = req.body as { query?: string; expectedRoute?: string | null };
      const evalCase = service.addEvalCase(body.query ?? '', body.expectedRoute ?? null);
      res.status(201).json({ evalCase });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/eval-cases/:id', (req, res) => {
    const deleted = service.deleteEvalCase(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Evaluation case not found.' });
      return;
    }
    res.json({ deletedId: req.params.id });
  });

  app.post('/api/reset', (_req, res) => {
    res.json(service.resetWorkspace());
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
    void (async () => {
      // Auto-sync enabled RAG connectors that haven't been synced yet
      for (const conn of service.getRagConnectors()) {
        if (conn.enabled && conn.lastSyncedAt === null) {
          try {
            await service.syncRagConnector(conn.id);
          } catch (err) {
            console.warn(`Initial RAG connector sync (${conn.name}) skipped:`, (err as Error).message);
          }
        }
      }
      await service.warmUpEmbeddings();
    })();
  });
}

startServer();
