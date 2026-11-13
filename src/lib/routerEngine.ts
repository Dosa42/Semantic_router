import type {
  AggregationStrategy,
  EmbeddingSlotRole,
  EnsembleFusionMode,
  EvalCase,
  EvalPrediction,
  EvalReport,
  ExtractedFunctionCall,
  FitReport,
  FitThresholdChange,
  FunctionSchema,
  RouteDefinition,
  RouteMetric,
  RouteScoreBreakdown,
  RouterConfig,
  RoutingMode,
  UtteranceMatch,
} from './types.ts';

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'about',
  'as', 'into', 'like', 'through', 'after', 'over', 'between', 'out',
  'against', 'during', 'without', 'before', 'under', 'around', 'among',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'it', 'its', 'they',
  'them', 'their', 'this', 'that', 'these', 'those', 'do', 'does', 'did',
  'can', 'could', 'would', 'should', 'will', 'just', 'please', 'and', 'or',
  'but', 'if', 'then', 'so', 'than', 'too', 'very',
]);

// Light semantic synonym normalization for the local fallback encoder
const SYNONYM_MAP: Record<string, string> = {
  // Politics
  senate: 'politics',
  congress: 'politics',
  parliament: 'politics',
  election: 'politics',
  elections: 'politics',
  vote: 'politics',
  voting: 'politics',
  partisan: 'politics',
  government: 'politics',
  policy: 'politics',
  democrat: 'politics',
  republican: 'politics',
  president: 'politics',
  minister: 'politics',
  // Chitchat
  hey: 'greeting',
  hello: 'greeting',
  hi: 'greeting',
  morning: 'greeting',
  afternoon: 'greeting',
  evening: 'greeting',
  funny: 'joke',
  humor: 'joke',
  weather: 'weather',
  // Time
  clock: 'time',
  timezone: 'time',
  utc: 'time',
  pst: 'time',
  est: 'time',
  gmt: 'time',
  paris: 'city',
  tokyo: 'city',
  london: 'city',
  berlin: 'city',
  // SQL
  postgres: 'sql',
  postgresql: 'sql',
  snowflake: 'sql',
  bigquery: 'sql',
  mysql: 'sql',
  sqlite: 'sql',
  query: 'sql',
  database: 'sql',
  table: 'sql',
  tables: 'sql',
  join: 'sql',
  index: 'sql',
  cohort: 'sql',
  retention: 'sql',
  // Guardrails
  ignore: 'bypass',
  disregard: 'bypass',
  forget: 'bypass',
  override: 'bypass',
  jailbreak: 'bypass',
  unrestricted: 'bypass',
  verbatim: 'reveal',
  instructions: 'prompt',
  directives: 'prompt',
  rules: 'prompt',
  system: 'prompt',
  // Billing
  invoice: 'billing',
  charge: 'billing',
  charged: 'billing',
  card: 'billing',
  subscription: 'billing',
  refund: 'refund',
  reimburse: 'refund',
  dispute: 'refund',
  duplicate: 'double',
  twice: 'double',
};

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(text: string, includeStopWords = false): string[] {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  const raw = normalized.split(' ').filter(Boolean);
  if (includeStopWords) return raw;
  const filtered = raw.filter((t) => !STOP_WORDS.has(t));
  return filtered.length > 0 ? filtered : raw;
}

