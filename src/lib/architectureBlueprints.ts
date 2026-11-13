import type {
  ArchitectureComparisonRow,
  LibraryKnowledgeState,
} from './types.ts';

export const SEMANTIC_ROUTER_MERMAID = `flowchart TB
  classDef ingress fill:#f8fafc,stroke:#334155,stroke-width:1.5px,color:#0f172a
  classDef shared fill:#eff6ff,stroke:#1d4ed8,stroke-width:1.8px,color:#0f172a
  classDef rag fill:#ecfdf5,stroke:#047857,stroke-width:1.6px,color:#0f172a
  classDef gov fill:#fffbeb,stroke:#b45309,stroke-width:1.6px,color:#0f172a

  subgraph INGRESS["1. Dual Ingress & Framing (Node.js 22 / TypeScript)"]
    UI["Client Browser (App.tsx)<br/>HTTP + EventSource SSE"]:::ingress
    EXP["Express Gateway (server.ts)<br/>0.0.0.0:3000 · /api/route · /api/rag/*"]:::ingress
    MCP_CLI["MCP Client / SdkView Bridge<br/>mcp-server.ts · PassThrough stdio"]:::ingress
    MCP_SRV["McpStdioServer (mcpServer.ts)<br/>JSON-RPC 2.0 · tools/call · resources/read"]:::ingress
  end

  subgraph SHARED["2. Shared Semantic Core & EmbeddingsBridge"]
    URS["UnifiedRouterService (routerService.ts)<br/>Single Orchestrator · hrtime Spans"]:::shared
    EMB_INST["formatEmbeddingText (instructions.ts)<br/>query:/passage: · taskInstruction · routeOverride"]:::gov
    BRIDGE["EmbeddingsBridge (buildVectorLookup)<br/>e5EmbeddingCache Map + Batch 24"]:::shared
    ONNX["Xenova/e5-small-v2 (ONNX q8 384d)<br/>Fallback: computeLocalDenseVector 256d"]:::shared
    SCORE["scoreRoutes (routerEngine.ts)<br/>alpha*Dense + (1-alpha)*BM25 · max/mean/top_k"]:::shared
  end

  subgraph RAG_STORE["3. Unified RAG Connectors & Persistence"]
    HOOK["fetchAndChunkConnector (ragEngine.ts)<br/>External HTTP/HTTPS Webhook & URL Fetch"]:::rag
    PARSE["extractContentFromResponse + chunkText<br/>JSONPath / HTML Strip / Overlap Chunks"]:::rag
    RAG_SC["scoreRagChunks (Hybrid Retrieval)<br/>routeId Scope + Top-K Dense/Sparse"]:::rag
    STATE["router-state.json + TelemetryCollector<br/>Routes · Chunks · 8 Live Span Edges"]:::rag
  end

  subgraph EXEC_AUTH["4. Provider Dispatch, Instructions & OAuth PKCE"]
    PARAMS["extractDynamicParameters<br/>ChatGPT JSON or Local Regex"]:::gov
    GPT_INST["resolveChatGptSystemPrompt<br/>Per-Route Override + Citations [1..K]"]:::gov
    OAUTH["ChatGptAuthManager (chatgptAuth.ts)<br/>127.0.0.1:1455 PKCE + chatgpt-auth.json"]:::gov
    TARGET["Target Execution (:443 / Local)<br/>api.openai.com/v1/responses | Tools | Guardrails"]:::gov
  end

  UI -->|"HTTP/SSE :3000 (browser to express)"| EXP
  EXP -->|"transport: http (express to router)"| URS
  MCP_CLI -->|"stdin / stdout lines"| MCP_SRV
  MCP_SRV -->|"transport: mcp (mcp to router)"| URS

  URS -->|"apply template"| EMB_INST
  EMB_INST -->|"router to bridge"| BRIDGE
  BRIDGE -->|"bridge to embedding"| ONNX
  ONNX -->|"384d / 256d vectors"| SCORE

  URS -->|"router to rag_connector :443"| HOOK
  HOOK --> PARSE
  PARSE --> STATE
  SCORE -->|"matchedRoute"| RAG_SC
  STATE --> RAG_SC

  URS -->|"dynamic route"| PARAMS
  RAG_SC -->|"top-K chunks"| GPT_INST
  PARAMS --> GPT_INST
  GPT_INST -->|"router to chatgpt :443"| TARGET
  OAUTH -->|"chatgpt to loopback :1455"| TARGET
  URS -->|"live span metrics"| STATE`;

