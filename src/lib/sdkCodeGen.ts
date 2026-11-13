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
  ragMatches?: Array<{ connectorName: string; score: number; text: string }>;
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
      useRag: ${String(config.ragEnabledByDefault)},
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
    "aggregation": "${config.aggregation}",
    "useRag": ${String(config.ragEnabledByDefault)}
  }'`;
}

export function generateMcpClientConfigSnippet(): string {
  return JSON.stringify(
    {
      mcpServers: {
        'semantic-router-rag': {
          command: 'npm',
          args: ['run', 'mcp', '--silent'],
          cwd: '/path/to/Semantic_router',
          transport: 'stdio',
        },
      },
    },
    null,
    2
  );
}

export const MCP_JSONRPC_PRESETS: Array<{
  label: string;
  description: string;
  payload: Record<string, unknown>;
}> = [
  {
    label: 'initialize',
    description: 'MCP handshake & capability negotiation',
    payload: {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'studio-bridge', version: '1.0.0' },
      },
    },
  },
  {
    label: 'tools/list',
    description: 'Discover available Semantic Router & RAG MCP tools',
    payload: {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    },
  },
  {
    label: 'tools/call · route_prompt',
    description: 'Route SQL query with RAG augmentation over MCP stdio',
    payload: {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'route_prompt',
        arguments: {
          query: 'Write a PostgreSQL query using window functions to rank customers',
          useRag: true,
          executeProvider: true,
        },
      },
    },
  },
  {
    label: 'tools/call · rag_retrieve',
    description: 'Search synced RAG connector chunks directly',
    payload: {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'rag_retrieve',
        arguments: {
          query: 'How does hybrid BM25 and e5-small-v2 scoring work?',
          topK: 3,
        },
      },
    },
  },
  {
    label: 'resources/list',
    description: 'List exposed router:// and rag:// MCP resources',
    payload: {
      jsonrpc: '2.0',
      id: 5,
      method: 'resources/list',
      params: {},
    },
  },
];

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
