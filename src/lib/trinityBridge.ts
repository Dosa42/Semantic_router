export const DEFAULT_TRINITY_URL =
  (process.env.TRINITY_URL ?? '').trim().replace(/\/+$/, '') || 'http://127.0.0.1:7700';

export interface TrinityHealthResponse {
  status: string;
  service: string;
  version?: string;
  faiss_vectors?: number;
  hot_cache?: number;
  total_chunks?: number;
  by_tier?: Record<string, number>;
  avg_kappa?: number;
}

export interface TrinityQueryResultItem {
  chunk_id: string;
  content: string;
  score: number;
  tier?: string;
  kappa?: number;
  tessa?: number;
  source?: string;
  session_id?: string;
  metadata?: Record<string, unknown>;
}

export interface TrinityQueryResponse {
  query: string;
  k: number;
  results: TrinityQueryResultItem[];
}

export interface TrinityContextResponse {
  context: string;
}

export interface TrinityIngestResponse {
  chunk_id: string;
  status: string;
}

export function resolveTrinityBaseUrl(overrideUrl?: string | null): string {
  const candidate = (overrideUrl ?? '').trim().replace(/\/+$/, '') || DEFAULT_TRINITY_URL;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`Invalid TRINITY URL: "${candidate}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('TRINITY URL must use http:// or https:// protocol.');
  }
  return parsed.toString().replace(/\/+$/, '');
}

async function requestTrinityJson<T>(
  path: string,
  init: RequestInit,
  opts?: { trinityUrl?: string | null; timeoutMs?: number }
): Promise<{ data: T; latencyMs: number; baseUrl: string }> {
  const baseUrl = resolveTrinityBaseUrl(opts?.trinityUrl);
  const timeoutMs = opts?.timeoutMs ?? 8000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startNs = process.hrtime.bigint();

  try {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    });
    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`TRINITY ${path} returned HTTP ${res.status}: ${raw.slice(0, 200)}`);
    }
    const latencyMs =
      Math.round((Number(process.hrtime.bigint() - startNs) / 1_000_000) * 100) / 100;
    const data = (raw ? JSON.parse(raw) : {}) as T;
    return { data, latencyMs, baseUrl };
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`TRINITY ${baseUrl}${path} timed out after ${timeoutMs}ms.`);
    }
    if ((err as Error).message.startsWith('TRINITY ')) {
      throw err;
    }
    throw new Error(
      `Unable to reach TRINITY server at ${baseUrl}${path}: ${(err as Error).message}`
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function checkTrinityHealth(trinityUrl?: string | null) {
  return requestTrinityJson<TrinityHealthResponse>(
    '/health',
    { method: 'GET' },
    { trinityUrl, timeoutMs: 4000 }
  );
}

export async function queryTrinityRag(params: {
  queryText: string;
  k?: number;
  tierFilter?: string | null;
  minKappa?: number;
  trinityUrl?: string | null;
}) {
  const queryText = params.queryText.trim();
  if (!queryText) {
    throw new Error('queryText is required for TRINITY /query.');
  }
  return requestTrinityJson<TrinityQueryResponse>(
    '/query',
    {
      method: 'POST',
      body: JSON.stringify({
        query_text: queryText,
        k: typeof params.k === 'number' ? Math.max(1, Math.min(50, params.k)) : 5,
        tier_filter: params.tierFilter ?? null,
        min_kappa: typeof params.minKappa === 'number' ? params.minKappa : 0.0,
      }),
    },
    { trinityUrl: params.trinityUrl }
  );
}

export async function fetchTrinityContext(params: {
  queryText: string;
  k?: number;
  trinityUrl?: string | null;
}) {
  const queryText = params.queryText.trim();
  if (!queryText) {
    throw new Error('queryText is required for TRINITY /context.');
  }
  return requestTrinityJson<TrinityContextResponse>(
    '/context',
    {
      method: 'POST',
      body: JSON.stringify({
        query_text: queryText,
        k: typeof params.k === 'number' ? Math.max(1, Math.min(50, params.k)) : 5,
      }),
    },
    { trinityUrl: params.trinityUrl }
  );
}

export async function ingestTrinityChunk(params: {
  content: string;
  source?: string;
  sessionId?: string;
  kappa?: number;
  metadata?: Record<string, unknown>;
  trinityUrl?: string | null;
}) {
  const content = params.content.trim();
  if (!content) {
    throw new Error('content is required for TRINITY /ingest.');
  }
  return requestTrinityJson<TrinityIngestResponse>(
    '/ingest',
    {
      method: 'POST',
      body: JSON.stringify({
        content,
        source: params.source?.trim() || 'semantic-router-studio',
        session_id: params.sessionId?.trim() || 'studio-mcp',
        kappa: typeof params.kappa === 'number' ? params.kappa : 0.72,
        metadata: params.metadata ?? {},
      }),
    },
    { trinityUrl: params.trinityUrl }
  );
}