function fnv1aHash(str: string, seed = 2166136261): number {
  let hash = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Deterministic 256-dim local semantic projection using normalized tokens,
 * synonym anchors, word bigrams, and character trigrams.
 * Used for fast zero-dependency unit tests and deterministic local hybrid fallback.
 */
export function computeLocalDenseVector(text: string, dims = 256): number[] {
  const vec = new Float64Array(dims);
  const tokens = tokenize(text, false);
  const rawTokens = tokenize(text, true);

  for (const tok of tokens) {
    const canonical = SYNONYM_MAP[tok] ?? tok;
    // Word feature
    const idx1 = fnv1aHash(`w:${tok}`) % dims;
    const sign1 = (fnv1aHash(`s:${tok}`) & 1) === 0 ? 1 : -1;
    vec[idx1] += 2.2 * sign1;

    // Canonical semantic anchor feature
    if (canonical !== tok) {
      const idxC = fnv1aHash(`c:${canonical}`) % dims;
      const signC = (fnv1aHash(`sc:${canonical}`) & 1) === 0 ? 1 : -1;
      vec[idxC] += 2.4 * signC;
    } else {
      const idxC = fnv1aHash(`c:${tok}`) % dims;
      const signC = (fnv1aHash(`sc:${tok}`) & 1) === 0 ? 1 : -1;
      vec[idxC] += 1.2 * signC;
    }

    // Character 3-grams for morphological resilience
    const padded = `^${tok}$`;
    for (let i = 0; i <= padded.length - 3; i++) {
      const gram = padded.slice(i, i + 3);
      const idxG = fnv1aHash(`g:${gram}`) % dims;
      const signG = (fnv1aHash(`sg:${gram}`) & 1) === 0 ? 1 : -1;
      vec[idxG] += 0.65 * signG;
    }
  }

  // Word bigrams for phrase order signals
  for (let i = 0; i < rawTokens.length - 1; i++) {
    const bigram = `${rawTokens[i]}_${rawTokens[i + 1]}`;
    const idxB = fnv1aHash(`b:${bigram}`) % dims;
    const signB = (fnv1aHash(`sb:${bigram}`) & 1) === 0 ? 1 : -1;
    vec[idxB] += 1.1 * signB;
  }

  return normalizeVector(Array.from(vec));
}

export function normalizeVector(vec: number[]): number[] {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) {
    sumSq += vec[i] * vec[i];
  }
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return vec.map(() => 0);
  return vec.map((v) => v / norm);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  // Clamp to [0, 1] for similarity scores
  return Math.max(0, Math.min(1, dot / denom));
}

/**
 * Sparse BM25/IDF-weighted token + bigram cosine similarity.
 * Captures exact identifiers (e.g., ORD-4821, PostgreSQL, UTC+2).
 */
export function computeSparseSimilarity(
  query: string,
  utterance: string,
  idfMap?: Map<string, number>
): number {
  const qTokens = tokenize(query, false);
  const uTokens = tokenize(utterance, false);
  if (qTokens.length === 0 || uTokens.length === 0) return 0;

  const qRaw = tokenize(query, true);
  const uRaw = tokenize(utterance, true);

  const buildTf = (toks: string[], raw: string[]) => {
    const tf = new Map<string, number>();
    for (const t of toks) {
      tf.set(t, (tf.get(t) ?? 0) + 1);
      const canon = SYNONYM_MAP[t];
      if (canon && canon !== t) {
        tf.set(`~${canon}`, (tf.get(`~${canon}`) ?? 0) + 0.7);
      }
    }
    for (let i = 0; i < raw.length - 1; i++) {
      const bg = `${raw[i]}_${raw[i + 1]}`;
      tf.set(bg, (tf.get(bg) ?? 0) + 0.6);
    }
    return tf;
  };

  const qTf = buildTf(qTokens, qRaw);
  const uTf = buildTf(uTokens, uRaw);

  let dot = 0;
  let normQ = 0;
  let normU = 0;

  for (const [term, count] of qTf.entries()) {
    const idf = idfMap?.get(term) ?? 1.4;
    const w = count * idf;
    normQ += w * w;
    const uCount = uTf.get(term);
    if (uCount !== undefined) {
      dot += w * (uCount * idf);
    }
  }

  for (const [term, count] of uTf.entries()) {
    const idf = idfMap?.get(term) ?? 1.4;
    const w = count * idf;
    normU += w * w;
  }

  const denom = Math.sqrt(normQ) * Math.sqrt(normU);
  if (denom === 0) return 0;
  return Math.max(0, Math.min(1, dot / denom));
}

