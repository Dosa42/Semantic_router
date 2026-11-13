import React, { useEffect, useMemo, useState } from 'react';
import { Activity, Check, Copy, Play, Terminal } from 'lucide-react';
import {
  MCP_JSONRPC_PRESETS,
  generateCodexAgentsSnippet,
  generateCodexCliTomlSnippet,
  generateCodexMcpAddCommand,
  generateCodexOption2HttpSnippet,
  generateCurlSdkCode,
  generateMcpClientConfigSnippet,
  generatePythonSdkCode,
  generateTypeScriptSdkCode,
} from '../lib/sdkCodeGen';
import type { McpStdioLogEntry, RouteDefinition, RouterConfig } from '../lib/types';

interface SdkViewProps {
  routes: RouteDefinition[];
  config: RouterConfig;
  onToggleMcp: (enabled: boolean) => Promise<void>;
}

type SdkTab = 'codex-cli' | 'mcp-bridge' | 'mcp-config' | 'python' | 'typescript' | 'curl';

export function SdkView({ routes, config, onToggleMcp }: SdkViewProps) {
  const [tab, setTab] = useState<SdkTab>('codex-cli');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const [stdinText, setStdinText] = useState(() =>
    JSON.stringify(MCP_JSONRPC_PRESETS[2].payload, null, 2)
  );
  const [stdoutText, setStdoutText] = useState<string>('');
  const [lastDurationMs, setLastDurationMs] = useState<number | null>(null);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [runningMcp, setRunningMcp] = useState(false);
  const [logs, setLogs] = useState<McpStdioLogEntry[]>([]);

  // TRINITY :7700 live health & quick query tester state
  const [trinityUrl, setTrinityUrl] = useState('http://127.0.0.1:7700');
  const [trinityQuery, setTrinityQuery] = useState('Semantic Router architecture and UAGL tiers');
  const [trinityOutput, setTrinityOutput] = useState<string>('');
  const [trinityStatus, setTrinityStatus] = useState<'idle' | 'ok' | 'error'>('idle');
  const [testingTrinity, setTestingTrinity] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/mcp/logs');
        if (res.ok) {
          const data = (await res.json()) as { logs: McpStdioLogEntry[] };
          setLogs(data.logs);
        }
      } catch {
        // Non-blocking
      }
    })();
  }, []);

  const snippet = useMemo(() => {
    if (tab === 'mcp-config') return generateMcpClientConfigSnippet();
    if (tab === 'python') return generatePythonSdkCode(routes, config);
    if (tab === 'typescript') return generateTypeScriptSdkCode(config);
    return generateCurlSdkCode(config);
  }, [tab, routes, config]);

  const codexToml = useMemo(() => generateCodexCliTomlSnippet(), []);
  const codexCmd = useMemo(() => generateCodexMcpAddCommand(), []);
  const codexHttp = useMemo(() => generateCodexOption2HttpSnippet(config), [config]);
  const codexAgents = useMemo(() => generateCodexAgentsSnippet(), []);

  const copyText = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1800);
    } catch {
      // Clipboard fallback ignored cleanly
    }
  };

  const handleInvokeStdio = async (rawOverride?: string) => {
    const payload = (rawOverride ?? stdinText).trim();
    if (!payload) return;
    setRunningMcp(true);
    setMcpError(null);
    try {
      const res = await fetch('/api/mcp/stdio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: payload }),
      });
      const data = (await res.json()) as {
        stdoutFrame?: string;
        response?: unknown;
        durationMs?: number;
        logs?: McpStdioLogEntry[];
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error || 'MCP stdio invocation failed');
      }
      setStdoutText(JSON.stringify(data.response ?? data.stdoutFrame, null, 2));
      setLastDurationMs(data.durationMs ?? null);
      if (data.logs) setLogs(data.logs);
    } catch (err) {
      setMcpError((err as Error).message || 'Failed to execute MCP stdio frame');
    } finally {
      setRunningMcp(false);
    }
  };

  const handleTestTrinity = async (mode: 'health' | 'query' | 'context') => {
    setTestingTrinity(true);
    try {
      let res: Response;
      if (mode === 'health') {
        const qs = trinityUrl.trim() ? `?trinityUrl=${encodeURIComponent(trinityUrl.trim())}` : '';
        res = await fetch(`/api/trinity/health${qs}`);
      } else if (mode === 'query') {
        res = await fetch('/api/trinity/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            queryText: trinityQuery,
            k: 5,
            minKappa: 0,
            trinityUrl: trinityUrl.trim() || undefined,
          }),
        });
      } else {
        res = await fetch('/api/trinity/context', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            queryText: trinityQuery,
            k: 5,
            trinityUrl: trinityUrl.trim() || undefined,
          }),
        });
      }
      const data = await res.json();
      setTrinityStatus(res.ok ? 'ok' : 'error');
      setTrinityOutput(JSON.stringify(data, null, 2));
    } catch (err) {
      setTrinityStatus('error');
      setTrinityOutput(
        JSON.stringify({ error: (err as Error).message || 'TRINITY request failed' }, null, 2)
      );
    } finally {
      setTestingTrinity(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">
              Codex CLI, MCP Server (stdin/stdout) &amp; HTTP SDK
            </h1>
            <p className="text-sm text-slate-600 mt-1">
              Option 1 MCP stdio (<code className="font-mono text-xs text-slate-800">mcp-server.ts</code>) is
              default for Codex CLI and auto-syncs to HTTP <code className="font-mono text-xs text-slate-800">:3000</code> + TRINITY{' '}
              <code className="font-mono text-xs text-slate-800">:7700</code> when online.
            </p>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 px-3 py-2 bg-slate-50 border border-slate-200 rounded-md cursor-pointer whitespace-nowrap">
              <input
                type="checkbox"
                checked={config.mcpEnabled}
                onChange={(e) => void onToggleMcp(e.target.checked)}
                className="rounded border-slate-300 text-blue-600"
              />
              MCP Stdio {config.mcpEnabled ? 'Enabled' : 'Disabled'}
            </label>

            {tab !== 'mcp-bridge' && tab !== 'codex-cli' && (
              <button
                type="button"
                onClick={() => void copyText('main-snippet', snippet)}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0"
              >
                {copiedKey === 'main-snippet' ? (
                  <Check className="w-4 h-4 text-emerald-600" />
                ) : (
                  <Copy className="w-4 h-4" />
                )}
                {copiedKey === 'main-snippet' ? 'Copied' : 'Copy Snippet'}
              </button>
            )}
          </div>
        </div>

        <div
          role="group"
          aria-label="Transport and SDK selector"
          className="inline-flex flex-wrap p-1 bg-slate-100 border border-slate-200 rounded-md gap-1"
        >
          {(
            [
              { id: 'codex-cli', label: 'Codex CLI (Option 1 MCP)' },
              { id: 'mcp-bridge', label: 'MCP Bridge (stdin/stdout)' },
              { id: 'mcp-config', label: 'MCP Client JSON' },
              { id: 'python', label: 'Python (semantic-router)' },
              { id: 'typescript', label: 'TypeScript (REST)' },
              { id: 'curl', label: 'cURL' },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                tab === item.id
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        {tab === 'codex-cli' ? (
          <div className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Option 1: Codex CLI MCP Default */}
              <div className="border border-slate-200 rounded-lg p-4 space-y-3 bg-slate-50/50">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-xs font-semibold text-blue-700">
                      Option 1 · Default Transport
                    </div>
                    <h2 className="text-sm font-semibold text-slate-900 mt-0.5">
                      Codex CLI MCP Config (~/.codex/config.toml)
                    </h2>
                  </div>
                  <button
                    type="button"
                    onClick={() => void copyText('codex-toml', codexToml)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded whitespace-nowrap shrink-0"
                  >
                    {copiedKey === 'codex-toml' ? (
                      <Check className="w-3.5 h-3.5 text-emerald-600" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                    {copiedKey === 'codex-toml' ? 'Copied' : 'Copy TOML'}
                  </button>
                </div>

                <pre className="p-3.5 text-[11px] leading-relaxed font-mono text-slate-100 bg-slate-900 rounded-md overflow-x-auto border border-slate-800">
                  <code>{codexToml}</code>
                </pre>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-slate-700">One-Line CLI Registration</span>
                    <button
                      type="button"
                      onClick={() => void copyText('codex-cmd', codexCmd)}
                      className="text-[11px] font-medium text-blue-700 hover:underline whitespace-nowrap"
                    >
                      {copiedKey === 'codex-cmd' ? 'Copied' : 'Copy Command'}
                    </button>
                  </div>
                  <pre className="p-2.5 text-[11px] font-mono text-emerald-300 bg-slate-900 rounded border border-slate-800 overflow-x-auto">
                    <code>{codexCmd}</code>
                  </pre>
                </div>

                <p className="text-xs text-slate-600">
                  Exposed MCP tools:{' '}
                  <code className="font-mono text-slate-800">route_prompt</code>,{' '}
                  <code className="font-mono text-slate-800">rag_retrieve</code>,{' '}
                  <code className="font-mono text-slate-800">sync_rag_connector</code>,{' '}
                  <code className="font-mono text-slate-800">trinity_rag_query</code>,{' '}
                  <code className="font-mono text-slate-800">trinity_rag_context</code>,{' '}
                  <code className="font-mono text-slate-800">trinity_rag_ingest</code>.
                </p>
              </div>

              {/* Option 2: HTTP API + AGENTS.md */}
              <div className="border border-slate-200 rounded-lg p-4 space-y-3 bg-slate-50/50">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-xs font-semibold text-slate-600">
                      Option 2 · HTTP Bridge &amp; Agents Guide
                    </div>
                    <h2 className="text-sm font-semibold text-slate-900 mt-0.5">
                      Direct HTTP (:3000) &amp; TRINITY (:7700) REST API
                    </h2>
                  </div>
                  <button
                    type="button"
                    onClick={() => void copyText('codex-http', codexHttp)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded whitespace-nowrap shrink-0"
                  >
                    {copiedKey === 'codex-http' ? (
                      <Check className="w-3.5 h-3.5 text-emerald-600" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                    {copiedKey === 'codex-http' ? 'Copied' : 'Copy cURL'}
                  </button>
                </div>

                <pre className="p-3.5 text-[11px] leading-relaxed font-mono text-slate-100 bg-slate-900 rounded-md overflow-x-auto border border-slate-800">
                  <code>{codexHttp}</code>
                </pre>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-slate-700">AGENTS.md Snippet</span>
                    <button
                      type="button"
                      onClick={() => void copyText('codex-agents', codexAgents)}
                      className="text-[11px] font-medium text-blue-700 hover:underline whitespace-nowrap"
                    >
                      {copiedKey === 'codex-agents' ? 'Copied' : 'Copy AGENTS.md'}
                    </button>
                  </div>
                  <pre className="p-2.5 text-[11px] font-mono text-slate-200 bg-slate-900 rounded border border-slate-800 overflow-x-auto">
                    <code>{codexAgents}</code>
                  </pre>
                </div>
              </div>
            </div>

            {/* Live TRINITY :7700 Bridge Diagnostic */}
            <div className="border border-slate-200 rounded-lg p-4 space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                    <Activity className="w-4 h-4 text-blue-600" />
                    TRINITY :7700 Bridge Probe (HTTP + MCP Shared Tooling)
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Verify live connection to TRINITY Core FastAPI (<code className="font-mono">/health</code>,{' '}
                    <code className="font-mono">/query</code>, <code className="font-mono">/context</code>) and light up{' '}
                    <code className="font-mono">Router -&gt; RAG</code> telemetry.
                  </p>
                </div>
                {trinityStatus !== 'idle' && (
                  <span
                    className={`text-xs font-mono font-semibold ${
                      trinityStatus === 'ok' ? 'text-emerald-700' : 'text-amber-700'
                    }`}
                  >
                    {trinityStatus === 'ok' ? 'TRINITY ONLINE' : 'TRINITY OFFLINE / ERROR'}
                  </span>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-12 gap-2.5 items-end">
                <div className="md:col-span-4">
                  <label htmlFor="trinity-base-url" className="block text-[11px] font-medium text-slate-700 mb-1">
                    TRINITY Base URL
                  </label>
                  <input
                    id="trinity-base-url"
                    type="url"
                    value={trinityUrl}
                    onChange={(e) => setTrinityUrl(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-xs font-mono bg-white border border-slate-300 rounded"
                  />
                </div>
                <div className="md:col-span-5">
                  <label htmlFor="trinity-test-query" className="block text-[11px] font-medium text-slate-700 mb-1">
                    Query Text (/query &amp; /context)
                  </label>
                  <input
                    id="trinity-test-query"
                    type="text"
                    value={trinityQuery}
                    onChange={(e) => setTrinityQuery(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-300 rounded"
                  />
                </div>
                <div className="md:col-span-3 flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={testingTrinity}
                    onClick={() => void handleTestTrinity('health')}
                    className="px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded whitespace-nowrap shrink-0"
                  >
                    /health
                  </button>
                  <button
                    type="button"
                    disabled={testingTrinity}
                    onClick={() => void handleTestTrinity('query')}
                    className="px-2.5 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded whitespace-nowrap shrink-0"
                  >
                    /query
                  </button>
                  <button
                    type="button"
                    disabled={testingTrinity}
                    onClick={() => void handleTestTrinity('context')}
                    className="px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded whitespace-nowrap shrink-0"
                  >
                    /context
                  </button>
                </div>
              </div>

              {trinityOutput && (
                <pre className="p-3 text-xs font-mono bg-slate-900 text-slate-100 border border-slate-800 rounded max-h-48 overflow-auto">
                  {trinityOutput}
                </pre>
              )}
            </div>
          </div>
        ) : tab === 'mcp-bridge' ? (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-slate-500">JSON-RPC Presets:</span>
              {MCP_JSONRPC_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  title={preset.description}
                  onClick={() => {
                    const formatted = JSON.stringify(preset.payload, null, 2);
                    setStdinText(formatted);
                    void handleInvokeStdio(formatted);
                  }}
                  className="px-2.5 py-1.5 text-xs font-mono font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 border border-slate-200 rounded transition-colors whitespace-nowrap shrink-0"
                >
                  {preset.label}
                </button>
              ))}
            </div>

            {mcpError && (
              <div
                role="alert"
                className="px-4 py-3 text-xs text-rose-800 bg-rose-50 border border-rose-200 rounded-md"
              >
                {mcpError}
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Stdin Input */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-slate-800 flex items-center gap-1.5">
                    <Terminal className="w-3.5 h-3.5 text-blue-600" />
                    stdin (JSON-RPC 2.0 Request)
                  </span>
                  <button
                    type="button"
                    disabled={runningMcp || !config.mcpEnabled}
                    onClick={() => void handleInvokeStdio()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded transition-colors whitespace-nowrap"
                  >
                    <Play className="w-3 h-3" />
                    {runningMcp ? 'Sending...' : 'Write to stdin'}
                  </button>
                </div>
                <textarea
                  aria-label="MCP stdin JSON-RPC request"
                  rows={12}
                  value={stdinText}
                  onChange={(e) => setStdinText(e.target.value)}
                  className="w-full p-3.5 text-xs font-mono bg-slate-900 text-slate-100 border border-slate-800 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              {/* Stdout Output */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-slate-800">
                    stdout (JSON-RPC 2.0 Response)
                  </span>
                  <span className="font-mono tabular-nums text-slate-500">
                    {lastDurationMs !== null ? `${lastDurationMs.toFixed(2)} ms` : 'Awaiting call'}
                  </span>
                </div>
                <pre className="p-3.5 text-xs font-mono bg-slate-900 text-emerald-300 border border-slate-800 rounded-md h-[266px] overflow-auto">
                  {stdoutText || '// Click a JSON-RPC preset or "Write to stdin" to inspect live stdout output.'}
                </pre>
              </div>
            </div>

            {/* Live stdin/stdout Stream Transcript */}
            <div className="pt-4 border-t border-slate-200 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-800">
                  MCP Stdio Stream Transcript
                </span>
                <span className="font-mono text-slate-500">
                  Standalone CLI: <code className="text-slate-800">npm run mcp --silent</code>
                </span>
              </div>

              {logs.length === 0 ? (
                <div className="p-4 text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-md text-center">
                  No stdin/stdout frames recorded yet. Trigger a JSON-RPC call above to capture
                  live stdio frames.
                </div>
              ) : (
                <div className="divide-y divide-slate-200 border border-slate-200 rounded-md max-h-56 overflow-y-auto">
                  {logs.slice(0, 16).map((entry) => (
                    <div key={entry.id} className="px-3 py-2 text-[11px] font-mono bg-white">
                      <div className="flex items-center justify-between gap-2 text-slate-600">
                        <span>
                          <span
                            className={`font-semibold mr-2 ${
                              entry.direction === 'stdin' ? 'text-blue-700' : 'text-emerald-700'
                            }`}
                          >
                            {entry.direction.toUpperCase()}
                          </span>
                          <span>{entry.method ?? 'frame'}</span>
                        </span>
                        <span className="tabular-nums text-slate-500">
                          {entry.durationMs !== undefined ? `${entry.durationMs.toFixed(2)} ms` : ''}
                        </span>
                      </div>
                      <div className="text-slate-800 truncate mt-0.5">
                        {JSON.stringify(entry.payload)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          <pre className="p-5 text-xs leading-relaxed font-mono text-slate-100 bg-slate-900 rounded-md overflow-x-auto border border-slate-800">
            <code>{snippet}</code>
          </pre>
        )}
      </section>
    </div>
  );
}
