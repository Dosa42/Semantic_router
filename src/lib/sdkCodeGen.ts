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
        semantic_router_rag: {
          command: './node_modules/.bin/tsx',
          args: ['mcp-server.ts'],
          cwd: '/path/to/Semantic_router',
          env: {
            TRINITY_URL: 'http://127.0.0.1:7700',
          },
          transport: 'stdio',
        },
      },
    },
    null,
    2
  );
}

export function generateCodexCliTomlSnippet(): string {
  return `# ~/.codex/config.toml — Option 1: MCP stdio server (Default for Codex CLI)
# Auto-bridges to http://127.0.0.1:3000/api/mcp/stdio when the Studio server is running
# so Telemetry SVG edges glow live, and falls back to standalone local state when offline.

[mcp_servers.semantic_router]
command = "./node_modules/.bin/tsx"
args = ["mcp-server.ts"]
cwd = "/path/to/Semantic_router"

[mcp_servers.semantic_router.env]
TRINITY_URL = "http://127.0.0.1:7700"
# Uncomment to force isolated local mode even when :3000 is running:
# SEMANTIC_ROUTER_MODE = "direct"`;
}

export function generateCodexMcpAddCommand(): string {
  return `codex mcp add semantic_router --env TRINITY_URL=http://127.0.0.1:7700 -- ./node_modules/.bin/tsx /path/to/Semantic_router/mcp-server.ts`;
}

export function generateCodexOption2HttpSnippet(config: RouterConfig): string {
  return `# Option 2: Direct HTTP REST + TRINITY :7700 Bridge (used via shell / curl or AGENTS.md)
# 1) Route a prompt via Semantic Router (:3000) with hybrid ${config.mode} + RAG:
curl -s -X POST http://127.0.0.1:3000/api/route \\
  -H "Content-Type: application/json" \\
  -d '{"query":"Check UAGL tier distribution in TRINITY","useRag":true,"executeProvider":false}'

# 2) Query external TRINITY Core (:7700 /query) through Router Telemetry (:3000/api/trinity/query):
curl -s -X POST http://127.0.0.1:3000/api/trinity/query \\
  -H "Content-Type: application/json" \\
  -d '{"queryText":"Semantic Router architecture","k":5,"minKappa":0.0}'

# 3) Fetch packed TRINITY context (:7700 /context -> :3000/api/trinity/context):
curl -s -X POST http://127.0.0.1:3000/api/trinity/context \\
  -H "Content-Type: application/json" \\
  -d '{"queryText":"UAGL tier transitions","k":5}'`;
}

export function generateCodexAgentsSnippet(): string {
  return `# AGENTS.md (project instruction for Codex CLI)
Before answering architecture, SQL, billing, or RAG questions:
1. Call MCP tool \`semantic_router.route_prompt\` to classify intent and load bound RAG context.
2. Call \`semantic_router.trinity_rag_query\` or \`semantic_router.trinity_rag_context\` to query TRINITY (:7700).
3. If HTTP server :3000 is down, \`mcp-server.ts\` executes locally against \`data/router-state.json\`.`;
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
        clientInfo: { name: 'codex-cli-bridge', version: '1.0.0' },
      },
    },
  },
  {
    label: 'tools/list',
    description: 'Discover Semantic Router, RAG, and TRINITY :7700 MCP tools',
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
    description: 'Search synced RAG connector & REA Agents chunks directly',
    payload: {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'rag_retrieve',
        arguments: {
          query: 'How does REA Agents expose Frida instrumentation over MCP?',
          topK: 3,
        },
      },
    },
  },
  {
    label: 'tools/call · list_ingested_packages',
    description: 'Inspect vectorized ZIP package knowledge stores (rea-agents@6.8.0)',
    payload: {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: {
        name: 'list_ingested_packages',
        arguments: {},
      },
    },
  },
  {
    label: 'tools/call · trinity_rag_query',
    description: 'Invoke TRINITY :7700 /query wrapped as an MCP tool',
    payload: {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'trinity_rag_query',
        arguments: {
          queryText: 'Unified Semantic Router and UAGL tiering',
          k: 5,
          minKappa: 0.0,
        },
      },
    },
  },
  {
    label: 'tools/call · trinity_rag_context',
    description: 'Invoke TRINITY :7700 /context wrapped as an MCP tool',
    payload: {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'trinity_rag_context',
        arguments: {
          queryText: 'Semantic Router architecture overview',
          k: 5,
        },
      },
    },
  },
  {
    label: 'resources/list',
    description: 'List exposed router://, rag://, and trinity:// MCP resources',
    payload: {
      jsonrpc: '2.0',
      id: 7,
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