export const TORRENT_RAG_UAGL_MERMAID = `flowchart TB
  classDef ingress fill:#f8fafc,stroke:#334155,stroke-width:1.5px,color:#0f172a
  classDef shared fill:#eff6ff,stroke:#1d4ed8,stroke-width:1.8px,color:#0f172a
  classDef rag fill:#ecfdf5,stroke:#047857,stroke-width:1.6px,color:#0f172a
  classDef gov fill:#fffbeb,stroke:#b45309,stroke-width:1.6px,color:#0f172a

  subgraph INGRESS["1. Multi-Port Ingress & P2P Swarm (Python asyncio)"]
    direction TB
    TRK["TrinityTrackerServer (:6969 HTTP)<br/>/announce · /scrape (5m TTL)"]:::ingress
    P2P["P2PWireProtocol + PeerManager<br/>4B Len + zlib(JSON) · 22 Opcodes + DHT"]:::ingress
    API["Trinity Core FastAPI (:7700)<br/>/ingest · /query · /context"]:::ingress
    UAG_SRV["UAGLBroker AI2AI Server (:9000 TCP)<br/>Wire Magic 'UAG3' + Ligature"]:::ingress
    TRK -->|"peer lists :6969"| P2P
  end

  subgraph SHARED["2. Shared Semantic Core & Vector Engine"]
    direction TB
    CORE["TrinityRAGServer (trinity_core.py)<br/>asyncio.Lock + Hot LRU Cache (500)"]:::shared
    UAG_RT["execute_uagl (uagl_runtime.py)<br/>Glyph Parse · Density Mult · Chain"]:::gov
    SFE["SemanticForceEngine<br/>all-MiniLM-L6-v2 (384d) + SHA-512"]:::shared
    FAISS["FAISSIndex (IndexFlatIP 384d)<br/>Cosine Sim · Numpy Linear Fallback"]:::shared
    RANK["Hybrid Force Ranker<br/>0.7*FAISS + 0.3*kappa · min_kappa"]:::shared
  end

  subgraph RAG_STORE["3. SDCK Tiered Lifecycle, SQLite & Torrent Pieces"]
    direction TB
    SDCK["SDCKCanon (classify)<br/>len + access + source_wt + 0.3*kappa"]:::rag
    TIERS["StorageManager (trinity_storage.py)<br/>HOT SSD -> WARM -> COLD zlib -> FROZEN"]:::rag
    PIECES["TorrentPieceCache (256 KiB)<br/>Bitfield + SHA-1 Pieces"]:::rag
    SQLITE["TrinityMetadataStore (SQLite)<br/>trinity_metadata.db · chunks + query_log"]:::rag
  end

  subgraph EXEC_AUTH["4. UAGL R4 Manifold, TESSA & Security"]
    direction TB
    FV["ForceVector R4 (g1, g2, g3, g4)<br/>V-Path V1..V10 + V3/V8 Bifurcation"]:::gov
    TESSA["tessa_classify -> Permission<br/>ALLOW | MONITOR (kappa under 0.5) | ISOLATE (under 0.3)"]:::gov
    GSIG["guardian_sign (BLAKE2b-8)<br/>Sig 'G3·HEX' + 7-Layer AST Obfuscator"]:::gov
    CTX_OUT["get_context_for_llm -> External LLM<br/>[1..K] source + kappa + tier"]:::gov
  end

  API -->|"REST JSON :7700"| CORE
  P2P -->|"KNOWLEDGE_DATA / PIECE 0x0A"| CORE
  UAG_SRV -->|"session.advance()"| UAG_RT

  UAG_RT -->|"final_fv + kappa"| CORE
  CORE -->|"embed(text)"| SFE
  SFE -->|"float32 384d"| FAISS
  FAISS -->|"k*3 candidates"| RANK

  CORE -->|"classify tier"| SDCK
  SDCK --> TIERS
  TIERS -->|"tier webhook :7700"| API
  CORE --> SQLITE
  P2P <-->|"bitfield / pieces"| PIECES

  UAG_RT --> FV
  FV --> TESSA
  TESSA -->|"kappa gate"| RANK
  UAG_SRV --> GSIG
  RANK --> CTX_OUT`;

