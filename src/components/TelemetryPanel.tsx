import React, { useEffect, useState } from 'react';
import {
  Activity,
  Check,
  Copy,
  RefreshCw,
  Server,
} from 'lucide-react';
import type {
  TelemetryLampColor,
  TelemetrySnapshot,
  TelemetrySubsystemId,
  TelemetrySubsystemStatus,
  TelemetryTraceEvent,
} from '../lib/types';

interface TelemetryPanelProps {
  telemetry: TelemetrySnapshot | null;
  streamConnected: boolean;
  probing: boolean;
  onProbeHealth: () => Promise<void>;
  onOpenChatGptAuth?: () => void;
}

type TelemetrySubTab = 'flow' | 'endpoints' | 'payloads';

function TrafficLightHousing({
  lamp,
  label,
}: {
  lamp: TelemetryLampColor;
  label: string;
}) {
  const isGreen = lamp === 'green';
  const isYellow = lamp === 'yellow';
  const isRed = lamp === 'red';

  return (
    <div
      role="img"
      aria-label={`${label} signal light: ${lamp}`}
      className="inline-flex flex-col items-center gap-1.5 px-2.5 py-2 bg-slate-900 border border-slate-800 rounded-md"
    >
      <span
        data-lamp="green"
        data-active={isGreen ? 'true' : 'false'}
        className={`w-3.5 h-3.5 rounded-full transition-opacity ${
          isGreen
            ? 'bg-emerald-400 ring-2 ring-emerald-400/40 opacity-100'
            : 'bg-emerald-950 border border-emerald-900/60 opacity-35'
        }`}
      />
      <span
        data-lamp="yellow"
        data-active={isYellow ? 'true' : 'false'}
        className={`w-3.5 h-3.5 rounded-full transition-opacity ${
          isYellow
            ? 'bg-amber-400 ring-2 ring-amber-400/40 opacity-100'
            : 'bg-amber-950 border border-amber-900/60 opacity-35'
        }`}
      />
      <span
        data-lamp="red"
        data-active={isRed ? 'true' : 'false'}
        className={`w-3.5 h-3.5 rounded-full transition-opacity ${
          isRed
            ? 'bg-rose-500 ring-2 ring-rose-500/40 opacity-100'
            : 'bg-rose-950 border border-rose-900/60 opacity-35'
        }`}
      />
    </div>
  );
}

function getStatusTextClass(lamp: TelemetryLampColor): string {
  if (lamp === 'green') return 'text-emerald-700';
  if (lamp === 'yellow') return 'text-amber-700';
  return 'text-rose-700';
}

function getPortStateClass(state: string): string {
  if (state === 'listening' || state === 'ready' || state === 'egress') {
    return 'text-emerald-700';
  }
  if (state === 'warming' || state === 'standby') {
    return 'text-amber-700';
  }
  return 'text-rose-700';
}

function subsystemToNodeId(id: TelemetrySubsystemId): string {
  if (id === 'ai_model') return 'openai-oauth-llm';
  if (id === 'embedding_model') return 'e5-onnx-worker';
  return 'semantic-router-rag';
}