export function buildIdfMap(routes: RouteDefinition[]): Map<string, number> {
  const docFreq = new Map<string, number>();
  let totalDocs = 0;

  for (const route of routes) {
    for (const utt of route.utterances) {
      totalDocs += 1;
      const seen = new Set(tokenize(utt, false));
      for (const t of seen) {
        docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
      }
    }
  }

  const idf = new Map<string, number>();
  for (const [term, df] of docFreq.entries()) {
    idf.set(term, Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5)) + 0.5);
  }
  return idf;
}

export function aggregateScores(scores: number[], strategy: AggregationStrategy): number {
  if (scores.length === 0) return 0;
  const sorted = [...scores].sort((a, b) => b - a);
  if (strategy === 'max') return sorted[0];
  if (strategy === 'mean') {
    return sorted.reduce((acc, v) => acc + v, 0) / sorted.length;
  }
  // top_k_mean (top 3)
  const k = Math.min(3, sorted.length);
  let sum = 0;
  for (let i = 0; i < k; i++) sum += sorted[i];
  return sum / k;
}

export function blendScore(
  denseScore: number,
  sparseScore: number,
  mode: RoutingMode,
  alpha: number
): number {
  if (mode === 'dense') return denseScore;
  if (mode === 'sparse') return sparseScore;
  const clampedAlpha = Math.max(0, Math.min(1, alpha));
  return clampedAlpha * denseScore + (1 - clampedAlpha) * sparseScore;
}

export interface VectorLookup {
  getVector: (text: string) => number[];
  getQueryVector?: (text: string) => number[];
  getPassageVector?: (text: string) => number[];
}

export interface EnsembleSlotLookup {
  role: EmbeddingSlotRole;
  lookup: VectorLookup;
  weight: number;
  enabled?: boolean;
}

export interface EnsembleVectorLookup {
  slots: EnsembleSlotLookup[];
  fusionMode: EnsembleFusionMode;
}

export function createLocalVectorLookup(dims = 256): VectorLookup {
  const cache = new Map<string, number[]>();
  return {
    getVector(text: string) {
      const existing = cache.get(text);
      if (existing) return existing;
      const vec = computeLocalDenseVector(text, dims);
      cache.set(text, vec);
      return vec;
    },
  };
}

export function fuseEnsembleScores(
  perSlotScores: Array<{ role: EmbeddingSlotRole; score: number; weight: number }>,
  mode: EnsembleFusionMode
): number {
  if (perSlotScores.length === 0) return 0;

  if (mode === 'max') {
    return round4(Math.max(...perSlotScores.map((s) => s.score)));
  }

  if (mode === 'cascade') {
    const intent = perSlotScores.find((s) => s.role === 'intent');
    if (intent && intent.score < 0.3) return 0;
  }

  // weighted_sum (and cascade pass-through after intent gate)
  const totalWeight = perSlotScores.reduce((acc, s) => acc + Math.max(0, s.weight), 0);
  if (totalWeight <= 0) {
    const mean = perSlotScores.reduce((acc, s) => acc + s.score, 0) / perSlotScores.length;
    return round4(mean);
  }
  const weighted = perSlotScores.reduce(
    (acc, s) => acc + (s.score * Math.max(0, s.weight)) / totalWeight,
    0
  );
  return round4(weighted);
}

export async function runParallelEmbeddings(
  texts: string[],
  slots: Array<{ role: EmbeddingSlotRole; lookup: VectorLookup }>
): Promise<Record<EmbeddingSlotRole, number[][]>> {
  const entries = await Promise.all(
    slots.map(async ({ role, lookup }) => ({
      role,
      vecs: texts.map((text) =>
        lookup.getQueryVector ? lookup.getQueryVector(text) : lookup.getVector(text)
      ),
    }))
  );
  return Object.fromEntries(entries.map((e) => [e.role, e.vecs])) as Record<
    EmbeddingSlotRole,
    number[][]
  >;
}

