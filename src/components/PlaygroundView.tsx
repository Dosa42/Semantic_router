import React, { useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Play,
  RotateCcw,
} from 'lucide-react';
import { SAMPLE_PLAYGROUND_PROMPTS } from '../lib/seedData';
import type {
  RouteDecisionResult,
  RouterConfig,
  RoutingTraceEntry,
  TelemetrySnapshot,
} from '../lib/types';
import { TelemetryPanel } from './TelemetryPanel';

interface PlaygroundViewProps {
  config: RouterConfig;
  decision: RouteDecisionResult | null;
  loading: boolean;
  error: string | null;
  traceHistory: RoutingTraceEntry[];
  telemetry: TelemetrySnapshot | null;
  telemetryStreamConnected: boolean;
  probingTelemetry: boolean;
  onProbeHealth: () => Promise<void>;
  onRunRoute: (query: string) => Promise<void>;
  onNavigateToRoutes: () => void;
  onOpenChatGptAuth: () => void;
}

export function PlaygroundView({
  config,
  decision,
  loading,
  error,
  traceHistory,
  telemetry,
  telemetryStreamConnected,
  probingTelemetry,
  onProbeHealth,
  onRunRoute,
  onNavigateToRoutes,
  onOpenChatGptAuth,
}: PlaygroundViewProps) {
  const [query, setQuery] = useState(SAMPLE_PLAYGROUND_PROMPTS[0].prompt);
  const [expandedRouteId, setExpandedRouteId] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    await onRunRoute(query);
  };

  const handleSelectSample = async (samplePrompt: string) => {
    setQuery(samplePrompt);
    await onRunRoute(samplePrompt);
  };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[410px_minmax(0,1fr)] gap-6 items-start">
      <div className="xl:sticky xl:top-20">
        <TelemetryPanel
          telemetry={telemetry}
          streamConnected={telemetryStreamConnected}
          probing={probingTelemetry}
          onProbeHealth={onProbeHealth}
          onOpenChatGptAuth={onOpenChatGptAuth}
        />
      </div>

      <div className="space-y-6 min-w-0">
        {/* Prompt Dispatch Surface */}
        <section className="bg-white border border-slate-200 rounded-lg p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">Semantic Routing Playground</h1>
            <p className="text-sm text-slate-600 mt-1">
              Test incoming LLM prompts against your indexed routes using{' '}
              <span className="font-mono text-slate-800">{config.mode}</span> similarity and{' '}
              <span className="font-mono text-slate-800">{config.aggregation}</span> aggregation.
            </p>
          </div>
          <button
            type="button"
            onClick={onNavigateToRoutes}
            className="text-sm font-medium text-blue-600 hover:text-blue-700 hover:underline whitespace-nowrap shrink-0"
          >
            Manage Routes
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="playground-prompt-input" className="sr-only">
              User Prompt to Route
            </label>
            <textarea
              id="playground-prompt-input"
              rows={3}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  void onRunRoute(query);
                }
              }}
              placeholder="Enter an incoming user prompt to route..."
              className="w-full px-4 py-3 text-sm text-slate-900 bg-slate-50 border border-slate-300 rounded-md focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600 transition-colors"
            />
          </div>

          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-slate-500 mr-1">Samples:</span>
              {SAMPLE_PLAYGROUND_PROMPTS.map((sample) => (
                <button
                  key={sample.label}
                  type="button"
                  onClick={() => void handleSelectSample(sample.prompt)}
                  className="px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 border border-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0"
                >
                  {sample.label}
                </button>
              ))}
            </div>

            <div className="flex items-center justify-between gap-3 pt-2 border-t border-slate-100">
              <span className="text-xs text-slate-500 hidden sm:inline">
                Press <kbd className="px-1.5 py-0.5 font-mono text-[11px] bg-slate-100 border border-slate-200 rounded">Ctrl/Cmd + Enter</kbd> to route
              </span>
              <div className="flex items-center gap-2 ml-auto shrink-0">
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="px-3 py-2 text-sm font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-md transition-colors whitespace-nowrap shrink-0"
                >
                  Clear
                </button>
                <button
                  type="submit"
                  disabled={loading || !query.trim()}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-md transition-colors whitespace-nowrap shrink-0"
                >
                  <Play className="w-4 h-4" />
                  {loading ? 'Routing...' : 'Route Prompt'}
                </button>
              </div>
            </div>
          </div>
        </form>

        {error && (
          <div
            role="alert"
            className="mt-4 px-4 py-3 text-sm text-rose-800 bg-rose-50 border border-rose-200 rounded-md"
          >
            {error}
          </div>
        )}
      </section>

      {/* Routing Decision Focal Anchor */}
      {decision && (
        <section
          aria-label="Routing Decision Result"
          className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-200"
        >
          <div className="p-6 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-xs font-medium">
                {decision.matchedRoute ? (
                  <span className="inline-flex items-center gap-1.5 text-emerald-700">
                    <CheckCircle2 className="w-4 h-4" />
                    Route Matched
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-amber-700">
                    <AlertTriangle className="w-4 h-4" />
                    Below Threshold · Fallback to None
                  </span>
                )}
                <span aria-hidden="true" className="text-slate-300">
                  ·
                </span>
                <span className="text-slate-500">{decision.encoderUsed}</span>
              </div>

              <div className="flex flex-wrap items-baseline gap-3">
                <h2 className="text-2xl font-bold font-mono text-slate-900">
                  {decision.matchedRoute ?? 'None'}
                </h2>
                {decision.targetModel && (
                  <span className="inline-flex items-center gap-1.5 text-sm text-slate-600 font-mono">
                    <ArrowRight className="w-3.5 h-3.5 text-slate-400" />
                    {decision.targetModel}
                  </span>
                )}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-6 pt-3 lg:pt-0 border-t lg:border-t-0 border-slate-100">
              <div>
                <div className="text-xs text-slate-500">Top Score</div>
                <div className="text-lg font-mono tabular-nums font-semibold text-slate-900 mt-0.5">
                  {decision.topScore.toFixed(4)}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Threshold</div>
                <div className="text-lg font-mono tabular-nums font-semibold text-slate-900 mt-0.5">
                  {decision.thresholdUsed !== null ? decision.thresholdUsed.toFixed(2) : '—'}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Latency</div>
                <div className="text-lg font-mono tabular-nums font-semibold text-slate-900 mt-0.5">
                  {decision.latencyMs.toFixed(2)} ms
                </div>
              </div>
            </div>
          </div>

          {/* Dynamic Function Call Payload */}
          {decision.functionCall && (
            <div className="p-6 bg-slate-50/70">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
                <h3 className="text-sm font-semibold text-slate-900">
                  Dynamic Route Function Extraction
                </h3>
                <span className="text-xs font-mono text-slate-600">
                  Extractor: {decision.functionCall.extractionMethod}
                </span>
              </div>
              <pre className="p-4 text-xs font-mono text-slate-800 bg-white border border-slate-200 rounded-md overflow-x-auto">
                {JSON.stringify(
                  {
                    function: decision.functionCall.name,
                    arguments: decision.functionCall.arguments,
                  },
                  null,
                  2
                )}
              </pre>
            </div>
          )}

          {/* Provider Function Execution */}
          {decision.providerExecution && (
            <div className="p-6 bg-slate-50/40">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
                <h3 className="text-sm font-semibold text-slate-900">
                  Provider Function Execution
                </h3>
                <div className="flex items-center gap-3">
                  <span className="text-xs font-mono tabular-nums text-slate-600">
                    {decision.providerExecution.handlerName} · {decision.providerExecution.providerKind} ·{' '}
                    {decision.providerExecution.latencyMs.toFixed(2)} ms
                  </span>
                  {decision.providerExecution.status === 'auth_required' && (
                    <button
                      type="button"
                      data-oai-siwc-button=""
                      onClick={onOpenChatGptAuth}
                      className="px-3 py-1.5 text-xs font-medium text-white bg-slate-950 hover:bg-slate-800 rounded-md transition-colors whitespace-nowrap shrink-0"
                    >
                      Continue with ChatGPT
                    </button>
                  )}
                </div>
              </div>
              <pre className="p-4 text-xs font-mono text-slate-800 bg-white border border-slate-200 rounded-md overflow-x-auto">
                {JSON.stringify(decision.providerExecution.output, null, 2)}
              </pre>
            </div>
          )}

          {/* Similarity Waterfall Breakdown */}
          <div className="p-6">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-slate-900">
                Similarity Breakdown Across Indexed Routes
              </h3>
              <span className="text-xs text-slate-500">
                Click any row to inspect top matching utterances
              </span>
            </div>

            <div className="overflow-x-auto border border-slate-200 rounded-md">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-xs font-medium text-slate-600">
                    <th className="py-2.5 px-3">Route</th>
                    <th className="py-2.5 px-3 text-right">Score</th>
                    <th className="py-2.5 px-3 text-right">Threshold</th>
                    <th className="py-2.5 px-3 text-right">Margin</th>
                    <th className="py-2.5 px-3 w-48">Threshold Bar</th>
                    <th className="py-2.5 px-3">Top Utterance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 text-sm">
                  {decision.allScores.map((row) => {
                    const isWinner = decision.matchedRouteId === row.routeId;
                    const isExpanded = expandedRouteId === row.routeId;
                    const scorePct = Math.min(100, Math.max(0, row.score * 100));
                    const threshPct = Math.min(100, Math.max(0, row.threshold * 100));

                    return (
                      <React.Fragment key={row.routeId}>
                        <tr className={isWinner ? 'bg-blue-50/50' : 'hover:bg-slate-50'}>
                          <td className="py-2.5 px-3">
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedRouteId(isExpanded ? null : row.routeId)
                              }
                              aria-expanded={isExpanded}
                              className="inline-flex items-center gap-1.5 font-mono text-xs font-semibold text-slate-900 hover:text-blue-600"
                            >
                              {isExpanded ? (
                                <ChevronUp className="w-3.5 h-3.5 text-slate-400" />
                              ) : (
                                <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                              )}
                              {row.routeName}
                            </button>
                            <div className="text-xs text-slate-500 pl-5">
                              {row.routeType === 'dynamic' ? 'Dynamic' : 'Static'} · {row.targetModel}
                            </div>
                          </td>

                          <td className="py-2.5 px-3 text-right font-mono tabular-nums text-xs font-semibold text-slate-900">
                            {row.score.toFixed(4)}
                          </td>

                          <td className="py-2.5 px-3 text-right font-mono tabular-nums text-xs text-slate-600">
                            {row.threshold.toFixed(2)}
                          </td>

                          <td
                            className={`py-2.5 px-3 text-right font-mono tabular-nums text-xs font-medium ${
                              row.margin >= 0 ? 'text-emerald-700' : 'text-slate-500'
                            }`}
                          >
                            {row.margin >= 0 ? `+${row.margin.toFixed(3)}` : row.margin.toFixed(3)}
                          </td>

                          <td className="py-2.5 px-3">
                            <div
                              className="relative h-2.5 w-44 bg-slate-100 rounded-xs overflow-visible border border-slate-200"
                              aria-label={`${row.routeName} score ${row.score.toFixed(2)} vs threshold ${row.threshold.toFixed(2)}`}
                            >
                              <div
                                className={`h-full rounded-xs transition-all ${
                                  isWinner
                                    ? 'bg-blue-600'
                                    : row.passed
                                      ? 'bg-emerald-600'
                                      : 'bg-slate-400'
                                }`}
                                style={{ width: `${scorePct}%` }}
                              />
                              <div
                                title={`Threshold ${row.threshold.toFixed(2)}`}
                                className="absolute -top-1 -bottom-1 w-0.5 bg-slate-900"
                                style={{ left: `${threshPct}%` }}
                              />
                            </div>
                          </td>

                          <td className="py-2.5 px-3 text-xs text-slate-600 max-w-xs truncate">
                            {row.topUtterance}
                          </td>
                        </tr>

                        {isExpanded && (
                          <tr className="bg-slate-50">
                            <td colSpan={6} className="px-6 py-3">
                              <div className="text-xs font-medium text-slate-700 mb-2">
                                Utterance-level scores for <span className="font-mono">{row.routeName}</span>{' '}
                                (Dense: <span className="font-mono tabular-nums">{row.denseScore.toFixed(3)}</span> ·
                                Sparse: <span className="font-mono tabular-nums">{row.sparseScore.toFixed(3)}</span>)
                              </div>
                              <ul className="space-y-1">
                                {row.utteranceMatches.map((m, i) => (
                                  <li
                                    key={i}
                                    className="flex items-center justify-between gap-4 text-xs text-slate-600 py-1 border-b border-slate-200/70 last:border-b-0"
                                  >
                                    <span className="truncate">{m.utterance}</span>
                                    <span className="font-mono tabular-nums text-slate-800 shrink-0">
                                      {m.score.toFixed(4)} (D {m.denseScore.toFixed(2)} / S{' '}
                                      {m.sparseScore.toFixed(2)})
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {/* Trace History */}
      {traceHistory.length > 0 && (
        <section className="bg-white border border-slate-200 rounded-lg p-6">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
              <Clock className="w-4 h-4 text-slate-500" />
              Recent Routing Traces
            </h3>
            <span className="text-xs font-mono tabular-nums text-slate-500">
              {traceHistory.length} recorded
            </span>
          </div>

          <div className="divide-y divide-slate-200 border border-slate-200 rounded-md">
            {traceHistory.slice(0, 6).map((entry) => (
              <div
                key={entry.id}
                className="flex items-center justify-between gap-4 px-4 py-2.5 text-xs hover:bg-slate-50"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-slate-900 font-medium truncate">{entry.result.query}</div>
                  <div className="text-slate-500 mt-0.5 flex items-center gap-2">
                    <span className="font-mono">
                      {entry.result.matchedRoute ?? 'None (Fallback)'}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums">
                      Score {entry.result.topScore.toFixed(3)}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums">
                      {entry.result.latencyMs.toFixed(2)} ms
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleSelectSample(entry.result.query)}
                  aria-label={`Replay prompt ${entry.result.query}`}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 rounded transition-colors whitespace-nowrap shrink-0"
                >
                  <RotateCcw className="w-3 h-3" />
                  Replay
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
      </div>
    </div>
  );
}
