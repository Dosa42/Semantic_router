import 'dotenv/config';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { ChatGptAuthManager } from './src/lib/chatgptAuth.ts';
import { McpStdioServer } from './src/lib/mcpServer.ts';
import { UnifiedRouterService } from './src/lib/routerService.ts';
import { TelemetryCollector } from './src/lib/telemetry.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const port = Number(process.env.SEMANTIC_ROUTER_PORT) || 3000;
const directMode =
  process.argv.includes('--direct') ||
  (process.env.SEMANTIC_ROUTER_MODE ?? '').trim().toLowerCase() === 'direct';
const expressMcpBridgeUrl =
  (process.env.SEMANTIC_ROUTER_HTTP_URL ?? '').trim() ||
  `http://127.0.0.1:${port}/api/mcp/stdio`;

const telemetry = new TelemetryCollector();
const chatgptAuth = new ChatGptAuthManager(__dirname);
const service = new UnifiedRouterService(__dirname, chatgptAuth, telemetry);

telemetry.attachStateProvider(() => service.getTelemetryStateInput(port));

const mcpServer = new McpStdioServer({
  readable: process.stdin,
  writable: process.stdout,
  service,
  telemetry,
});

async function tryForwardToExpressBridge(rawLine: string): Promise<string | null> {
  if (directMode) return null;

  let parsed: { id?: unknown };
  try {
    parsed = JSON.parse(rawLine) as { id?: unknown };
  } catch {
    return null;
  }

  // Notifications have no id and expect no JSON-RPC response frame
  if (parsed.id === undefined) {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 16_000);
  try {
    const res = await fetch(expressMcpBridgeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: rawLine }),
      signal: controller.signal,
    });
    const text = await res.text();
    let payload: { stdoutFrame?: string; response?: unknown };
    try {
      payload = JSON.parse(text) as { stdoutFrame?: string; response?: unknown };
    } catch {
      return null;
    }
    if (typeof payload.stdoutFrame === 'string' && payload.stdoutFrame.trim()) {
      return payload.stdoutFrame.trim();
    }
    if (payload.response !== undefined) {
      return JSON.stringify(payload.response);
    }
    return null;
  } catch {
    // Express :3000 offline or unreachable -> gracefully fall back to standalone local MCP engine
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  void (async () => {
    const bridged = await tryForwardToExpressBridge(trimmed);
    if (bridged !== null) {
      process.stdout.write(`${bridged}\n`);
      return;
    }
    await mcpServer.handleLine(trimmed);
  })();
});

// Keep stdout clean for JSON-RPC 2.0 frames; emit startup diagnostics solely to stderr.
console.error(
  `[Semantic Router MCP] Listening on stdin/stdout (JSON-RPC 2.0) · mode=${
    directMode ? 'direct-local' : `auto-sync(${expressMcpBridgeUrl})`
  }`
);
void service.warmUpEmbeddings();