export const ARCHITECTURE_COMPARISON_MATRIX: ArchitectureComparisonRow[] = [
  {
    dimension: 'Runtime & Process Model',
    semanticRouterStudio:
      'TypeScript / Node.js 22 + React 19 Vite SPA + Express (:3000) + standalone MCP stdio CLI.',
    torrentRagUagl:
      'Python 3 asyncio microservices: FastAPI RAG (:7700), BitTorrent Tracker (:6969), UAG3 TCP Broker (:9000), P2P Wire TCP.',
    sharedPattern:
      'Unified central orchestrator decoupling transport ingress from embedding & retrieval logic.',
  },
  {
    dimension: 'Ingress & Transport Framing',
    semanticRouterStudio:
      'HTTP REST + EventSource SSE (:3000) + newline JSON-RPC 2.0 stdio (stdin/stdout) with PassThrough UI bridge.',
    torrentRagUagl:
      'FastAPI REST (:7700) + HTTP Tracker (:6969) + zlib length-prefixed P2P TCP + 74B+ UAG3 binary frames (:9000).',
    sharedPattern:
      'Dual-ingress philosophy: human/dashboard HTTP API alongside machine-to-machine agent wire transport.',
  },
  {
    dimension: 'Dense Embeddings & Scoring',
    semanticRouterStudio:
      'Xenova/e5-small-v2 (ONNX 384d, query:/passage:) + local 256d projection + BM25 lexical alpha blending.',
    torrentRagUagl:
      'SentenceTransformer all-MiniLM-L6-v2 (384d) + SHA-512 hash fallback + FAISS IndexFlatIP + kappa score blending (0.7/0.3).',
    sharedPattern:
      '384-dimensional normalized float32 dense vectors with deterministic zero-dependency hash/projection fallback.',
  },
  {
    dimension: 'Prompt / Control Governance',
    semanticRouterStudio:
      'Dual System Instructions (Embedding templates + ChatGPT system/extraction prompts) + per-route overrides + safety guardrail routes.',
    torrentRagUagl:
      'UAGL 3.0 R4 ForceVector (g1..g4) stateful session chaining, V1..V10 manifold tracking, and TESSA ALLOW/MONITOR/ISOLATE gates.',
    sharedPattern:
      'Pre-execution semantic policy layer shaping and gating inference before final target execution.',
  },
  {
    dimension: 'RAG Ingestion & Knowledge Sync',
    semanticRouterStudio:
      'Pull-based external HTTP/HTTPS Webhook & URL fetchers (JSONPath, HTML-to-text, overlap chunking) scoped by route bindings.',
    torrentRagUagl:
      'Push POST /ingest + BitTorrent-style 256 KiB PieceCache bitfields + Kademlia DHT & P2P peer gossip.',
    sharedPattern:
      'Chunked text retrieval returning scored top-K citations ([1..K]) formatted directly for LLM prompt grounding.',
  },
  {
    dimension: 'Storage & Persistence',
    semanticRouterStudio:
      'JSON state snapshot (router-state.json) + in-memory E5 vector Map cache + persistent Library Knowledge store.',
    torrentRagUagl:
      'SQLite (trinity_metadata.db) + FAISS vector index + 4-tier lifecycle (HOT/WARM/COLD zlib/FROZEN) with hourly consolidation.',
    sharedPattern:
      'Hot in-memory caching layered in front of durable disk metadata and vector blobs.',
  },
  {
    dimension: 'Security, Auth & Integrity',
    semanticRouterStudio:
      'OpenAI OAuth2 + PKCE S256 (127.0.0.1:1455 loopback / device flow) + telemetry secret redaction.',
    torrentRagUagl:
      'BLAKE2b guardian_sign ("G3·HEX") per wire packet + 7-layer AST + Göktürk symbol UAGLObfuscator + Unix-style Permission masks.',
    sharedPattern:
      'Cryptographic verification bound to session/sequence identity before privileged model/storage actions.',
  },
  {
    dimension: 'Observability & Telemetry',
    semanticRouterStudio:
      'Millisecond hrtime.bigint() active/decay spans streamed via SSE to dynamic SVG node/port topology.',
    torrentRagUagl:
      'SQLite query_log + UAGL ASCII kbar/trace execution dumps + PEER_EXEC session broadcasts + Tracker /scrape stats.',
    sharedPattern:
      'End-to-end execution trace logging capturing latency, confidence/kappa scores, and transport status.',
  },
];

