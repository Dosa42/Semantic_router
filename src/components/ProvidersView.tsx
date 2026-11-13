import React, { useEffect, useState } from 'react';
import { CheckCircle2, Cpu, Layers, Play, RefreshCw, ShieldAlert, Wrench } from 'lucide-react';
import {
  ENCODER_PROVIDERS,
  ROUTE_PROVIDER_FUNCTIONS,
  type RouteProviderFunctionInfo,
} from '../lib/providers';
import { DEFAULT_ENSEMBLE_CONFIG } from '../lib/seedData';
import type {
  EmbeddingSlotConfig,
  EmbeddingSlotRole,
  EncoderModelId,
  EnsembleConfig,
  EnsembleFusionMode,
  EnsembleSlotRuntimeStatus,
  LocalModelInventoryItem,
  ProviderExecutionResult,
  RouterConfig,
} from '../lib/types';

interface ProvidersViewProps {
  config: RouterConfig;
  slotStatuses?: EnsembleSlotRuntimeStatus[];
  localModels?: LocalModelInventoryItem[];
  onSelectEncoder: (encoderModel: EncoderModelId) => Promise<void>;
  onUpdateEnsemble: (ensemble: EnsembleConfig) => Promise<void>;
}

interface EmbedTestResult {
  text: string;
  encoderModel: EncoderModelId;
  encoderUsed: string;
  dimensions: number;
  preview: number[];
  latencyMs: number;
}

const ROLE_DESCRIPTIONS: Record<EmbeddingSlotRole, string> = {
  intent: 'EM-1 · Primary intent & guardrail classifier',
  domain: 'EM-2 · Technical domain & RAG retrieval matcher',
  state: 'EM-3 · Semantic milestone & agent progress tracker',
};

const FUSION_MODE_OPTIONS: Array<{ value: EnsembleFusionMode; label: string; hint: string }> = [
  { value: 'weighted_sum', label: 'weighted_sum', hint: 'Normalized weight sum across active slots' },
  { value: 'max', label: 'max', hint: 'Highest confidence across active encoders' },
  { value: 'cascade', label: 'cascade', hint: 'Intent slot gates (>= 0.30) before fusion' },
];

