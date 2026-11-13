import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { resolveChatGptSystemPrompt } from './instructions.ts';
import type { UnifiedRouterService } from './routerService.ts';
import type { TelemetryCollector } from './telemetry.ts';
import type { McpStdioLogEntry } from './types.ts';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export const MCP_PROTOCOL_VERSION = '2024-11-05';

export const MCP_TOOL_DEFINITIONS = [
  {
    name: 'route_prompt',
    description:
      'Route an incoming prompt via Semantic Router + EmbeddingsBridge, optionally retrieving RAG connector chunks and dispatching to ChatGPT or tool handlers.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'User prompt to route' },
        useRag: {
          type: 'boolean',
          description: 'Whether to retrieve top-K chunks from synced RAG connectors',
        },
        executeProvider: {
          type: 'boolean',
          description: 'Whether to execute the target handler / ChatGPT model',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'rag_retrieve',
    description:
      'Retrieve top-K hybrid semantic + sparse chunks from synced external webhook / URL RAG connectors.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query to match against RAG chunks' },
        topK: { type: 'number', description: 'Maximum chunks to return (default 3)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'sync_rag_connector',
    description:
      'Fetch and index an external webhook or URL RAG connector into the unified vector store.',
    inputSchema: {
      type: 'object',
      properties: {
        connectorId: { type: 'string', description: 'ID of the RAG connector to sync' },
      },
      required: ['connectorId'],
    },
  },
  {
    name: 'list_routes',
    description:
      'List all configured semantic routes, thresholds, target handlers, and per-route instruction overrides.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_system_instructions',
    description:
      'Inspect the active Embedding LM instruction templates and ChatGPT AI system instructions.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'trinity_rag_query',
    description:
      'Query external TRINITY Core RAG (:7700 POST /query) for ranked FAISS + UAGL tier/kappa chunks.',
    inputSchema: {
      type: 'object',
      properties: {
        queryText: { type: 'string', description: 'Semantic query text for TRINITY /query' },
        k: { type: 'number', description: 'Top-K chunks to return (default 5)' },
        tierFilter: {
          type: 'string',
          description: 'Optional UAGL memory tier filter (e.g., HOT, WARM, COLD)',
        },
        minKappa: {
          type: 'number',
          description: 'Minimum resonance kappa score filter (default 0.0)',
        },
        trinityUrl: {
          type: 'string',
          description: 'Optional override base URL (default http://127.0.0.1:7700)',
        },
      },
      required: ['queryText'],
    },
  },
  {
    name: 'trinity_rag_context',
    description:
      'Fetch pre-formatted context string directly from TRINITY Core RAG (:7700 POST /context).',
    inputSchema: {
      type: 'object',
      properties: {
        queryText: { type: 'string', description: 'Query text for TRINITY /context' },
        k: { type: 'number', description: 'Top-K chunks to pack into context (default 5)' },
        trinityUrl: {
          type: 'string',
          description: 'Optional override base URL (default http://127.0.0.1:7700)',
        },
      },
      required: ['queryText'],
    },
  },
  {
    name: 'trinity_rag_ingest',
    description:
      'Ingest a knowledge chunk into TRINITY Core RAG (:7700 POST /ingest) with optional kappa and metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Text content to ingest into TRINITY FAISS index' },
        source: { type: 'string', description: 'Logical source tag' },
        sessionId: { type: 'string', description: 'Session identifier' },
        kappa: { type: 'number', description: 'Initial UAGL kappa score (0..1)' },
        metadata: { type: 'object', description: 'Optional JSON metadata object' },
        trinityUrl: {
          type: 'string',
          description: 'Optional override base URL (default http://127.0.0.1:7700)',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'get_project_progress',
    description:
      'Inspect current EM-3 milestone completion progress, active focus milestone, and shared AgentState route overrides.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'evaluate_project_progress',
    description:
      'Evaluate an agent/LLM output against project milestones via EM-3 (BAAI/bge-m3) and update completion state.',
    inputSchema: {
      type: 'object',
      properties: {
        outputText: {
          type: 'string',
          description: 'Generated output text to score against active milestones',
        },
      },
      required: ['outputText'],
    },
  },
];

export class McpStdioServer {
  private rl: readline.Interface | null = null;

  constructor(
    private readonly opts: {
      readable: NodeJS.ReadableStream;
      writable: NodeJS.WritableStream;
      service: UnifiedRouterService;
      telemetry?: TelemetryCollector;
      onLog?: (entry: McpStdioLogEntry) => void;
    }
  ) {}

  start(): void {
    this.rl = readline.createInterface({
      input: this.opts.readable,
      crlfDelay: Infinity,
    });

    this.rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      void this.handleLine(trimmed);
    });
  }

  stop(): void {
    this.rl?.close();
    this.rl = null;
  }

  private emitStdout(payload: JsonRpcResponse): void {
    const serialized = JSON.stringify(payload);
    this.opts.writable.write(`${serialized}\n`);
    this.opts.onLog?.({
      id: `mcp-out-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      direction: 'stdout',
      rpcId: payload.id,
      payload,
    });
  }

  async handleLine(rawLine: string): Promise<void> {
    const startNs = process.hrtime.bigint();
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(rawLine) as JsonRpcRequest;
    } catch {
      this.emitStdout({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error: invalid JSON-RPC payload' },
      });
      return;
    }

    const rpcId = req.id !== undefined ? req.id : null;
    this.opts.onLog?.({
      id: `mcp-in-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      direction: 'stdin',
      method: req.method,
      rpcId,
      payload: req,
    });

    // Notifications (no id) do not emit a response per JSON-RPC 2.0
    if (req.id === undefined) {
      return;
    }

    const endMcpSpan = this.opts.telemetry?.beginSpan('mcp->router');
    try {
      const result = await this.dispatchMethod(req.method, req.params ?? {});
      const durationMs =
        endMcpSpan?.('ok') ??
        Math.round((Number(process.hrtime.bigint() - startNs) / 1_000_000) * 100) / 100;

      this.opts.writable.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: rpcId, result } satisfies JsonRpcResponse)}\n`
      );
      this.opts.onLog?.({
        id: `mcp-out-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: new Date().toISOString(),
        direction: 'stdout',
        method: req.method,
        rpcId,
        durationMs,
        payload: { jsonrpc: '2.0', id: rpcId, result },
      });
    } catch (err) {
      endMcpSpan?.('error');
      const message = (err as Error).message || 'Internal MCP server error';
      const code = message.startsWith('Method not found') ? -32601 : -32602;
      this.emitStdout({
        jsonrpc: '2.0',
        id: rpcId,
        error: { code, message },
      });
    }
  }

  private async dispatchMethod(
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    if (!this.opts.service.getConfig().mcpEnabled) {
      throw new Error('MCP server transport is currently disabled in router configuration.');
    }

    if (method === 'initialize') {
      return {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
          prompts: { listChanged: false },
        },
        serverInfo: {
          name: 'semantic-router-rag-mcp',
          version: '1.0.0',
        },
      };
    }

    if (method === 'ping') {
      return { ok: true, timestamp: new Date().toISOString() };
    }

    if (method === 'tools/list') {
      return { tools: MCP_TOOL_DEFINITIONS };
    }

    if (method === 'tools/call') {
      const toolName = String(params.name ?? '').trim();
      const args = (params.arguments ?? {}) as Record<string, unknown>;

      if (toolName === 'route_prompt') {
        const query = String(args.query ?? '').trim();
        const decision = await this.opts.service.routePrompt({
          query,
          useRag: typeof args.useRag === 'boolean' ? args.useRag : undefined,
          executeProvider:
            typeof args.executeProvider === 'boolean' ? args.executeProvider : true,
          transport: 'mcp',
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(decision, null, 2) }],
          structuredContent: decision,
        };
      }

      if (toolName === 'rag_retrieve') {
        const query = String(args.query ?? '').trim();
        const topK = typeof args.topK === 'number' ? args.topK : 3;
        const result = await this.opts.service.queryRag({ query, topK });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      }

      if (toolName === 'sync_rag_connector') {
        const connectorId = String(args.connectorId ?? '').trim();
        const result = await this.opts.service.syncRagConnector(connectorId);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      }

      if (toolName === 'list_routes') {
        const routes = this.opts.service.getRoutes();
        return {
          content: [{ type: 'text', text: JSON.stringify({ routes }, null, 2) }],
          structuredContent: { routes },
        };
      }

      if (toolName === 'get_system_instructions') {
        const instructions = this.opts.service.getInstructions();
        return {
          content: [{ type: 'text', text: JSON.stringify(instructions, null, 2) }],
          structuredContent: instructions,
        };
      }

      if (toolName === 'trinity_rag_query') {
        const queryText = String(args.queryText ?? args.query ?? '').trim();
        const result = await this.opts.service.trinityQuery({
          queryText,
          k: typeof args.k === 'number' ? args.k : undefined,
          tierFilter: typeof args.tierFilter === 'string' ? args.tierFilter : null,
          minKappa: typeof args.minKappa === 'number' ? args.minKappa : undefined,
          trinityUrl: typeof args.trinityUrl === 'string' ? args.trinityUrl : undefined,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      }

      if (toolName === 'trinity_rag_context') {
        const queryText = String(args.queryText ?? args.query ?? '').trim();
        const result = await this.opts.service.trinityContext({
          queryText,
          k: typeof args.k === 'number' ? args.k : undefined,
          trinityUrl: typeof args.trinityUrl === 'string' ? args.trinityUrl : undefined,
        });
        return {
          content: [{ type: 'text', text: result.data.context || JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      }

      if (toolName === 'trinity_rag_ingest') {
        const content = String(args.content ?? '').trim();
        const result = await this.opts.service.trinityIngest({
          content,
          source: typeof args.source === 'string' ? args.source : undefined,
          sessionId: typeof args.sessionId === 'string' ? args.sessionId : undefined,
          kappa: typeof args.kappa === 'number' ? args.kappa : undefined,
          metadata:
            args.metadata && typeof args.metadata === 'object'
              ? (args.metadata as Record<string, unknown>)
              : undefined,
          trinityUrl: typeof args.trinityUrl === 'string' ? args.trinityUrl : undefined,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      }

      if (toolName === 'get_project_progress') {
        const progressState = this.opts.service.getProgressState();
        const agentState = this.opts.service.getAgentStateSnapshot();
        return {
          content: [{ type: 'text', text: JSON.stringify({ progressState, agentState }, null, 2) }],
          structuredContent: { progressState, agentState },
        };
      }

      if (toolName === 'evaluate_project_progress') {
        const outputText = String(args.outputText ?? '').trim();
        const result = await this.opts.service.evaluateProgressOutput(outputText);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      }

      throw new Error(`Unknown MCP tool: ${toolName}`);
    }

    if (method === 'resources/list') {
      return {
        resources: [
          {
            uri: 'router://routes',
            name: 'Semantic Routes Registry',
            mimeType: 'application/json',
          },
          {
            uri: 'router://instructions',
            name: 'Embedding & ChatGPT System Instructions',
            mimeType: 'application/json',
          },
          {
            uri: 'rag://connectors',
            name: 'External Webhook & URL RAG Connectors',
            mimeType: 'application/json',
          },
          {
            uri: 'rag://chunks',
            name: 'Indexed RAG Knowledge Chunks',
            mimeType: 'application/json',
          },
          {
            uri: 'trinity://health',
            name: 'TRINITY :7700 Core Health & UAGL Stats',
            mimeType: 'application/json',
          },
          {
            uri: 'progress://state',
            name: 'EM-3 Project Milestone Progress & Agent State',
            mimeType: 'application/json',
          },
        ],
      };
    }

    if (method === 'resources/read') {
      const uri = String(params.uri ?? '');
      let data: unknown;
      if (uri === 'router://routes') data = this.opts.service.getRoutes();
      else if (uri === 'router://instructions') data = this.opts.service.getInstructions();
      else if (uri === 'rag://connectors') data = this.opts.service.getRagConnectors();
      else if (uri === 'rag://chunks') data = this.opts.service.getRagChunks();
      else if (uri === 'trinity://health') data = await this.opts.service.getTrinityHealth();
      else if (uri === 'progress://state') {
        data = {
          progressState: this.opts.service.getProgressState(),
          agentState: this.opts.service.getAgentStateSnapshot(),
        };
      }
      else throw new Error(`Unknown resource URI: ${uri}`);

      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    }

    if (method === 'prompts/list') {
      return {
        prompts: [
          {
            name: 'chatgpt_route_system_prompt',
            description: 'Render resolved ChatGPT AI system prompt for an optional route name',
            arguments: [{ name: 'routeName', required: false }],
          },
        ],
      };
    }

    if (method === 'prompts/get') {
      const promptName = String(params.name ?? '');
      if (promptName !== 'chatgpt_route_system_prompt') {
        throw new Error(`Unknown prompt: ${promptName}`);
      }
      const pArgs = (params.arguments ?? {}) as Record<string, string>;
      const route = pArgs.routeName
        ? this.opts.service.getRoutes().find((r) => r.name === pArgs.routeName) ?? null
        : null;
      const rendered = resolveChatGptSystemPrompt(this.opts.service.getInstructions().chatgpt, {
        route,
      });
      return {
        description: 'Resolved ChatGPT System Instructions',
        messages: [
          {
            role: 'user',
            content: { type: 'text', text: rendered },
          },
        ],
      };
    }

    throw new Error(`Method not found: ${method}`);
  }
}

/**
 * Executes a single JSON-RPC 2.0 frame through real Node stdin/stdout PassThrough streams
 * so the in-app UI bridge exercises genuine stdio framing and emits live telemetry.
 */
export async function invokeSingleMcpJsonRpc(
  service: UnifiedRouterService,
  telemetry: TelemetryCollector,
  rawPayload: string | Record<string, unknown>
): Promise<{
  stdinFrame: string;
  stdoutFrame: string;
  response: JsonRpcResponse;
  durationMs: number;
}> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const startNs = process.hrtime.bigint();

  const server = new McpStdioServer({
    readable: stdin,
    writable: stdout,
    service,
    telemetry,
    onLog: (entry) => service.recordMcpLog(entry),
  });
  server.start();

  let frameStr: string;
  if (typeof rawPayload === 'string') {
    const trimmed = rawPayload.trim();
    try {
      frameStr = JSON.stringify(JSON.parse(trimmed));
    } catch {
      frameStr = trimmed.replace(/\r?\n/g, ' ');
    }
  } else {
    frameStr = JSON.stringify(rawPayload);
  }

  const responsePromise = new Promise<string>((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      reject(new Error('MCP stdio bridge timed out waiting for stdout response.'));
    }, 15_000);

    stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8');
      const nlIdx = buffer.indexOf('\n');
      if (nlIdx !== -1) {
        clearTimeout(timer);
        resolve(buffer.slice(0, nlIdx).trim());
      }
    });
  });

  stdin.write(`${frameStr}\n`);
  const stdoutFrame = await responsePromise;
  server.stop();

  const durationMs =
    Math.round((Number(process.hrtime.bigint() - startNs) / 1_000_000) * 100) / 100;

  return {
    stdinFrame: frameStr,
    stdoutFrame,
    response: JSON.parse(stdoutFrame) as JsonRpcResponse,
    durationMs,
  };
}
