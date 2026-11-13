import React, { useState } from 'react';
import { CheckCircle2, Cpu, Play, ShieldAlert, Wrench } from 'lucide-react';
import {
  ENCODER_PROVIDERS,
  ROUTE_PROVIDER_FUNCTIONS,
  type RouteProviderFunctionInfo,
} from '../lib/providers';
import type {
  EncoderModelId,
  ProviderExecutionResult,
  RouterConfig,
} from '../lib/types';

interface ProvidersViewProps {
  config: RouterConfig;
  onSelectEncoder: (encoderModel: EncoderModelId) => Promise<void>;
}

interface EmbedTestResult {
  text: string;
  encoderModel: EncoderModelId;
  encoderUsed: string;
  dimensions: number;
  preview: number[];
  latencyMs: number;
}

export function ProvidersView({ config, onSelectEncoder }: ProvidersViewProps) {
  const [probeText, setProbeText] = useState('What is the current local time in Tokyo right now?');
  const [embedResult, setEmbedResult] = useState<EmbedTestResult | null>(null);
  const [embedLoading, setEmbedLoading] = useState(false);

  const [execResult, setExecResult] = useState<ProviderExecutionResult | null>(null);
  const [execLoadingId, setExecLoadingId] = useState<string | null>(null);

  const handleEmbedTest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!probeText.trim()) return;
    setEmbedLoading(true);
    try {
      const res = await fetch('/api/providers/embed-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: probeText, encoderModel: config.encoderModel }),
      });
      if (res.ok) {
        setEmbedResult((await res.json()) as EmbedTestResult);
      }
    } finally {
      setEmbedLoading(false);
    }
  };

  const handleTestProviderFn = async (fnInfo: RouteProviderFunctionInfo) => {
    setExecLoadingId(fnInfo.id);
    try {
      const prompt =
        typeof fnInfo.sampleArgs.prompt === 'string'
          ? fnInfo.sampleArgs.prompt
          : typeof fnInfo.sampleArgs.query === 'string'
            ? fnInfo.sampleArgs.query
            : `Test invocation for ${fnInfo.id}`;
      const res = await fetch('/api/providers/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: fnInfo.id,
          arguments: fnInfo.sampleArgs,
          query: prompt,
        }),
      });
      if (res.ok) {
        setExecResult((await res.json()) as ProviderExecutionResult);
      }
    } finally {
      setExecLoadingId(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Section 1: Embedding Model Providers (E5, Local Hybrid) */}
      <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-5">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">
            Embedding Models & Provider Functions
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Inspect active bi-encoder embedding providers including{' '}
            <span className="font-mono text-slate-800">intfloat/e5-small-v2</span> and execute
            registered route handler functions.
          </p>
        </div>

        <div className="overflow-x-auto border border-slate-200 rounded-md">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-xs font-medium text-slate-600">
                <th className="py-2.5 px-4">Encoder Model</th>
                <th className="py-2.5 px-4">Provider / Runtime</th>
                <th className="py-2.5 px-4 text-right">Dims</th>
                <th className="py-2.5 px-4">Prefix Scheme</th>
                <th className="py-2.5 px-4 text-right">Default Threshold</th>
                <th className="py-2.5 px-4 text-right">Selection</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-xs">
              {ENCODER_PROVIDERS.map((enc) => {
                const isActive = config.encoderModel === enc.id;
                return (
                  <tr key={enc.id} className={isActive ? 'bg-blue-50/50' : 'hover:bg-slate-50'}>
                    <td className="py-3 px-4 max-w-xs">
                      <div className="font-mono font-semibold text-slate-900">{enc.modelName}</div>
                      <div className="text-slate-500 mt-0.5">{enc.description}</div>
                    </td>
                    <td className="py-3 px-4">
                      <div className="font-medium text-slate-800">{enc.providerName}</div>
                      <div className="font-mono text-[11px] text-slate-500 mt-0.5">
                        {enc.sdkClass}
                      </div>
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-800">
                      {enc.dimensions}
                    </td>
                    <td className="py-3 px-4 text-slate-700">{enc.prefixScheme}</td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-800">
                      {enc.recommendedThreshold.toFixed(2)}
                    </td>
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      {isActive ? (
                        <span className="inline-flex items-center gap-1 font-medium text-emerald-700">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          Active
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void onSelectEncoder(enc.id)}
                          className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded transition-colors whitespace-nowrap shrink-0"
                        >
                          Use Encoder
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Live Vector Probe */}
        <div className="pt-4 border-t border-slate-200 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
              <Cpu className="w-4 h-4 text-slate-500" />
              Live Embedding Vector Probe
            </h2>
            <span className="text-xs font-mono text-slate-500">
              Active: {config.encoderModel}
            </span>
          </div>

          <form onSubmit={handleEmbedTest} className="flex flex-col sm:flex-row gap-3">
            <label htmlFor="embed-probe-input" className="sr-only">
              Text to encode
            </label>
            <input
              id="embed-probe-input"
              type="text"
              value={probeText}
              onChange={(e) => setProbeText(e.target.value)}
              placeholder="Enter text to compute dense vector..."
              className="flex-1 px-3 py-2 text-sm bg-slate-50 border border-slate-300 rounded-md focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
            <button
              type="submit"
              disabled={embedLoading || !probeText.trim()}
              className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              <Play className="w-4 h-4" />
              {embedLoading ? 'Encoding...' : 'Encode Vector'}
            </button>
          </form>

          {embedResult && (
            <div className="p-4 bg-slate-50 border border-slate-200 rounded-md text-xs space-y-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2 text-slate-700">
                <span className="font-mono font-semibold text-slate-900">
                  {embedResult.encoderUsed}
                </span>
                <span className="font-mono tabular-nums text-slate-600">
                  {embedResult.dimensions} dims · {embedResult.latencyMs.toFixed(2)} ms
                </span>
              </div>
              <div className="font-mono text-slate-700 overflow-x-auto">
                [{embedResult.preview.join(', ')}, ...]
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Section 2: Route Provider Functions */}
      <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2">
            <Wrench className="w-4 h-4 text-slate-500" />
            Route Provider Functions
          </h2>
          <p className="text-sm text-slate-600 mt-1">
            Executable tool handlers, OpenAI ChatGPT Plan dispatchers, and guardrail policy
            functions bound to route targets.
          </p>
        </div>

        <div className="overflow-x-auto border border-slate-200 rounded-md">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-xs font-medium text-slate-600">
                <th className="py-2.5 px-4">Target Handler ID</th>
                <th className="py-2.5 px-4">Kind</th>
                <th className="py-2.5 px-4">Provider Function Signature</th>
                <th className="py-2.5 px-4">Description</th>
                <th className="py-2.5 px-4 text-right">Invoke</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-xs">
              {ROUTE_PROVIDER_FUNCTIONS.map((fn) => (
                <tr key={fn.id} className="hover:bg-slate-50">
                  <td className="py-3 px-4 font-mono font-semibold text-slate-900 whitespace-nowrap">
                    {fn.id}
                  </td>
                  <td className="py-3 px-4 text-slate-700 capitalize whitespace-nowrap">
                    {fn.kind === 'guardrail' ? (
                      <span className="inline-flex items-center gap-1 text-amber-700 font-medium">
                        <ShieldAlert className="w-3.5 h-3.5" />
                        Guardrail
                      </span>
                    ) : (
                      fn.kind
                    )}
                  </td>
                  <td className="py-3 px-4 font-mono text-[11px] text-slate-700">
                    {fn.signature}
                  </td>
                  <td className="py-3 px-4 text-slate-600 max-w-sm">{fn.description}</td>
                  <td className="py-3 px-4 text-right whitespace-nowrap">
                    <button
                      type="button"
                      disabled={execLoadingId === fn.id}
                      onClick={() => void handleTestProviderFn(fn)}
                      aria-label={`Test provider function ${fn.id}`}
                      className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-50 rounded transition-colors whitespace-nowrap shrink-0"
                    >
                      {execLoadingId === fn.id ? 'Running...' : 'Test Function'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {execResult && (
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-md space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="font-mono font-semibold text-slate-900">
                {execResult.handlerName} ({execResult.providerId})
              </div>
              <div className="font-mono tabular-nums text-slate-600">
                Status: {execResult.status} · {execResult.latencyMs.toFixed(2)} ms
              </div>
            </div>
            <pre className="p-3 text-xs font-mono text-slate-800 bg-white border border-slate-200 rounded overflow-x-auto">
              {JSON.stringify(execResult.output, null, 2)}
            </pre>
          </div>
        )}
      </section>
    </div>
  );
}