export function scoreRoutes(
  query: string,
  routes: RouteDefinition[],
  config: RouterConfig,
  vectorLookup: VectorLookup
): {
  matchedRoute: RouteDefinition | null;
  topScore: number;
  allScores: RouteScoreBreakdown[];
} {
  const enabledRoutes = routes.filter((r) => r.enabled && r.utterances.length > 0);
  const idfMap = buildIdfMap(enabledRoutes);
  const queryVec = vectorLookup.getQueryVector
    ? vectorLookup.getQueryVector(query)
    : vectorLookup.getVector(query);

  const breakdowns: RouteScoreBreakdown[] = enabledRoutes.map((route) => {
    const utteranceMatches: UtteranceMatch[] = route.utterances.map((utterance) => {
      const uttVec = vectorLookup.getPassageVector
        ? vectorLookup.getPassageVector(utterance)
        : vectorLookup.getVector(utterance);
      const denseScore = cosineSimilarity(queryVec, uttVec);
      const sparseScore = computeSparseSimilarity(query, utterance, idfMap);
      const score = blendScore(denseScore, sparseScore, config.mode, config.alpha);
      return {
        utterance,
        score: round4(score),
        denseScore: round4(denseScore),
        sparseScore: round4(sparseScore),
      };
    });

    utteranceMatches.sort((a, b) => b.score - a.score);

    const score = round4(
      aggregateScores(
        utteranceMatches.map((m) => m.score),
        config.aggregation
      )
    );
    const denseScore = round4(
      aggregateScores(
        utteranceMatches.map((m) => m.denseScore),
        config.aggregation
      )
    );
    const sparseScore = round4(
      aggregateScores(
        utteranceMatches.map((m) => m.sparseScore),
        config.aggregation
      )
    );

    const threshold = route.scoreThreshold ?? config.defaultThreshold;
    const passed = score >= threshold;
    const margin = round4(score - threshold);

    return {
      routeId: route.id,
      routeName: route.name,
      routeType: route.routeType,
      targetModel: route.targetModel,
      score,
      denseScore,
      sparseScore,
      threshold,
      passed,
      margin,
      topUtterance: utteranceMatches[0]?.utterance ?? '',
      utteranceMatches,
    };
  });

  breakdowns.sort((a, b) => b.score - a.score);

  // Aurelio Semantic Router picks the highest-scoring route that clears its threshold.
  // If the highest-scoring route passes its threshold, it wins; otherwise check if any passing route exists.
  const passingBreakdowns = breakdowns.filter((b) => b.passed);
  const winnerBreakdown = passingBreakdowns[0] ?? null;
  const matchedRoute = winnerBreakdown
    ? enabledRoutes.find((r) => r.id === winnerBreakdown.routeId) ?? null
    : null;

  return {
    matchedRoute,
    topScore: breakdowns[0]?.score ?? 0,
    allScores: breakdowns,
  };
}