export const DEFAULT_LIBRARY_KNOWLEDGE: LibraryKnowledgeState = {
  version: '1.0.0',
  updatedAt: '2026-11-13T11:10:00.000Z',
  notes:
    'Comparative architectural library contrasting Semantic Router Studio (TypeScript/Node ONNX e5-small-v2 + MCP stdio + External RAG Webhooks + ChatGPT OAuth PKCE) with Torrent-RAG-UAGL (Python asyncio TRINITY FAISS + SQLite 4-tier SDCK + BitTorrent 256KiB P2P swarm + UAGL 3.0 R4 ForceVector/TESSA governance). Use this library as a blueprint for bridging TRINITY FastAPI (:7700) as an External RAG Connector or MCP tool target.',
  blueprints: [
    {
      id: 'semantic-router-studio',
      title: 'Semantic Router Studio',
      stackLabel: 'TypeScript · Node.js 22 · React 19 · Express :3000 + MCP stdio',
      summary:
        'Single-node unified routing & instruction workbench blending Xenova/e5-small-v2 ONNX 384d + BM25, MCP JSON-RPC stdio, external webhook RAG connectors, and OpenAI ChatGPT OAuth2 PKCE.',
      portsAndProtocols: [
        '0.0.0.0:3000 HTTP/SSE',
        'stdin/stdout JSON-RPC 2.0',
        '127.0.0.1:1455 OAuth PKCE',
        ':443 OpenAI & RAG HTTPS',
      ],
      mermaidCode: SEMANTIC_ROUTER_MERMAID,
    },
    {
      id: 'torrent-rag-uagl',
      title: 'Torrent-RAG-UAGL (TRINITY + UAGL 3.0)',
      stackLabel: 'Python asyncio · FastAPI :7700 · Tracker :6969 · UAG3 TCP :9000',
      summary:
        'Distributed P2P RAG + symbolic safety calculus combining FAISS IndexFlatIP (MiniLM 384d), SQLite 4-tier SDCK lifecycle, BitTorrent 256 KiB piece swarming, and UAGL R4 ForceVector + TESSA gating.',
      portsAndProtocols: [
        ':7700 FastAPI RAG',
        ':6969 Tracker HTTP',
        ':9000 UAG3 Binary TCP',
        'TCP P2P + Kademlia DHT',
      ],
      mermaidCode: TORRENT_RAG_UAGL_MERMAID,
    },
  ],
  comparisonMatrix: ARCHITECTURE_COMPARISON_MATRIX,
};

export function buildLibraryKnowledgeMarkdown(knowledge: LibraryKnowledgeState): string {
  const [left, right] = knowledge.blueprints;
  const rows = knowledge.comparisonMatrix
    .map(
      (r) =>
        `| **${r.dimension}** | ${r.semanticRouterStudio} | ${r.torrentRagUagl} | ${r.sharedPattern} |`
    )
    .join('\n');

  return `# Architecture Library Knowledge — Dual System Blueprints

Updated: ${knowledge.updatedAt} · Version: ${knowledge.version}

## Library Notes
${knowledge.notes}

---

## Side A: ${left.title}
**Stack:** ${left.stackLabel}
**Ports & Protocols:** ${left.portsAndProtocols.join(' · ')}

${left.summary}

\`\`\`mermaid
${left.mermaidCode}
\`\`\`

---

## Side B: ${right.title}
**Stack:** ${right.stackLabel}
**Ports & Protocols:** ${right.portsAndProtocols.join(' · ')}

${right.summary}

\`\`\`mermaid
${right.mermaidCode}
\`\`\`

---

## Shared Architecture vs. Side-Specific Differences

| Dimension | ${left.title} | ${right.title} | Shared Pattern |
|---|---|---|---|
${rows}
`;
}