export function ProvidersView({
  config,
  slotStatuses = [],
  localModels = [],
  onSelectEncoder,
  onUpdateEnsemble,
}: ProvidersViewProps) {
  const [ensembleDraft, setEnsembleDraft] = useState<EnsembleConfig>(
    () => config.encoderEnsemble ?? structuredClone(DEFAULT_ENSEMBLE_CONFIG)
  );
  const [savingEnsemble, setSavingEnsemble] = useState(false);
  const [ensembleSavedNotice, setEnsembleSavedNotice] = useState(false);

  const [probeText, setProbeText] = useState('What is the current local time in Tokyo right now?');
  const [probeEncoder, setProbeEncoder] = useState<EncoderModelId>(config.encoderModel);
  const [embedResult, setEmbedResult] = useState<EmbedTestResult | null>(null);
  const [embedLoading, setEmbedLoading] = useState(false);

  const [execResult, setExecResult] = useState<ProviderExecutionResult | null>(null);
  const [execLoadingId, setExecLoadingId] = useState<string | null>(null);

  useEffect(() => {
    if (config.encoderEnsemble) {
      setEnsembleDraft(config.encoderEnsemble);
    }
  }, [config.encoderEnsemble]);

  const updateSlot = (role: EmbeddingSlotRole, patch: Partial<EmbeddingSlotConfig>) => {
    setEnsembleDraft((prev) => ({
      ...prev,
      slots: prev.slots.map((slot) =>
        slot.role === role ? { ...slot, ...patch } : slot
      ) as EnsembleConfig['slots'],
    }));
  };

  const handleSaveEnsemble = async () => {
    setSavingEnsemble(true);
    setEnsembleSavedNotice(false);
    try {
      await onUpdateEnsemble(ensembleDraft);
      setEnsembleSavedNotice(true);
      window.setTimeout(() => setEnsembleSavedNotice(false), 1800);
    } finally {
      setSavingEnsemble(false);
    }
  };

  const handleEmbedTest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!probeText.trim()) return;
    setEmbedLoading(true);
    try {
      const res = await fetch('/api/providers/embed-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: probeText, encoderModel: probeEncoder }),
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

  const totalEnabledWeight = ensembleDraft.slots
    .filter((s) => s.enabled)
    .reduce((acc, s) => acc + s.weight, 0);

  return (
    <div className="space-y-6">
      {/* Section 1: 3-Slot Multi-Embedding Ensemble Config */}
      <section
        aria-label="3-Slot Multi-Embedding Ensemble"
        className="bg-white border border-slate-200 rounded-lg p-6 space-y-5"
      >
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-slate-900 flex items-center gap-2">
              <Layers className="w-5 h-5 text-blue-600 shrink-0" />
              3-Slot Multi-Embedding Ensemble
            </h1>
            <p className="text-sm text-slate-600 mt-1">
              Run three specialized encoders in parallel across intent classification, domain/RAG
              matching, and <span className="font-mono text-slate-800">BAAI/bge-m3</span> state
              progress tracking.
            </p>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            {ensembleSavedNotice && (
              <span className="text-xs font-medium text-emerald-700 inline-flex items-center gap-1 whitespace-nowrap">
                <CheckCircle2 className="w-3.5 h-3.5" />
                Saved
              </span>
            )}
            <button
              type="button"
              onClick={() => void handleSaveEnsemble()}
              disabled={savingEnsemble}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              {savingEnsemble && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
              Apply Ensemble Config
            </button>
          </div>
        </div>

        {/* Slot Cards */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {ensembleDraft.slots.map((slot, idx) => {
            const runtime = slotStatuses.find((s) => s.role === slot.role);
            const providerInfo = ENCODER_PROVIDERS.find((p) => p.id === slot.modelId);
            const statusText = runtime?.status ?? (slot.enabled ? 'ready' : 'idle');
            const lampClass =
              statusText === 'ready'
                ? 'bg-emerald-500'
                : statusText === 'error'
                  ? 'bg-rose-500'
                  : statusText === 'loading'
                    ? 'bg-amber-400'
                    : 'bg-slate-300';

            return (
              <div
                key={slot.role}
                data-testid={`ensemble-slot-${slot.role}`}
                className={`p-4 rounded-md border space-y-3 transition-colors ${
                  slot.enabled
                    ? 'bg-slate-50/60 border-slate-200'
                    : 'bg-slate-50/30 border-slate-200 opacity-70'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono font-bold uppercase tracking-wide text-slate-900">
                        EM-{idx + 1} · {slot.role}
                      </span>
                      <span
                        className={`w-2 h-2 rounded-full shrink-0 ${lampClass}`}
                        title={`Slot status: ${statusText}`}
                      />
                      <span className="text-[11px] font-mono uppercase text-slate-500">
                        {statusText}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5 truncate">
                      {ROLE_DESCRIPTIONS[slot.role]}
                    </div>
                  </div>

                  <label className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 cursor-pointer shrink-0">
                    <input
                      type="checkbox"
                      aria-label={`Enable ${slot.role} slot`}
                      checked={slot.enabled}
                      onChange={(e) => updateSlot(slot.role, { enabled: e.target.checked })}
                      className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-600"
                    />
                    Enabled
                  </label>
                </div>

                <div>
                  <label
                    htmlFor={`slot-model-${slot.role}`}
                    className="block text-[11px] font-medium text-slate-700 mb-1"
                  >
                    Encoder Model
                  </label>
                  <select
                    id={`slot-model-${slot.role}`}
                    value={slot.modelId}
                    onChange={(e) =>
                      updateSlot(slot.role, { modelId: e.target.value as EncoderModelId })
                    }
                    className="w-full px-2.5 py-1.5 text-xs font-mono bg-white border border-slate-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-600"
                  >
                    {ENCODER_PROVIDERS.map((enc) => (
                      <option key={enc.id} value={enc.id}>
                        {enc.modelName} ({enc.dimensions}d)
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <label
                      htmlFor={`slot-weight-${slot.role}`}
                      className="text-[11px] font-medium text-slate-700"
                    >
                      Fusion Weight
                    </label>
                    <span className="font-mono tabular-nums text-slate-900 font-semibold">
                      {slot.weight.toFixed(2)}
                    </span>
                  </div>
                  <input
                    id={`slot-weight-${slot.role}`}
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={slot.weight}
                    onChange={(e) => updateSlot(slot.role, { weight: Number(e.target.value) })}
                    className="w-full accent-blue-600 cursor-pointer"
                  />
                </div>

                <div className="pt-2 border-t border-slate-200 flex items-center justify-between text-[11px] font-mono tabular-nums text-slate-500">
                  <span>{providerInfo?.dimensions ?? runtime?.dimensions ?? 256}d vector</span>
                  <span>
                    {runtime
                      ? `${runtime.cachedCount} cached · ${
                          runtime.lastLatencyMs !== null ? `${runtime.lastLatencyMs.toFixed(1)}ms` : 'ready'
                        }`
                      : providerInfo?.defaultRole}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Fusion Mode & Parallel Load Bar */}
        <div className="pt-4 border-t border-slate-200 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div className="space-y-1.5">
            <span className="block text-xs font-semibold text-slate-800">
              Score Fusion Mode
            </span>
            <div className="flex flex-wrap items-center gap-2">
              {FUSION_MODE_OPTIONS.map((opt) => {
                const active = ensembleDraft.fusionMode === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() =>
                      setEnsembleDraft((prev) => ({ ...prev, fusionMode: opt.value }))
                    }
                    title={opt.hint}
                    className={`px-3 py-1.5 text-xs font-mono rounded border transition-colors whitespace-nowrap shrink-0 ${
                      active
                        ? 'bg-blue-50 text-blue-700 border-blue-600 font-semibold'
                        : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
              <span className="text-xs text-slate-500 ml-1">
                {FUSION_MODE_OPTIONS.find((o) => o.value === ensembleDraft.fusionMode)?.hint}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-4 text-xs">
            <span className="font-mono tabular-nums text-slate-600">
              Active weight sum: <strong className="text-slate-900">{totalEnabledWeight.toFixed(2)}</strong>
            </span>
            <label className="inline-flex items-center gap-2 text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={ensembleDraft.parallelLoad}
                onChange={(e) =>
                  setEnsembleDraft((prev) => ({ ...prev, parallelLoad: e.target.checked }))
                }
                className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-600"
              />
              <span className="font-medium">Parallel Promise.all Slot Loading</span>
            </label>
          </div>
        </div>
      </section>

      {/* Section 2: Registered Embedding Providers (E5, Local Hybrid, BGE-M3) */}
      <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-5">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            Embedding Model Registry &amp; Live Vector Probe
          </h2>
          <p className="text-sm text-slate-600 mt-1">
            Inspect available embedding encoders including{' '}
            <span className="font-mono text-slate-800">intfloat/e5-small-v2</span>,{' '}
            <span className="font-mono text-slate-800">subword-256d-bm25</span>, and{' '}
            <span className="font-mono text-slate-800">BAAI/bge-m3</span>.
          </p>
        </div>

        <div className="overflow-x-auto border border-slate-200 rounded-md">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-xs font-medium text-slate-600">
                <th className="py-2.5 px-4">Encoder Model</th>
                <th className="py-2.5 px-4">Default Role</th>
                <th className="py-2.5 px-4">Provider / Runtime</th>
                <th className="py-2.5 px-4 text-right">Dims</th>
                <th className="py-2.5 px-4">Prefix Scheme</th>
                <th className="py-2.5 px-4 text-right">Threshold</th>
                <th className="py-2.5 px-4 text-right">Single Fallback</th>
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
                    <td className="py-3 px-4 font-mono uppercase text-slate-700 whitespace-nowrap">
                      {enc.defaultRole}
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
                          Primary
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void onSelectEncoder(enc.id)}
                          className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded transition-colors whitespace-nowrap shrink-0"
                        >
                          Set Primary
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Local Git LFS Model Registry (models/) */}
        {localModels.length > 0 && (
          <div
            data-testid="local-lfs-models-panel"
            className="pt-4 border-t border-slate-200 space-y-3"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  Local Git LFS Model Registry (<code className="font-mono">models/</code>)
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Offline-ready ONNX weights cloned by <code className="font-mono">fetch-embedding-models.yml</code> into Git LFS for runner vectorization.
                </p>
              </div>
              <span className="text-xs font-mono tabular-nums text-slate-600">
                {localModels.filter((m) => m.installedInLfs).length} / {localModels.length} ready locally
              </span>
            </div>

            <div className="overflow-x-auto border border-slate-200 rounded-md">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                    <th className="py-2 px-3 font-medium">Model / Repo</th>
                    <th className="py-2 px-3 font-medium">Pooling · Ctx</th>
                    <th className="py-2 px-3 text-right font-medium">Dims</th>
                    <th className="py-2 px-3 font-medium">Local Path / ONNX File</th>
                    <th className="py-2 px-3 text-right font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {localModels.map((item) => {
                    const sizeMb =
                      item.totalBytes > 0
                        ? `${(item.totalBytes / (1024 * 1024)).toFixed(1)} MB`
                        : null;
                    return (
                      <tr key={item.id} className="hover:bg-slate-50">
                        <td className="py-2 px-3">
                          <div className="font-mono font-semibold text-slate-900">{item.id}</div>
                          <div className="font-mono text-[11px] text-slate-500">{item.hfRepo}</div>
                        </td>
                        <td className="py-2 px-3 font-mono text-[11px] text-slate-700 whitespace-nowrap">
                          {item.pooling} · {item.maxTokens} tok
                        </td>
                        <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-800 whitespace-nowrap">
                          {item.dimensions}d
                        </td>
                        <td className="py-2 px-3 font-mono text-[11px] text-slate-600">
                          <div>{item.localPath}</div>
                          {item.onnxFile && (
                            <div className="text-slate-500">
                              {item.onnxFile}
                              {sizeMb ? ` · ${sizeMb}` : ''}
                            </div>
                          )}
                        </td>
                        <td className="py-2 px-3 text-right font-mono text-[11px] whitespace-nowrap">
                          {item.source === 'deterministic-local' ? (
                            <span className="text-slate-700 font-medium">Built-in Deterministic</span>
                          ) : item.installedInLfs ? (
                            <span className="text-emerald-700 font-semibold">Cloned in Git LFS</span>
                          ) : (
                            <span className="text-amber-700 font-medium">Stage 1 Fetch Needed</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Live Vector Probe */}
        <div className="pt-4 border-t border-slate-200 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
              <Cpu className="w-4 h-4 text-slate-500" />
              Live Embedding Vector Probe
            </h3>
            <div className="flex items-center gap-2">
              <label htmlFor="probe-encoder-select" className="text-xs text-slate-500">
                Target Encoder:
              </label>
              <select
                id="probe-encoder-select"
                value={probeEncoder}
                onChange={(e) => setProbeEncoder(e.target.value as EncoderModelId)}
                className="px-2 py-1 text-xs font-mono bg-white border border-slate-300 rounded"
              >
                {ENCODER_PROVIDERS.map((enc) => (
                  <option key={enc.id} value={enc.id}>
                    {enc.modelName} ({enc.dimensions}d)
                  </option>
                ))}
              </select>
            </div>
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

      {/* Section 3: Route Provider Functions */}
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