export function scoreRoutesEnsemble(
  query: string,
  routes: RouteDefinition[],
  config: RouterConfig,
  ensemble: EnsembleVectorLookup
): {
  matchedRoute: RouteDefinition | null;
  topScore: number;
  allScores: RouteScoreBreakdown[];
  perEncoderBreakdown: Partial<Record<EmbeddingSlotRole, RouteScoreBreakdown[]>>;
} {
  const activeSlots = ensemble.slots.filter((s) => s.enabled !== false);
  const enabledRoutes = routes.filter((r) => r.enabled && r.utterances.length > 0);

  if (activeSlots.length === 0) {
    const fallback = scoreRoutes(query, routes, config, createLocalVectorLookup());
    return {
      ...fallback,
      perEncoderBreakdown: {},
    };
  }

  const perEncoderBreakdown: Partial<Record<EmbeddingSlotRole, RouteScoreBreakdown[]>> = {};
  for (const slot of activeSlots) {
    const slotRes = scoreRoutes(query, enabledRoutes, config, slot.lookup);
    perEncoderBreakdown[slot.role] = slotRes.allScores;
  }

  // Sort active slots by weight descending so the highest-weight slot supplies representative metadata
  const sortedSlots = [...activeSlots].sort((a, b) => b.weight - a.weight);

  const fusedBreakdowns: RouteScoreBreakdown[] = enabledRoutes.map((route) => {
    const perEncoderScores: Partial<Record<EmbeddingSlotRole, number>> = {};
    const slotInputs: Array<{ role: EmbeddingSlotRole; score: number; weight: number }> = [];
    const denseInputs: Array<{ role: EmbeddingSlotRole; score: number; weight: number }> = [];
    const sparseInputs: Array<{ role: EmbeddingSlotRole; score: number; weight: number }> = [];

    let primarySlotBreakdown: RouteScoreBreakdown | undefined;

    for (const slot of sortedSlots) {
      const list = perEncoderBreakdown[slot.role] ?? [];
      const found = list.find((b) => b.routeId === route.id);
      if (!found) continue;
      if (!primarySlotBreakdown) primarySlotBreakdown = found;
      perEncoderScores[slot.role] = found.score;
      slotInputs.push({ role: slot.role, score: found.score, weight: slot.weight });
      denseInputs.push({ role: slot.role, score: found.denseScore, weight: slot.weight });
      sparseInputs.push({ role: slot.role, score: found.sparseScore, weight: slot.weight });
    }

    const ensembleFusedScore = fuseEnsembleScores(slotInputs, ensemble.fusionMode);
    const fusedDense = fuseEnsembleScores(denseInputs, ensemble.fusionMode);
    const fusedSparse = fuseEnsembleScores(sparseInputs, ensemble.fusionMode);
    const threshold = route.scoreThreshold ?? config.defaultThreshold;
    const passed = ensembleFusedScore >= threshold;
    const margin = round4(ensembleFusedScore - threshold);

    return {
      routeId: route.id,
      routeName: route.name,
      routeType: route.routeType,
      targetModel: route.targetModel,
      score: ensembleFusedScore,
      denseScore: fusedDense,
      sparseScore: fusedSparse,
      threshold,
      passed,
      margin,
      topUtterance: primarySlotBreakdown?.topUtterance ?? route.utterances[0] ?? '',
      utteranceMatches: primarySlotBreakdown?.utteranceMatches ?? [],
      perEncoderScores,
      ensembleFusedScore,
    };
  });

  fusedBreakdowns.sort((a, b) => b.score - a.score);
  const winnerBreakdown = fusedBreakdowns.find((b) => b.passed) ?? null;
  const matchedRoute = winnerBreakdown
    ? enabledRoutes.find((r) => r.id === winnerBreakdown.routeId) ?? null
    : null;

  return {
    matchedRoute,
    topScore: fusedBreakdowns[0]?.score ?? 0,
    allScores: fusedBreakdowns,
    perEncoderBreakdown,
  };
}

