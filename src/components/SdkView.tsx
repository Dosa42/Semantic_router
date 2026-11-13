import React, { useEffect, useMemo, useState } from 'react';
import { Check, Copy, Play, Terminal } from 'lucide-react';
import {
  MCP_JSONRPC_PRESETS,
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

type SdkTab = 'mcp-bridge' | 'mcp-config' | 'python' | 'typescript' | 'curl';

export function SdkView({ routes, config, onToggleMcp }: SdkViewProps) {
  const [tab, setTab] = useState<SdkTab>('mcp-bridge');
  const [copied, setCopied] = useState(false);

  const [stdinText, setStdinText] = useState(() =>
    JSON.stringify(MCP_JSONRPC_PRESETS[2].payload, null, 2)
  );
  const [stdoutText, setStdoutText] = useState<string>('');
  const [lastDurationMs, setLastDurationMs] = useState<number | null>(null);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [runningMcp, setRunningMcp] = useState(false);
  const [logs, setLogs] = useState<McpStdioLogEntry[]>([]);

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

  const handleCopy = async () => {
    try {
      const target = tab === 'mcp-bridge' ? stdoutText || stdinText : snippet;
      await navigator.clipboard.writeText(target);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
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

  return (
    <div className="space-y-6">
      <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">
              SDK, HTTP API &amp; MCP Server (stdin / stdout)
            </h1>
            <p className="text-sm text-slate-600 mt-1">
              Invoke the unified Semantic Router &amp; RAG engine over HTTP REST or Model Context
              Protocol JSON-RPC 2.0 streams.
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

            {tab !== 'mcp-bridge' && (
              <button
                type="button"
                onClick={() => void handleCopy()}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0"
              >
                {copied ? (
                  <Check className="w-4 h-4 text-emerald-600" />
                ) : (
                  <Copy className="w-4 h-4" />
                )}
                {copied ? 'Copied' : 'Copy Snippet'}
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
              { id: 'mcp-bridge', label: 'MCP Bridge (stdin/stdout)' },
              { id: 'mcp-config', label: 'MCP Client Config' },
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

        {tab === 'mcp-bridge' ? (
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
