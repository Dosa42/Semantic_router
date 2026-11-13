import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Check,
  Copy,
  RefreshCw,
  Server,
} from 'lucide-react';
import type {
  TelemetryEdgeId,
  TelemetryEdgeState,
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

type AnchorSide = 'top' | 'bottom' | 'left' | 'right' | 'bottom-left' | 'bottom-right' | 'top-right';

interface TopologyNodeDef {
  id: string;
  label: string;
  sublabel: string;
  x: number;
  y: number;
  w: number;
  h: number;
  subsystem?: TelemetrySubsystemId;
}

interface TopologyEdgeDef {
  id: TelemetryEdgeId;
  from: string;
  to: string;
  fromSide: AnchorSide;
  toSide: AnchorSide;
  defaultPort: string;
}

const TOPOLOGY_NODES: TopologyNodeDef[] = [
  { id: 'browser', label: 'Client Browser', sublabel: 'HTTP/SSE', x: 8, y: 8, w: 102, h: 36 },
  {
    id: 'express',
    label: 'Express Gateway',
    sublabel: ':3000 LISTEN',
    x: 128,
    y: 8,
    w: 106,
    h: 36,
    subsystem: 'semantic_router',
  },
  { id: 'mcp', label: 'MCP Stdio', sublabel: 'stdin / stdout', x: 252, y: 8, w: 100, h: 36 },
  {
    id: 'router',
    label: 'RAG & Semantic Router',
    sublabel: 'Unified Core',
    x: 92,
    y: 74,
    w: 176,
    h: 40,
    subsystem: 'semantic_router',
  },
  {
    id: 'rag_connector',
    label: 'RAG Webhook',
    sublabel: ':443 Fetch',
    x: 8,
    y: 146,
    w: 102,
    h: 38,
    subsystem: 'semantic_router',
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT AI',
    sublabel: ':443 Responses',
    x: 128,
    y: 146,
    w: 106,
    h: 38,
    subsystem: 'ai_model',
  },
  {
    id: 'bridge',
    label: 'EmbeddingsBridge',
    sublabel: 'IPC + Cache',
    x: 252,
    y: 146,
    w: 100,
    h: 38,
    subsystem: 'embedding_model',
  },
  {
    id: 'loopback',
    label: 'OAuth Loopback',
    sublabel: ':1455 PKCE',
    x: 128,
    y: 214,
    w: 106,
    h: 38,
    subsystem: 'ai_model',
  },
  {
    id: 'embedding',
    label: 'Embedding LM',
    sublabel: 'e5-small-v2',
    x: 252,
    y: 214,
    w: 100,
    h: 38,
    subsystem: 'embedding_model',
  },
];

const TOPOLOGY_EDGES: TopologyEdgeDef[] = [
  { id: 'browser->express', from: 'browser', to: 'express', fromSide: 'right', toSide: 'left', defaultPort: ':3000' },
  { id: 'express->router', from: 'express', to: 'router', fromSide: 'bottom', toSide: 'top', defaultPort: 'IPC' },
  { id: 'mcp->router', from: 'mcp', to: 'router', fromSide: 'bottom', toSide: 'top-right', defaultPort: 'stdio' },
  { id: 'router->rag_connector', from: 'router', to: 'rag_connector', fromSide: 'bottom-left', toSide: 'top', defaultPort: ':443' },
  { id: 'router->chatgpt', from: 'router', to: 'chatgpt', fromSide: 'bottom', toSide: 'top', defaultPort: ':443' },
  { id: 'router->bridge', from: 'router', to: 'bridge', fromSide: 'bottom-right', toSide: 'top', defaultPort: 'IPC' },
  { id: 'chatgpt->loopback', from: 'chatgpt', to: 'loopback', fromSide: 'bottom', toSide: 'top', defaultPort: ':1455' },
  { id: 'bridge->embedding', from: 'bridge', to: 'embedding', fromSide: 'bottom', toSide: 'top', defaultPort: 'ONNX' },
];

function getAnchorPoint(node: TopologyNodeDef, side: AnchorSide): { x: number; y: number } {
  switch (side) {
    case 'top':
      return { x: node.x + node.w / 2, y: node.y };
    case 'top-right':
      return { x: node.x + node.w * 0.82, y: node.y };
    case 'bottom':
      return { x: node.x + node.w / 2, y: node.y + node.h };
    case 'bottom-left':
      return { x: node.x + node.w * 0.18, y: node.y + node.h };
    case 'bottom-right':
      return { x: node.x + node.w * 0.82, y: node.y + node.h };
    case 'left':
      return { x: node.x, y: node.y + node.h / 2 };
    case 'right':
      return { x: node.x + node.w, y: node.y + node.h / 2 };
  }
}

function computeDynamicEdgeCurve(
  fromNode: TopologyNodeDef,
  toNode: TopologyNodeDef,
  fromSide: AnchorSide,
  toSide: AnchorSide
): { path: string; midX: number; midY: number } {
  const p1 = getAnchorPoint(fromNode, fromSide);
  const p2 = getAnchorPoint(toNode, toSide);
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;

  const isHorizontal = (fromSide === 'left' || fromSide === 'right') && (toSide === 'left' || toSide === 'right');
  let c1x = p1.x;
  let c1y = p1.y;
  let c2x = p2.x;
  let c2y = p2.y;

  if (isHorizontal) {
    c1x = p1.x + dx * 0.5;
    c2x = p2.x - dx * 0.5;
  } else {
    c1y = p1.y + dy * 0.52;
    c2y = p2.y - dy * 0.52;
  }

  // Exact cubic Bezier midpoint at t = 0.5
  const midX = 0.125 * p1.x + 0.375 * c1x + 0.375 * c2x + 0.125 * p2.x;
  const midY = 0.125 * p1.y + 0.375 * c1y + 0.375 * c2y + 0.125 * p2.y;

  return {
    path: `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`,
    midX,
    midY,
  };
}

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

const GLOW_DECAY_MS = 850;

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
  const [nowMs, setNowMs] = useState(() => Date.now());

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

  // Fast 60ms visual decay timer ONLY while any edge is active or within its 850ms glow window
  const edges = telemetry?.edges ?? [];
  const hasLiveOrDecayingEdge = edges.some(
    (e) =>
      e.activeCount > 0 ||
      (e.lastCompletedAtMs !== null && Date.now() - e.lastCompletedAtMs < GLOW_DECAY_MS)
  );

  useEffect(() => {
    if (!hasLiveOrDecayingEdge) return;
    setNowMs(Date.now());
    const id = window.setInterval(() => {
      setNowMs(Date.now());
    }, 60);
    return () => window.clearInterval(id);
  }, [hasLiveOrDecayingEdge, telemetry?.timestamp]);

  const edgeMap = useMemo(() => {
    const map = new Map<TelemetryEdgeId, TelemetryEdgeState>();
    for (const e of edges) map.set(e.id, e);
    return map;
  }, [edges]);

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
      label: 'Router & RAG',
      target: 'HTTP + MCP Engine',
      lamp: 'yellow',
      statusText: 'SYNC',
      detail: 'Loading route index',
      portOrRuntime: ':3000 + stdio',
      lastLatencyMs: null,
    },
    {
      id: 'embedding_model',
      label: 'Embedding LM',
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

  const aiSub = subsystems.find((s) => s.id === 'ai_model');
  const routerSub = subsystems.find((s) => s.id === 'semantic_router');
  const embedSub = subsystems.find((s) => s.id === 'embedding_model');

  const nodeMap = useMemo(() => {
    const map = new Map<string, TopologyNodeDef>();
    for (const n of TOPOLOGY_NODES) map.set(n.id, n);
    return map;
  }, []);

  const computedEdges = useMemo(() => {
    return TOPOLOGY_EDGES.map((def) => {
      const fromNode = nodeMap.get(def.from)!;
      const toNode = nodeMap.get(def.to)!;
      const curve = computeDynamicEdgeCurve(fromNode, toNode, def.fromSide, def.toSide);
      const state = edgeMap.get(def.id);
      const isInFlight = (state?.activeCount ?? 0) > 0;
      const ageMs =
        state?.lastCompletedAtMs !== null && state?.lastCompletedAtMs !== undefined
          ? Math.max(0, nowMs - state.lastCompletedAtMs)
          : Infinity;
      const isDecaying = !isInFlight && ageMs < GLOW_DECAY_MS;
      const isGlowing = isInFlight || isDecaying;
      const isError = state?.lastStatus === 'error' && isDecaying;
      const portLabel = state?.portOrChannel ?? def.defaultPort;
      const latencyLabel = isInFlight
        ? 'LIVE'
        : isDecaying && state?.lastDurationMs !== null && state?.lastDurationMs !== undefined
          ? `${state.lastDurationMs.toFixed(1)}ms`
          : null;

      return {
        def,
        state,
        curve,
        isInFlight,
        isGlowing,
        isError,
        portLabel,
        latencyLabel,
      };
    });
  }, [edgeMap, nodeMap, nowMs]);

  const activeEdgeSummary = computedEdges
    .filter((e) => e.isGlowing)
    .map((e) => `${e.def.id} (${e.portLabel})`)
    .join(', ');

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

      {/* Three Traffic-Light Subsystems */}
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
            <span className="text-[11px] text-slate-500">Click unit to filter</span>
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
                <span className="truncate font-mono text-[10px] text-slate-600 flex-1 text-right tabular-nums">
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
            {/* Dynamic Millisecond-Glowing Network & Process Topology */}
            <div>
              <div className="flex items-center justify-between gap-2 text-xs mb-2">
                <span className="font-semibold text-slate-800 shrink-0">
                  Live Process &amp; Port Flow
                </span>
                <span className="font-mono text-[10px] text-slate-500 truncate tabular-nums">
                  {activeEdgeSummary || 'Idle · awaiting port activity'}
                </span>
              </div>

              <div className="bg-slate-950 border border-slate-800 rounded-md p-2">
                <svg
                  viewBox="0 0 360 262"
                  className="w-full h-auto"
                  role="img"
                  aria-label="Dynamic millisecond-live network topology across Browser, MCP stdio, Express Gateway, RAG Semantic Router, EmbeddingsBridge, Embedding LM, RAG Webhook, ChatGPT AI, and OAuth Loopback"
                >
                  <defs>
                    <filter id="port-glow-blue" x="-30%" y="-30%" width="160%" height="160%">
                      <feGaussianBlur stdDeviation="2.2" result="blur" />
                      <feMerge>
                        <feMergeNode in="blur" />
                        <feMergeNode in="SourceGraphic" />
                      </feMerge>
                    </filter>
                    <filter id="port-glow-amber" x="-30%" y="-30%" width="160%" height="160%">
                      <feGaussianBlur stdDeviation="2.2" result="blur" />
                      <feMerge>
                        <feMergeNode in="blur" />
                        <feMergeNode in="SourceGraphic" />
                      </feMerge>
                    </filter>
                    <filter id="port-glow-rose" x="-30%" y="-30%" width="160%" height="160%">
                      <feGaussianBlur stdDeviation="2.2" result="blur" />
                      <feMerge>
                        <feMergeNode in="blur" />
                        <feMergeNode in="SourceGraphic" />
                      </feMerge>
                    </filter>
                    <marker
                      id="dyn-arrow-idle"
                      viewBox="0 0 8 8"
                      refX="6.5"
                      refY="4"
                      markerWidth="4.5"
                      markerHeight="4.5"
                      orient="auto-start-reverse"
                    >
                      <path d="M 0 1 L 7 4 L 0 7 z" fill="#475569" />
                    </marker>
                    <marker
                      id="dyn-arrow-glow"
                      viewBox="0 0 8 8"
                      refX="6.5"
                      refY="4"
                      markerWidth="5"
                      markerHeight="5"
                      orient="auto-start-reverse"
                    >
                      <path d="M 0 1 L 7 4 L 0 7 z" fill="#38BDF8" />
                    </marker>
                    <marker
                      id="dyn-arrow-error"
                      viewBox="0 0 8 8"
                      refX="6.5"
                      refY="4"
                      markerWidth="5"
                      markerHeight="5"
                      orient="auto-start-reverse"
                    >
                      <path d="M 0 1 L 7 4 L 0 7 z" fill="#FB7185" />
                    </marker>
                  </defs>

                  {/* Dynamically Computed Connection Lines */}
                  {computedEdges.map(({ def, curve, isInFlight, isGlowing, isError, portLabel, latencyLabel }) => {
                    const strokeColor = isError
                      ? '#FB7185'
                      : isInFlight
                        ? '#38BDF8'
                        : isGlowing
                          ? '#60A5FA'
                          : '#334155';
                    const marker = isError
                      ? 'url(#dyn-arrow-error)'
                      : isGlowing
                        ? 'url(#dyn-arrow-glow)'
                        : 'url(#dyn-arrow-idle)';
                    const glowFilter = isError
                      ? 'url(#port-glow-rose)'
                      : isInFlight
                        ? 'url(#port-glow-blue)'
                        : isGlowing
                          ? 'url(#port-glow-blue)'
                          : undefined;

                    return (
                      <g key={def.id} data-edge-id={def.id} data-edge-active={isGlowing ? 'true' : 'false'}>
                        {/* Base thin 1px structural line */}
                        <path
                          d={curve.path}
                          fill="none"
                          stroke={strokeColor}
                          strokeWidth={isGlowing ? 1.35 : 0.9}
                          strokeOpacity={isGlowing ? 0.95 : 0.7}
                          filter={glowFilter}
                          markerEnd={marker}
                        />
                        {/* Animated thin data-flow filament only when actively running or decaying */}
                        {isGlowing && (
                          <path
                            d={curve.path}
                            fill="none"
                            stroke={isError ? '#FDA4AF' : '#E0F2FE'}
                            strokeWidth={1.1}
                            strokeDasharray="4 6"
                            className="motion-reduce:hidden"
                          >
                            <animate
                              attributeName="stroke-dashoffset"
                              from="20"
                              to="0"
                              dur={isInFlight ? '0.35s' : '0.6s'}
                              repeatCount="indefinite"
                            />
                          </path>
                        )}
                        {/* Port / Latency micro-readout along active edge */}
                        <text
                          x={curve.midX}
                          y={curve.midY - 3}
                          textAnchor="middle"
                          fill={isGlowing ? (isError ? '#FDA4AF' : '#7DD3FC') : '#64748B'}
                          fontSize="6.8"
                          fontWeight={isGlowing ? '600' : '400'}
                          fontFamily="JetBrains Mono, monospace"
                        >
                          {latencyLabel ? `${portLabel} · ${latencyLabel}` : portLabel}
                        </text>
                      </g>
                    );
                  })}

                  {/* Process & Service Nodes */}
                  {TOPOLOGY_NODES.map((node) => {
                    const connectedGlowing = computedEdges.some(
                      (e) => e.isGlowing && (e.def.from === node.id || e.def.to === node.id)
                    );
                    const connectedError = computedEdges.some(
                      (e) => e.isError && (e.def.from === node.id || e.def.to === node.id)
                    );
                    const subsystemSelected =
                      selectedSubsystem && node.subsystem === selectedSubsystem;

                    let dynamicSub = node.sublabel;
                    if (node.id === 'express') {
                      dynamicSub = `0.0.0.0:${telemetry?.expressPort ?? 3000}`;
                    } else if (node.id === 'mcp') {
                      dynamicSub = telemetry?.mcpEnabled === false ? 'disabled' : 'stdin/stdout';
                    } else if (node.id === 'loopback') {
                      dynamicSub = `:${telemetry?.loopbackPort ?? 1455} ${telemetry?.loopbackListening ? 'LISTEN' : 'IDLE'}`;
                    } else if (node.id === 'embedding') {
                      dynamicSub =
                        telemetry?.subsystems.find((s) => s.id === 'embedding_model')?.target ??
                        'e5-small-v2';
                    } else if (node.id === 'chatgpt') {
                      dynamicSub = `:443 ${aiSub?.statusText ?? 'STANDBY'}`;
                    } else if (node.id === 'router') {
                      dynamicSub = `${telemetry?.ragChunkCount ?? 0} chunks · ${routerSub?.statusText ?? 'ONLINE'}`;
                    }

                    const stroke = connectedError
                      ? '#FB7185'
                      : connectedGlowing || subsystemSelected
                        ? '#38BDF8'
                        : '#334155';

                    return (
                      <g key={node.id} data-node-id={node.id}>
                        <rect
                          x={node.x}
                          y={node.y}
                          width={node.w}
                          height={node.h}
                          rx="4"
                          fill={connectedGlowing ? '#0F172A' : '#0B1220'}
                          stroke={stroke}
                          strokeWidth={connectedGlowing || subsystemSelected ? 1.25 : 0.9}
                          filter={connectedGlowing ? 'url(#port-glow-blue)' : undefined}
                        />
                        <text
                          x={node.x + node.w / 2}
                          y={node.y + 14.5}
                          textAnchor="middle"
                          fill="#F8FAFC"
                          fontSize="8.3"
                          fontWeight="600"
                          fontFamily="Plus Jakarta Sans, sans-serif"
                        >
                          {node.label}
                        </text>
                        <text
                          x={node.x + node.w / 2}
                          y={node.y + 27.5}
                          textAnchor="middle"
                          fill={connectedGlowing ? '#7DD3FC' : '#94A3B8'}
                          fontSize="7.1"
                          fontFamily="JetBrains Mono, monospace"
                        >
                          {dynamicSub}
                        </text>
                      </g>
                    );
                  })}
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
                      <th className="py-1.5 px-2.5 font-semibold">Port / Channel</th>
                      <th className="py-1.5 px-2.5 font-semibold">Process</th>
                      <th className="py-1.5 px-2.5 font-semibold text-right">State</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {ports.map((p, idx) => (
                      <tr key={idx} className="bg-white">
                        <td className="py-1.5 px-2.5 font-mono tabular-nums font-medium text-slate-900 whitespace-nowrap">
                          {p.port > 0 ? `:${p.port}` : p.protocol} · {p.protocol}
                        </td>
                        <td className="py-1.5 px-2.5 text-slate-700">
                          <div className="font-medium truncate max-w-[165px]">{p.service}</div>
                          <div className="font-mono text-[10px] text-slate-500 truncate max-w-[165px]">
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