export function extractDynamicParametersLocal(
  query: string,
  schema: FunctionSchema
): ExtractedFunctionCall {
  const args: Record<string, string | number | boolean | null> = {};
  const q = query.trim();

  for (const param of schema.parameters) {
    const pName = param.name.toLowerCase();

    if (pName === 'location' || pName === 'city') {
      const match = q.match(/\b(?:in|for|at)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*)/);
      if (match) {
        args[param.name] = match[1];
      } else {
        const knownCities = ['Tokyo', 'London', 'New York', 'San Francisco', 'Paris', 'Berlin', 'Sydney', 'Toronto'];
        const found = knownCities.find((c) => q.toLowerCase().includes(c.toLowerCase()));
        args[param.name] = found ?? (param.required ? 'UTC' : null);
      }
    } else if (pName === 'timezone' || pName === 'tz') {
      const tzMatch = q.match(/\b(UTC[+-]?\d*|GMT[+-]?\d*|PST|EST|CST|MST|JST|BST|CET|[A-Z][a-z]+\/[A-Z][a-z_]+)\b/);
      if (tzMatch) {
        args[param.name] = tzMatch[1];
      } else if (q.toLowerCase().includes('tokyo')) {
        args[param.name] = 'Asia/Tokyo';
      } else if (q.toLowerCase().includes('london')) {
        args[param.name] = 'Europe/London';
      } else if (q.toLowerCase().includes('paris')) {
        args[param.name] = 'Europe/Paris';
      } else if (q.toLowerCase().includes('new york')) {
        args[param.name] = 'America/New_York';
      } else {
        args[param.name] = null;
      }
    } else if (pName === 'order_id' || pName === 'invoice_id' || pName === 'id') {
      const idMatch = q.match(/\b((?:ORD|INV|TXN|SUB)[-_]?\d{2,10}|#\d{3,10})\b/i);
      args[param.name] = idMatch ? idMatch[1].toUpperCase() : null;
    } else if (pName === 'reason' || pName === 'summary' || pName === 'query') {
      args[param.name] = q.length > 120 ? `${q.slice(0, 117)}...` : q;
    } else if (param.type === 'number') {
      const numMatch = q.match(/\b(\d+(?:\.\d+)?)\b/);
      args[param.name] = numMatch ? Number(numMatch[1]) : null;
    } else if (param.type === 'boolean') {
      args[param.name] = /\b(yes|true|enable|confirm|immediate)\b/i.test(q);
    } else {
      args[param.name] = param.required ? q : null;
    }
  }

  return {
    name: schema.name,
    arguments: args,
    extractionMethod: 'local-slot-parser',
  };
}

export function evaluateDataset(
  cases: EvalCase[],
  routes: RouteDefinition[],
  config: RouterConfig,
  vectorLookup: VectorLookup,
  encoderUsed = 'Local TF-IDF + Subword Dense'
): EvalReport {
  const predictions: EvalPrediction[] = cases.map((c) => {
    const scored = scoreRoutes(c.query, routes, config, vectorLookup);
    const predictedRoute = scored.matchedRoute ? scored.matchedRoute.name : null;
    const thresholdUsed = scored.matchedRoute
      ? scored.matchedRoute.scoreThreshold
      : scored.allScores[0]?.threshold ?? null;
    return {
      id: c.id,
      query: c.query,
      expectedRoute: c.expectedRoute,
      predictedRoute,
      topScore: scored.topScore,
      thresholdUsed,
      correct: predictedRoute === c.expectedRoute,
    };
  });

  const totalCases = predictions.length;
  const correctCases = predictions.filter((p) => p.correct).length;
  const matchedCount = predictions.filter((p) => p.predictedRoute !== null).length;
  const fallbackCount = totalCases - matchedCount;
  const nullExpected = predictions.filter((p) => p.expectedRoute === null);
  const falsePositivesOnNull = nullExpected.filter((p) => p.predictedRoute !== null).length;
  const falsePositiveRate =
    nullExpected.length > 0 ? round4(falsePositivesOnNull / nullExpected.length) : 0;

  const routeMetrics: RouteMetric[] = routes
    .filter((r) => r.enabled)
    .map((route) => {
      const tp = predictions.filter(
        (p) => p.expectedRoute === route.name && p.predictedRoute === route.name
      ).length;
      const fp = predictions.filter(
        (p) => p.expectedRoute !== route.name && p.predictedRoute === route.name
      ).length;
      const fn = predictions.filter(
        (p) => p.expectedRoute === route.name && p.predictedRoute !== route.name
      ).length;
      const support = predictions.filter((p) => p.expectedRoute === route.name).length;
      const precision = tp + fp > 0 ? round4(tp / (tp + fp)) : 0;
      const recall = tp + fn > 0 ? round4(tp / (tp + fn)) : 0;
      const f1 = precision + recall > 0 ? round4((2 * precision * recall) / (precision + recall)) : 0;
      return {
        routeName: route.name,
        support,
        truePositives: tp,
        falsePositives: fp,
        falseNegatives: fn,
        precision,
        recall,
        f1,
        currentThreshold: route.scoreThreshold,
      };
    });

  return {
    accuracy: totalCases > 0 ? round4(correctCases / totalCases) : 0,
    totalCases,
    correctCases,
    matchedCount,
    fallbackCount,
    falsePositiveRate,
    encoderUsed,
    predictions,
    routeMetrics,
  };
}

/**
 * Coordinate-ascent threshold optimization modeled on Aurelio Semantic Router's `.fit()`.
 * Precomputes the (case, route) similarity matrix once and sweeps candidate thresholds
 * in [0.20, 0.88] to maximize dataset accuracy in milliseconds.
 */
export function optimizeRouteThresholds(
  cases: EvalCase[],
  routes: RouteDefinition[],
  config: RouterConfig,
  vectorLookup: VectorLookup
): FitReport {
  const beforeReport = evaluateDataset(cases, routes, config, vectorLookup);
  const workingRoutes: RouteDefinition[] = routes.map((r) => ({ ...r }));

  // Precompute raw scores for every (case, enabledRoute) pair once
  const enabledIndices: number[] = [];
  for (let i = 0; i < workingRoutes.length; i++) {
    if (workingRoutes[i].enabled && workingRoutes[i].utterances.length > 0) {
      enabledIndices.push(i);
    }
  }

  const scoreMatrix: number[][] = cases.map((c) => {
    const res = scoreRoutes(c.query, workingRoutes, config, vectorLookup);
    const byId = new Map(res.allScores.map((s) => [s.routeId, s.score]));
    return enabledIndices.map((idx) => byId.get(workingRoutes[idx].id) ?? 0);
  });

  const evaluateFast = (thresholds: number[]): number => {
    let correct = 0;
    for (let cIdx = 0; cIdx < cases.length; cIdx++) {
      let bestRoute: string | null = null;
      let bestScore = -1;
      for (let rPos = 0; rPos < enabledIndices.length; rPos++) {
        const s = scoreMatrix[cIdx][rPos];
        if (s >= thresholds[rPos] && s > bestScore) {
          bestScore = s;
          bestRoute = workingRoutes[enabledIndices[rPos]].name;
        }
      }
      if (bestRoute === cases[cIdx].expectedRoute) {
        correct += 1;
      }
    }
    return cases.length > 0 ? round4(correct / cases.length) : 0;
  };

  const thresholds = enabledIndices.map((idx) => workingRoutes[idx].scoreThreshold);
  const candidates: number[] = [];
  for (let t = 20; t <= 96; t += 1) {
    candidates.push(Number((t / 100).toFixed(2)));
  }

  const anchorThreshold = config.defaultThreshold ?? 0.55;

  for (let pass = 0; pass < 2; pass++) {
    for (let rPos = 0; rPos < enabledIndices.length; rPos++) {
      let bestThresh = thresholds[rPos];
      let bestAcc = evaluateFast(thresholds);

      for (const candidate of candidates) {
        thresholds[rPos] = candidate;
        const acc = evaluateFast(thresholds);
        const candidateBetter =
          acc > bestAcc ||
          (acc === bestAcc &&
            Math.abs(candidate - anchorThreshold) < Math.abs(bestThresh - anchorThreshold));

        if (candidateBetter) {
          bestAcc = acc;
          bestThresh = candidate;
        }
      }
      thresholds[rPos] = bestThresh;
    }
  }

  enabledIndices.forEach((idx, rPos) => {
    workingRoutes[idx].scoreThreshold = thresholds[rPos];
  });

  const afterReport = evaluateDataset(cases, workingRoutes, config, vectorLookup);

  const changes: FitThresholdChange[] = workingRoutes
    .map((r, idx) => ({
      routeId: r.id,
      routeName: r.name,
      previousThreshold: routes[idx].scoreThreshold,
      optimizedThreshold: r.scoreThreshold,
    }))
    .filter((c) => Math.abs(c.previousThreshold - c.optimizedThreshold) > 0.0001);

  return {
    beforeAccuracy: beforeReport.accuracy,
    afterAccuracy: afterReport.accuracy,
    totalCases: cases.length,
    changes,
    updatedRoutes: workingRoutes,
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
