import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatGptAuthManager } from './src/lib/chatgptAuth.ts';
import { McpStdioServer } from './src/lib/mcpServer.ts';
import { UnifiedRouterService } from './src/lib/routerService.ts';
import { TelemetryCollector } from './src/lib/telemetry.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const telemetry = new TelemetryCollector();
const chatgptAuth = new ChatGptAuthManager(__dirname);
const service = new UnifiedRouterService(__dirname, chatgptAuth, telemetry);

telemetry.attachStateProvider(() => service.getTelemetryStateInput(Number(process.env.PORT) || 3000));

const mcpServer = new McpStdioServer({
  readable: process.stdin,
  writable: process.stdout,
  service,
  telemetry,
});

// Keep stdout clean for JSON-RPC 2.0 frames; emit startup diagnostics solely to stderr.
console.error('[Semantic Router MCP] Listening on stdin/stdout (JSON-RPC 2.0)');
void service.warmUpEmbeddings();
mcpServer.start();
