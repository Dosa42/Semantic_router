import type { RouteDefinition, RouterConfig } from './types.ts';

export function generatePythonSdkCode(routes: RouteDefinition[], config: RouterConfig): string {
  const enabled = routes.filter((r) => r.enabled);
  const routerClass = config.mode === 'hybrid' ? 'HybridRouter' : 'SemanticRouter';

  const routeDefs = enabled
    .map((r) => {
      const uttList = r.utterances
        .map((u) => `        ${JSON.stringify(u)},`)
        .join('\n');
      const schemaLine =
        r.routeType === 'dynamic' && r.functionSchema
          ? `\n    function_schemas=[${JSON.stringify({
              name: r.functionSchema.name,
              description: r.functionSchema.description,
              parameters: r.functionSchema.parameters,
            })}],`
          : '';

      return `${toValidPythonVar(r.name)} = Route(
    name=${JSON.stringify(r.name)},
    utterances=[
${uttList}
    ],
    score_threshold=${r.scoreThreshold.toFixed(2)},${schemaLine}
)`;
    })
    .join('\n\n');

  const routeVarNames = enabled.map((r) => toValidPythonVar(r.name)).join(', ');

  const encoderImport =
    config.encoderModel === 'e5-small-v2' ? 'HuggingFaceEncoder' : 'FastEmbedEncoder';

  const encoderDecl =
    config.encoderModel === 'e5-small-v2'
      ? 'dense_encoder = HuggingFaceEncoder(name="intfloat/e5-small-v2")'
      : 'dense_encoder = FastEmbedEncoder(name="BAAI/bge-small-en-v1.5")';

  const routerInit =
    config.mode === 'hybrid'
      ? `router = HybridRouter(
    encoder=dense_encoder,
    sparse_encoder=sparse_encoder,
    routes=[${routeVarNames}],
    alpha=${config.alpha.toFixed(2)},
    aggregation=${JSON.stringify(config.aggregation)},
    auto_sync="local",
)`
      : `router = SemanticRouter(
    encoder=dense_encoder,
    routes=[${routeVarNames}],
    aggregation=${JSON.stringify(config.aggregation)},
    auto_sync="local",
)`;

  return `from semantic_router import Route
from semantic_router.routers import ${routerClass}
from semantic_router.encoders import ${encoderImport}${config.mode === 'hybrid' ? ', BM25Encoder' : ''}

${encoderDecl}
${config.mode === 'hybrid' ? 'sparse_encoder = BM25Encoder()\n' : ''}
${routeDefs}

${routerInit}

# Route an incoming LLM prompt in milliseconds
decision = router("Write a PostgreSQL query for weekly retention")
print(decision.name, decision.similarity_score)`;
}

export function generateTypeScriptSdkCode(config: RouterConfig): string {
  return `interface RouteDecision {
  matchedRoute: string | null;
  topScore: number;
  thresholdUsed: number | null;
  latencyMs: number;
  targetModel: string | null;
  functionCall: {
    name: string;
    arguments: Record<string, unknown>;
  } | null;
}

export async function routePrompt(query: string): Promise<RouteDecision> {
  const response = await fetch("/api/route", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      mode: ${JSON.stringify(config.mode)},
      alpha: ${config.alpha.toFixed(2)},
      aggregation: ${JSON.stringify(config.aggregation)},
    }),
  });

  if (!response.ok) {
    throw new Error(\`Routing failed: \${response.status}\`);
  }

  return response.json();
}`;
}

export function generateCurlSdkCode(config: RouterConfig): string {
  return `curl -X POST http://localhost:3000/api/route \\
  -H "Content-Type: application/json" \\
  -d '{
    "query": "What is the current local time in Tokyo right now?",
    "mode": "${config.mode}",
    "alpha": ${config.alpha.toFixed(2)},
    "aggregation": "${config.aggregation}"
  }'`;
}

function toValidPythonVar(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!cleaned || /^[0-9]/.test(cleaned)) {
    return `route_${cleaned || 'custom'}`;
  }
  return `${cleaned}_route`;
}
