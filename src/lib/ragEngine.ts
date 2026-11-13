import {
  blendScore,
  computeSparseSimilarity,
  cosineSimilarity,
  type VectorLookup,
} from './routerEngine.ts';
import type {
  RagChunk,
  RagConnector,
  RagParserMode,
  RagRetrievalMatch,
  RouterConfig,
} from './types.ts';

export function stripHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractByJsonPath(obj: unknown, pathExpr?: string): string {
  if (obj === null || obj === undefined) return '';
  let current: unknown = obj;

  if (pathExpr && pathExpr.trim()) {
    const segments = pathExpr
      .trim()
      .replace(/^\$\.?/, '')
      .split('.')
      .filter(Boolean);
    for (const seg of segments) {
      if (current === null || current === undefined) break;
      if (Array.isArray(current)) {
        const idx = Number(seg);
        if (!Number.isNaN(idx)) {
          current = current[idx];
        } else {
          current = current.map((item) =>
            item && typeof item === 'object' ? (item as Record<string, unknown>)[seg] : undefined
          );
        }
      } else if (typeof current === 'object') {
        current = (current as Record<string, unknown>)[seg];
      } else {
        current = undefined;
      }
    }
  }

  return flattenToText(current);
}

function flattenToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map((v) => flattenToText(v)).filter(Boolean).join('\n\n');
  }
  if (typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    const preferredKeys = ['text', 'content', 'body', 'summary', 'description', 'title'];
    const parts: string[] = [];

    // Preserve TRINITY Core RAG resonance & tier context if present alongside content
    const trinityMeta: string[] = [];
    if (typeof rec.source === 'string' && rec.source.trim()) {
      trinityMeta.push(`source=${rec.source.trim()}`);
    }
    if (typeof rec.tier === 'string' && rec.tier.trim()) {
      trinityMeta.push(`tier=${rec.tier.trim()}`);
    }
    if (typeof rec.kappa === 'number') {
      trinityMeta.push(`kappa=${rec.kappa.toFixed(3)}`);
    }
    if (typeof rec.score === 'number') {
      trinityMeta.push(`score=${rec.score.toFixed(3)}`);
    }
    if (trinityMeta.length > 0 && ('content' in rec || 'text' in rec)) {
      parts.push(`[TRINITY ${trinityMeta.join(' | ')}]`);
    }

    for (const key of preferredKeys) {
      if (key in rec && typeof rec[key] === 'string' && (rec[key] as string).trim()) {
        parts.push(`${key === 'title' ? '# ' : ''}${(rec[key] as string).trim()}`);
      }
    }
    if (parts.length > 0) {
      return parts.join('\n');
    }
    return Object.entries(rec)
      .map(([k, v]) => {
        const rendered = flattenToText(v);
        return rendered ? `${k}: ${rendered}` : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export function extractContentFromResponse(
  rawBody: string,
  contentType: string,
  parserMode: RagParserMode,
  jsonPath?: string
): string {
  const mode =
    parserMode !== 'auto'
      ? parserMode
      : contentType.includes('application/json') || rawBody.trim().startsWith('{') || rawBody.trim().startsWith('[')
        ? 'json'
        : contentType.includes('text/html') || /<html|<body|<p>/i.test(rawBody)
          ? 'html'
          : 'text';

  if (mode === 'json') {
    try {
      const parsed = JSON.parse(rawBody) as unknown;
      const extracted = extractByJsonPath(parsed, jsonPath);
      if (extracted.trim()) return extracted.trim();
    } catch {
      // Fallback to raw text if invalid JSON
    }
  }

  if (mode === 'html') {
    return stripHtmlToText(rawBody);
  }

  return rawBody.trim();
}

export function chunkText(text: string, chunkSize = 380, chunkOverlap = 40): string[] {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (!clean) return [];

  const size = Math.max(80, Math.min(2000, chunkSize));
  const overlap = Math.max(0, Math.min(Math.floor(size / 2), chunkOverlap));
  const paragraphs = clean.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  const chunks: string[] = [];
  let buffer = '';

  const flushBuffer = () => {
    const trimmed = buffer.trim();
    if (trimmed) chunks.push(trimmed);
  };

  for (const para of paragraphs) {
    if (para.length > size) {
      if (buffer.trim()) {
        flushBuffer();
        buffer = '';
      }
      let start = 0;
      while (start < para.length) {
        const slice = para.slice(start, start + size).trim();
        if (slice) chunks.push(slice);
        if (start + size >= para.length) break;
        start += Math.max(1, size - overlap);
      }
      continue;
    }

    if (!buffer) {
      buffer = para;
    } else if (buffer.length + 2 + para.length <= size) {
      buffer = `${buffer}\n\n${para}`;
    } else {
      flushBuffer();
      const tail = overlap > 0 ? buffer.slice(-overlap).trim() : '';
      buffer = tail ? `${tail}\n${para}` : para;
      if (buffer.length > size) {
        buffer = para;
      }
    }
  }

  flushBuffer();
  return chunks;
}

export async function fetchAndChunkConnector(
  connector: RagConnector,
  timeoutMs = 8000
): Promise<{ chunks: RagChunk[]; latencyMs: number; rawBytes: number }> {
  const parsedUrl = new URL(connector.url);
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('Connector URL must use http:// or https:// protocol.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startNs = process.hrtime.bigint();

  try {
    const headers: Record<string, string> = {
      Accept: 'application/json, text/plain, text/markdown, text/html;q=0.8',
      'User-Agent': 'SemanticRouterStudio-RAG/1.0',
      ...(connector.headers ?? {}),
    };
    const init: RequestInit = {
      method: connector.method,
      headers,
      signal: controller.signal,
    };
    if (connector.method === 'POST' && connector.requestBody) {
      init.body = connector.requestBody;
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/json';
      }
    }

    const res = await fetch(parsedUrl.toString(), init);
    const rawBody = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${rawBody.slice(0, 160)}`);
    }

    const contentType = res.headers.get('content-type') ?? '';
    const extracted = extractContentFromResponse(
      rawBody,
      contentType,
      connector.parserMode,
      connector.jsonPath
    );
    const textChunks = chunkText(extracted, connector.chunkSize, connector.chunkOverlap);
    const nowIso = new Date().toISOString();
    const latencyMs = Math.round((Number(process.hrtime.bigint() - startNs) / 1_000_000) * 100) / 100;

    const chunks: RagChunk[] = textChunks.map((text, idx) => ({
      id: `${connector.id}:chunk-${idx}`,
      connectorId: connector.id,
      connectorName: connector.name,
      sourceUrl: connector.url,
      text,
      chunkIndex: idx,
      fetchedAt: nowIso,
    }));

    return {
      chunks,
      latencyMs,
      rawBytes: Buffer.byteLength(rawBody, 'utf-8'),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function scoreRagChunks(
  query: string,
  chunks: RagChunk[],
  config: RouterConfig,
  vectorLookup: VectorLookup,
  opts?: { topK?: number; minScore?: number }
): RagRetrievalMatch[] {
  if (chunks.length === 0) return [];
  const topK = opts?.topK ?? 3;
  const minScore = opts?.minScore ?? (config.encoderModel === 'e5-small-v2' ? 0.35 : 0.15);

  const queryVec = vectorLookup.getQueryVector
    ? vectorLookup.getQueryVector(query)
    : vectorLookup.getVector(query);

  const scored: RagRetrievalMatch[] = chunks.map((chunk) => {
    const passageVec = vectorLookup.getPassageVector
      ? vectorLookup.getPassageVector(chunk.text)
      : vectorLookup.getVector(chunk.text);
    const denseScore = cosineSimilarity(queryVec, passageVec);
    const sparseScore = computeSparseSimilarity(query, chunk.text);
    const score = blendScore(denseScore, sparseScore, config.mode, config.alpha);
    return {
      chunkId: chunk.id,
      connectorId: chunk.connectorId,
      connectorName: chunk.connectorName,
      sourceUrl: chunk.sourceUrl,
      text: chunk.text,
      score: Math.round(score * 10000) / 10000,
      denseScore: Math.round(denseScore * 10000) / 10000,
      sparseScore: Math.round(sparseScore * 10000) / 10000,
    };
  });

  return scored
    .filter((m) => m.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