export function TelemetryPanel({
  telemetry,
  streamConnected,
  probing,
  onProbeHealth,
  onOpenChatGptAuth,
}: TelemetryPanelProps) {
  const [subTab, setSubTab] = useState<TelemetrySubTab>('flow');
  const [selectedSubsystem, setSelectedSubsystem] = useState<TelemetrySubsystemId | null>(null);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [copiedPayload, setCopiedPayload] = useState(false);

  const traces = telemetry?.recentTraces ?? [];
  const filteredTraces = selectedSubsystem
    ? traces.filter((t) => t.subsystem === selectedSubsystem)
    : traces;

  const activeTrace: TelemetryTraceEvent | null =
    filteredTraces.find((t) => t.id === selectedTraceId) ?? filteredTraces[0] ?? null;

  useEffect(() => {
    if (!selectedTraceId && filteredTraces.length > 0) {
      setSelectedTraceId(filteredTraces[0].id);
    }
  }, [filteredTraces, selectedTraceId]);

  const subsystems: TelemetrySubsystemStatus[] = telemetry?.subsystems ?? [
    {
      id: 'ai_model',
      label: 'AI Model',
      target: 'OpenAI ChatGPT',
      lamp: 'yellow',
      statusText: 'SYNC',
      detail: 'Connecting telemetry stream',
      portOrRuntime: ':443 HTTPS',
      lastLatencyMs: null,
    },
    {
      id: 'semantic_router',
      label: 'Semantic Router',
      target: 'RAG Index Engine',
      lamp: 'yellow',
      statusText: 'SYNC',
      detail: 'Loading route index',
      portOrRuntime: ':3000 HTTP',
      lastLatencyMs: null,
    },
    {
      id: 'embedding_model',
      label: 'Embedding Model',
      target: 'e5-small-v2',
      lamp: 'yellow',
      statusText: 'SYNC',
      detail: 'Checking ONNX status',
      portOrRuntime: 'ONNX 384d',
      lastLatencyMs: null,
    },
  ];

  const endpoints = (telemetry?.endpoints ?? []).filter(
    (ep) => !selectedSubsystem || ep.subsystem === selectedSubsystem
  );
  const ports = telemetry?.ports ?? [];

  const highlightedNode = selectedSubsystem
    ? subsystemToNodeId(selectedSubsystem)
    : telemetry?.activeFlowEdge ?? 'semantic-router-rag';

  const aiSub = subsystems.find((s) => s.id === 'ai_model');
  const routerSub = subsystems.find((s) => s.id === 'semantic_router');
  const embedSub = subsystems.find((s) => s.id === 'embedding_model');

  const handleCopyTraceJson = async () => {
    if (!activeTrace) return;
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(
          {
            method: activeTrace.method,
            path: activeTrace.path,
            status: activeTrace.status,
            durationMs: activeTrace.durationMs,
            request: activeTrace.requestBody,
            response: activeTrace.responseBody,
          },
          null,
          2
        )
      );
      setCopiedPayload(true);
      window.setTimeout(() => setCopiedPayload(false), 1400);
    } catch {
      // Ignore clipboard failure
    }
  };

  return (
    <aside
      aria-label="Live Telemetry and Network Monitoring Console"
      className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-200"
    >
      {/* Header Bar */}
      <div className="px-4 py-3.5 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-blue-600 shrink-0" />
            <h2 className="text-sm font-semibold text-slate-900 truncate">
              Live System Telemetry
            </h2>
          </div>
          <div className="text-[11px] font-mono tabular-nums text-slate-500 mt-0.5 flex items-center gap-1.5">
            <span className={streamConnected ? 'text-emerald-700 font-medium' : 'text-amber-700'}>
              {streamConnected ? 'SSE Live' : 'Polling'}
            </span>
            <span aria-hidden="true">·</span>
            <span>Port :{telemetry?.expressPort ?? 3000}</span>
            <span aria-hidden="true">·</span>
            <span>Up {telemetry?.uptimeSec ?? 0}s</span>
          </div>
        </div>

        <button
          type="button"
          onClick={() => void onProbeHealth()}
          disabled={probing}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-slate-50 hover:bg-slate-100 border border-slate-300 rounded-md disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${probing ? 'animate-spin' : ''}`} />
          {probing ? 'Probing' : 'Probe'}
        </button>
      </div>

      {/* Three Traffic-Light Subsystems (Left: AI Model | Middle: Semantic Router | Right: Embedding Model) */}
      <div className="p-4 space-y-2.5">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-slate-700">Subsystem Signal Matrix</span>
          {selectedSubsystem ? (
            <button
              type="button"
              onClick={() => setSelectedSubsystem(null)}
              className="text-[11px] font-medium text-blue-600 hover:underline whitespace-nowrap"
            >
              Show All Subsystems
            </button>
          ) : (
            <span className="text-[11px] text-slate-500">Click unit to filter routes</span>
          )}
        </div>

        <div
          data-testid="telemetry-traffic-lights"
          className="grid grid-cols-3 gap-2 items-stretch"
        >
          {subsystems.map((sub) => {
            const isSelected = selectedSubsystem === sub.id;
            return (
              <button
                key={sub.id}
                type="button"
                data-testid={`signal-unit-${sub.id}`}
                onClick={() =>
                  setSelectedSubsystem((prev) => (prev === sub.id ? null : sub.id))
                }
                className={`flex flex-col items-center text-center p-2.5 rounded-md border transition-colors ${
                  isSelected
                    ? 'bg-blue-50/50 border-blue-600 ring-1 ring-blue-600'
                    : 'bg-slate-50/60 border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                }`}
              >
                <TrafficLightHousing lamp={sub.lamp} label={sub.label} />

                <div className="mt-2 space-y-0.5 w-full">
                  <div className="text-[11px] font-semibold text-slate-900 truncate">
                    {sub.label}
                  </div>
                  <div
                    className={`text-[10px] font-mono font-semibold uppercase tracking-wide ${getStatusTextClass(sub.lamp)}`}
                  >
                    {sub.statusText}
                  </div>
                  <div className="text-[10px] font-mono tabular-nums text-slate-500 truncate">
                    {sub.portOrRuntime}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {/* Concise Runtime Detail Readout Row */}
        <div className="text-[11px] text-slate-600 bg-slate-50 border border-slate-200 rounded px-3 py-2 space-y-1">
          {subsystems
            .filter((s) => !selectedSubsystem || s.id === selectedSubsystem)
            .map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-2">
                <span className="font-medium text-slate-800 shrink-0">{s.label}:</span>
                <span className="truncate font-mono text-[10px] text-slate-600 flex-1 text-right">
                  {s.detail}
                  {s.lastLatencyMs !== null ? ` (${s.lastLatencyMs.toFixed(1)} ms)` : ''}
                </span>
              </div>
            ))}
          {aiSub?.lamp === 'red' && onOpenChatGptAuth && (
            <div className="pt-1 border-t border-slate-200 flex items-center justify-between">
              <span className="text-[10px] text-rose-700 font-medium">
                AI Model unauthenticated
              </span>
              <button
                type="button"
                onClick={onOpenChatGptAuth}
                className="text-[11px] font-medium text-blue-600 hover:underline whitespace-nowrap"
              >
                Connect ChatGPT
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Sub-View Switcher: Flow & Ports | Endpoints | Payloads */}
      <div className="px-4 py-2.5 bg-slate-50/70">
        <div
          role="tablist"
          aria-label="Telemetry detail view"
          className="grid grid-cols-3 p-0.5 bg-slate-200/70 rounded-md"
        >
          {(
            [
              { id: 'flow', label: 'Flow & Ports' },
              { id: 'endpoints', label: `Endpoints (${endpoints.length})` },
              { id: 'payloads', label: `Payloads (${filteredTraces.length})` },
            ] as Array<{ id: TelemetrySubTab; label: string }>
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={subTab === tab.id}
              onClick={() => setSubTab(tab.id)}
              className={`py-1.5 px-2 text-[11px] font-medium rounded transition-colors whitespace-nowrap truncate ${
                subTab === tab.id
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Active Sub-View Content */}
      <div className="p-4">
        {subTab === 'flow' && (
          <div className="space-y-4">
            {/* Network API Route Topology Diagram */}
            <div>
              <div className="flex items-center justify-between text-xs mb-2">
                <span className="font-semibold text-slate-800">Network API Route Flow</span>
                <span className="font-mono text-[10px] text-slate-500">
                  Active edge: {highlightedNode}
                </span>
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded-md p-2.5">
                <svg
                  viewBox="0 0 360 176"
                  className="w-full h-auto"
                  role="img"
                  aria-label="Live network API routing diagram across browser, Express port 3000, AI Model, Semantic Router RAG, and Embedding Model"
                >
                  <defs>
                    <marker
                      id="flow-arrow-muted"
                      viewBox="0 0 10 10"
                      refX="8"
                      refY="5"
                      markerWidth="5"
                      markerHeight="5"
                      orient="auto-start-reverse"
                    >
                      <path d="M 0 1 L 8 5 L 0 9 z" fill="#94A3B8" />
                    </marker>
                    <marker
                      id="flow-arrow-active"
                      viewBox="0 0 10 10"
                      refX="8"
                      refY="5"
                      markerWidth="5"
                      markerHeight="5"
                      orient="auto-start-reverse"
                    >
                      <path d="M 0 1 L 8 5 L 0 9 z" fill="#2563EB" />
                    </marker>
                  </defs>

                  {/* Top Node: Browser UI -> Express Gateway */}
                  <rect
                    x="14"
                    y="10"
                    width="116"
                    height="36"
                    rx="5"
                    fill="#FFFFFF"
                    stroke="#CBD5E1"
                  />
                  <text
                    x="72"
                    y="25"
                    textAnchor="middle"
                    fill="#0F172A"
                    fontSize="10"
                    fontWeight="600"
                    fontFamily="Plus Jakarta Sans, sans-serif"
                  >
                    Client Browser
                  </text>
                  <text
                    x="72"
                    y="38"
                    textAnchor="middle"
                    fill="#64748B"
                    fontSize="9"
                    fontFamily="JetBrains Mono, monospace"
                  >
                    HTTP/SSE :3000
                  </text>

                  <line
                    x1="130"
                    y1="28"
                    x2="196"
                    y2="28"
                    stroke="#2563EB"
                    strokeWidth="1.6"
                    markerEnd="url(#flow-arrow-active)"
                  />
                  <text
                    x="163"
                    y="22"
                    textAnchor="middle"
                    fill="#2563EB"
                    fontSize="8.5"
                    fontFamily="JetBrains Mono, monospace"
                  >
                    /api/*
                  </text>

                  <rect
                    x="202"
                    y="10"
                    width="144"
                    height="36"
                    rx="5"
                    fill="#FFFFFF"
                    stroke="#2563EB"
                    strokeWidth="1.3"
                  />
                  <text
                    x="274"
                    y="25"
                    textAnchor="middle"
                    fill="#0F172A"
                    fontSize="10"
                    fontWeight="600"
                    fontFamily="Plus Jakarta Sans, sans-serif"
                  >
                    Express API Gateway
                  </text>
                  <text
                    x="274"
                    y="38"
                    textAnchor="middle"
                    fill="#2563EB"
                    fontSize="9"
                    fontFamily="JetBrains Mono, monospace"
                  >
                    0.0.0.0:{telemetry?.expressPort ?? 3000} LISTEN
                  </text>

                  {/* Connector lines to 3 subsystems */}
                  <path
                    d="M 230 46 C 230 78, 60 72, 60 108"
                    fill="none"
                    stroke={highlightedNode === 'openai-oauth-llm' ? '#2563EB' : '#CBD5E1'}
                    strokeWidth={highlightedNode === 'openai-oauth-llm' ? 1.8 : 1.2}
                    markerEnd={
                      highlightedNode === 'openai-oauth-llm'
                        ? 'url(#flow-arrow-active)'
                        : 'url(#flow-arrow-muted)'
                    }
                  />
                  <path
                    d="M 274 46 C 274 76, 180 74, 180 108"
                    fill="none"
                    stroke={highlightedNode === 'semantic-router-rag' ? '#2563EB' : '#CBD5E1'}
                    strokeWidth={highlightedNode === 'semantic-router-rag' ? 1.8 : 1.2}
                    markerEnd={
                      highlightedNode === 'semantic-router-rag'
                        ? 'url(#flow-arrow-active)'
                        : 'url(#flow-arrow-muted)'
                    }
                  />
                  <path
                    d="M 314 46 C 314 78, 300 72, 300 108"
                    fill="none"
                    stroke={highlightedNode === 'e5-onnx-worker' ? '#2563EB' : '#CBD5E1'}
                    strokeWidth={highlightedNode === 'e5-onnx-worker' ? 1.8 : 1.2}
                    markerEnd={
                      highlightedNode === 'e5-onnx-worker'
                        ? 'url(#flow-arrow-active)'
                        : 'url(#flow-arrow-muted)'
                    }
                  />

                  {/* Downstream Node 1: AI Model */}
                  <rect
                    x="8"
                    y="112"
                    width="104"
                    height="52"
                    rx="5"
                    fill="#FFFFFF"
                    stroke={highlightedNode === 'openai-oauth-llm' ? '#2563EB' : '#CBD5E1'}
                    strokeWidth={highlightedNode === 'openai-oauth-llm' ? 1.5 : 1}
                  />
                  <text
                    x="60"
                    y="128"
                    textAnchor="middle"
                    fill="#0F172A"
                    fontSize="9.5"
                    fontWeight="600"
                  >
                    AI Model
                  </text>
                  <text
                    x="60"
                    y="141"
                    textAnchor="middle"
                    fill="#475569"
                    fontSize="8.5"
                    fontFamily="JetBrains Mono, monospace"
                  >
                    :443 / :{telemetry?.loopbackPort ?? 1455}
                  </text>
                  <text
                    x="60"
                    y="154"
                    textAnchor="middle"
                    fill={
                      aiSub?.lamp === 'green'
                        ? '#15803D'
                        : aiSub?.lamp === 'yellow'
                          ? '#B45309'
                          : '#BE123C'
                    }
                    fontSize="8.5"
                    fontWeight="600"
                    fontFamily="JetBrains Mono, monospace"
                  >
                    {aiSub?.statusText ?? 'AUTH_REQ'}
                  </text>

                  {/* Downstream Node 2: Semantic Router RAG */}
                  <rect
                    x="124"
                    y="112"
                    width="112"
                    height="52"
                    rx="5"
                    fill="#FFFFFF"
                    stroke={highlightedNode === 'semantic-router-rag' ? '#2563EB' : '#CBD5E1'}
                    strokeWidth={highlightedNode === 'semantic-router-rag' ? 1.5 : 1}
                  />
                  <text
                    x="180"
                    y="128"
                    textAnchor="middle"
                    fill="#0F172A"
                    fontSize="9.5"
                    fontWeight="600"
                  >
                    Semantic Router
                  </text>
                  <text
                    x="180"
                    y="141"
                    textAnchor="middle"
                    fill="#475569"
                    fontSize="8.5"
                    fontFamily="JetBrains Mono, monospace"
                  >
                    RAG Hybrid Index
                  </text>
                  <text
                    x="180"
                    y="154"
                    textAnchor="middle"
                    fill={
                      routerSub?.lamp === 'green'
                        ? '#15803D'
                        : routerSub?.lamp === 'yellow'
                          ? '#B45309'
                          : '#BE123C'
                    }
                    fontSize="8.5"
                    fontWeight="600"
                    fontFamily="JetBrains Mono, monospace"
                  >
                    {routerSub?.statusText ?? 'ONLINE'}
                  </text>

                  {/* Downstream Node 3: Embedding Model */}
                  <rect
                    x="248"
                    y="112"
                    width="104"
                    height="52"
                    rx="5"
                    fill="#FFFFFF"
                    stroke={highlightedNode === 'e5-onnx-worker' ? '#2563EB' : '#CBD5E1'}
                    strokeWidth={highlightedNode === 'e5-onnx-worker' ? 1.5 : 1}
                  />
                  <text
                    x="300"
                    y="128"
                    textAnchor="middle"
                    fill="#0F172A"
                    fontSize="9.5"
                    fontWeight="600"
                  >
                    Embeddings
                  </text>
                  <text
                    x="300"
                    y="141"
                    textAnchor="middle"
                    fill="#475569"
                    fontSize="8.5"
                    fontFamily="JetBrains Mono, monospace"
                  >
                    e5-small-v2 q8
                  </text>
                  <text
                    x="300"
                    y="154"
                    textAnchor="middle"
                    fill={
                      embedSub?.lamp === 'green'
                        ? '#15803D'
                        : embedSub?.lamp === 'yellow'
                          ? '#B45309'
                          : '#BE123C'
                    }
                    fontSize="8.5"
                    fontWeight="600"
                    fontFamily="JetBrains Mono, monospace"
                  >
                    {embedSub?.statusText ?? 'WARMING'}
                  </text>
                </svg>
              </div>
            </div>

            {/* Active Ports & Listeners Table */}
            <div>
              <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800 mb-2">
                <Server className="w-3.5 h-3.5 text-slate-500" />
                Ports &amp; Service Bindings
              </div>
              <div className="border border-slate-200 rounded-md overflow-hidden">
                <table className="w-full text-left border-collapse text-[11px]">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                      <th className="py-1.5 px-2.5 font-semibold">Port</th>
                      <th className="py-1.5 px-2.5 font-semibold">Service</th>
                      <th className="py-1.5 px-2.5 font-semibold text-right">State</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {ports.map((p, idx) => (
                      <tr key={idx} className="bg-white">
                        <td className="py-1.5 px-2.5 font-mono tabular-nums font-medium text-slate-900 whitespace-nowrap">
                          {p.port > 0 ? `:${p.port}` : 'IPC'} · {p.protocol}
                        </td>
                        <td className="py-1.5 px-2.5 text-slate-700">
                          <div className="font-medium truncate max-w-[175px]">{p.service}</div>
                          <div className="font-mono text-[10px] text-slate-500 truncate max-w-[175px]">
                            {p.detail}
                          </div>
                        </td>
                        <td
                          className={`py-1.5 px-2.5 text-right font-mono font-semibold uppercase whitespace-nowrap ${getPortStateClass(p.state)}`}
                        >
                          {p.state}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {subTab === 'endpoints' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-slate-800">Backend API Endpoints</span>
              <span className="font-mono tabular-nums text-[11px] text-slate-500">
                {endpoints.reduce((acc, e) => acc + e.hits, 0)} total calls
              </span>
            </div>
            <div className="border border-slate-200 rounded-md overflow-x-auto max-h-80 overflow-y-auto">
              <table className="w-full text-left border-collapse text-[11px]">
                <thead className="sticky top-0 bg-slate-50 border-b border-slate-200 text-slate-600">
                  <tr>
                    <th className="py-1.5 px-2.5 font-semibold">Endpoint</th>
                    <th className="py-1.5 px-2 font-semibold text-right">Hits</th>
                    <th className="py-1.5 px-2 font-semibold text-right">Status</th>
                    <th className="py-1.5 px-2.5 font-semibold text-right">Avg ms</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {endpoints.map((ep) => (
                    <tr
                      key={ep.id}
                      onClick={() => {
                        const matchTrace = traces.find((t) => t.routePattern === ep.id);
                        if (matchTrace) {
                          setSelectedTraceId(matchTrace.id);
                          setSubTab('payloads');
                        }
                      }}
                      className="bg-white hover:bg-slate-50 cursor-pointer"
                    >
                      <td className="py-1.5 px-2.5 font-mono text-slate-900">
                        <span className="font-semibold text-blue-700 mr-1.5">{ep.method}</span>
                        <span className="break-all">{ep.path}</span>
                      </td>
                      <td className="py-1.5 px-2 text-right font-mono tabular-nums text-slate-700">
                        {ep.hits}
                      </td>
                      <td
                        className={`py-1.5 px-2 text-right font-mono tabular-nums font-medium ${
                          ep.lastStatus === null
                            ? 'text-slate-400'
                            : ep.lastStatus >= 400
                              ? 'text-rose-700'
                              : 'text-emerald-700'
                        }`}
                      >
                        {ep.lastStatus ?? '—'}
                      </td>
                      <td className="py-1.5 px-2.5 text-right font-mono tabular-nums text-slate-700">
                        {ep.avgLatencyMs !== null ? ep.avgLatencyMs.toFixed(1) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {subTab === 'payloads' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-slate-800">
                Recent API Traces &amp; JSON Payloads
              </span>
              {activeTrace && (
                <button
                  type="button"
                  onClick={() => void handleCopyTraceJson()}
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-600 hover:underline whitespace-nowrap"
                >
                  {copiedPayload ? (
                    <Check className="w-3 h-3 text-emerald-600" />
                  ) : (
                    <Copy className="w-3 h-3" />
                  )}
                  {copiedPayload ? 'Copied JSON' : 'Copy JSON'}
                </button>
              )}
            </div>

            {filteredTraces.length === 0 ? (
              <div className="p-4 text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-md text-center">
                No traced calls yet for this filter. Route a prompt or click Probe to capture live
                JSON traffic.
              </div>
            ) : (
              <>
                <div className="divide-y divide-slate-200 border border-slate-200 rounded-md max-h-40 overflow-y-auto">
                  {filteredTraces.slice(0, 12).map((tr) => {
                    const selected = activeTrace?.id === tr.id;
                    return (
                      <button
                        key={tr.id}
                        type="button"
                        onClick={() => setSelectedTraceId(tr.id)}
                        className={`w-full text-left px-2.5 py-2 flex items-center justify-between gap-2 text-[11px] transition-colors ${
                          selected ? 'bg-blue-50/70' : 'bg-white hover:bg-slate-50'
                        }`}
                      >
                        <div className="min-w-0 font-mono truncate">
                          <span className="font-semibold text-blue-700 mr-1.5">{tr.method}</span>
                          <span className="text-slate-900">{tr.path}</span>
                        </div>
                        <div className="flex items-center gap-2 font-mono tabular-nums shrink-0">
                          <span
                            className={
                              tr.status >= 400 ? 'text-rose-700 font-semibold' : 'text-emerald-700'
                            }
                          >
                            {tr.status}
                          </span>
                          <span className="text-slate-500">{tr.durationMs.toFixed(1)}ms</span>
                        </div>
                      </button>
                    );
                  })}
                </div>

                {activeTrace && (
                  <div
                    data-testid="telemetry-payload-inspector"
                    className="bg-slate-50 border border-slate-200 rounded-md p-3 space-y-2 text-[11px]"
                  >
                    <div className="flex items-center justify-between font-mono text-slate-700">
                      <span className="font-semibold truncate">
                        {activeTrace.method} {activeTrace.path}
                      </span>
                      <span className="tabular-nums text-slate-500 shrink-0">
                        {activeTrace.targetNode} · {activeTrace.durationMs.toFixed(2)} ms
                      </span>
                    </div>

                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1">
                        Request Payload
                      </div>
                      <pre className="p-2 bg-white border border-slate-200 rounded font-mono text-[10px] text-slate-800 max-h-28 overflow-auto">
                        {JSON.stringify(activeTrace.requestBody, null, 2)}
                      </pre>
                    </div>

                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1">
                        Response Payload
                      </div>
                      <pre className="p-2 bg-white border border-slate-200 rounded font-mono text-[10px] text-slate-800 max-h-40 overflow-auto">
                        {JSON.stringify(activeTrace.responseBody, null, 2)}
                      </pre>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
