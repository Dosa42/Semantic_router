import React, { useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Copy,
  Database,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Terminal,
  Trash2,
} from 'lucide-react';
import { SAMPLE_PLAYGROUND_PROMPTS } from '../lib/seedData';
import type {
  ArchiveFilterProfile,
  DiscoveredZipArchive,
  EncoderModelId,
  IngestedPackageManifest,
  LocalModelInventoryItem,
  RagConnector,
  RagParserMode,
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
  ragConnectors: RagConnector[];
  ragChunksCount: number;
  ingestedPackages: IngestedPackageManifest[];
  availablePackageArchives: DiscoveredZipArchive[];
  localModels: LocalModelInventoryItem[];
  onProbeHealth: () => Promise<void>;
  onRunRoute: (query: string, useRag?: boolean) => Promise<void>;
  onCreateRagConnector: (payload: {
    name: string;
    url: string;
    method: 'GET' | 'POST';
    parserMode: RagParserMode;
    jsonPath?: string;
    requestBody?: string;
  }) => Promise<void>;
  onSyncRagConnector: (id: string) => Promise<void>;
  onToggleRagConnector: (connector: RagConnector) => Promise<void>;
  onDeleteRagConnector: (id: string) => Promise<void>;
  onIngestPackageArchive: (
    archivePath?: string,
    filterProfile?: ArchiveFilterProfile,
    encoderModel?: EncoderModelId
  ) => Promise<void>;
  onReloadPackagesFromDisk: () => Promise<void>;
  onNavigateToRoutes: () => void;
  onNavigateToInstructions: () => void;
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
  ragConnectors,
  ragChunksCount,
  ingestedPackages,
  availablePackageArchives,
  localModels,
  onProbeHealth,
  onRunRoute,
  onCreateRagConnector,
  onSyncRagConnector,
  onToggleRagConnector,
  onDeleteRagConnector,
  onIngestPackageArchive,
  onReloadPackagesFromDisk,
  onNavigateToRoutes,
  onNavigateToInstructions,
  onOpenChatGptAuth,
}: PlaygroundViewProps) {
  const [query, setQuery] = useState(SAMPLE_PLAYGROUND_PROMPTS[0].prompt);
  const [useRag, setUseRag] = useState(config.ragEnabledByDefault);
  const [expandedRouteId, setExpandedRouteId] = useState<string | null>(null);

  const [connectorsOpen, setConnectorsOpen] = useState(false);
  const [connName, setConnName] = useState('');
  const [connUrl, setConnUrl] = useState('');
  const [connMethod, setConnMethod] = useState<'GET' | 'POST'>('GET');
  const [connParser, setConnParser] = useState<RagParserMode>('auto');
  const [connJsonPath, setConnJsonPath] = useState('');
  const [connRequestBody, setConnRequestBody] = useState('');
  const [connError, setConnError] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [ingestingArchive, setIngestingArchive] = useState<string | null>(null);
  const [reloadingDisk, setReloadingDisk] = useState(false);
  const [creatingConn, setCreatingConn] = useState(false);

  const [filterProfile, setFilterProfile] = useState<ArchiveFilterProfile>('full-scripts');
  const [runnerSource, setRunnerSource] = useState<string>(
    availablePackageArchives[0]?.relativePath ||
      'public/assets/aistudio/rea-rea-agents-6.8.0_a6250980.zip'
  );
  const [runnerModel, setRunnerModel] = useState<EncoderModelId>('bge-m3');
  const [runnerChunkSize, setRunnerChunkSize] = useState<string>('1800');
  const [copiedCmdId, setCopiedCmdId] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    await onRunRoute(query, useRag);
  };

  const handleSelectSample = async (samplePrompt: string) => {
    setQuery(samplePrompt);
    await onRunRoute(samplePrompt, useRag);
  };

  const applyTrinityPreset = (endpoint: 'query' | 'context') => {
    setConnError(null);
    if (endpoint === 'query') {
      setConnName('TRINITY :7700 /query');
      setConnUrl('http://127.0.0.1:7700/query');
      setConnMethod('POST');
      setConnParser('json');
      setConnJsonPath('results');
      setConnRequestBody(
        JSON.stringify(
          {
            query_text: 'Semantic Router architecture and UAGL tiers',
            k: 5,
            min_kappa: 0.0,
          },
          null,
          2
        )
      );
    } else {
      setConnName('TRINITY :7700 /context');
      setConnUrl('http://127.0.0.1:7700/context');
      setConnMethod('POST');
      setConnParser('json');
      setConnJsonPath('context');
      setConnRequestBody(
        JSON.stringify(
          {
            query_text: 'Semantic Router architecture and UAGL tiers',
            k: 5,
          },
          null,
          2
        )
      );
    }
  };

  const handleAddConnector = async (e: React.FormEvent) => {
    e.preventDefault();
    setConnError(null);
    setCreatingConn(true);
    try {
      await onCreateRagConnector({
        name: connName,
        url: connUrl,
        method: connMethod,
        parserMode: connParser,
        jsonPath: connJsonPath.trim() || undefined,
        requestBody: connMethod === 'POST' && connRequestBody.trim() ? connRequestBody : undefined,
      });
      setConnName('');
      setConnUrl('');
      setConnJsonPath('');
      setConnRequestBody('');
    } catch (err) {
      setConnError((err as Error).message || 'Failed to add RAG connector');
    } finally {
      setCreatingConn(false);
    }
  };

  const handleSync = async (id: string) => {
    setSyncingId(id);
    setConnError(null);
    try {
      await onSyncRagConnector(id);
    } catch (err) {
      setConnError((err as Error).message || 'Sync failed');
    } finally {
      setSyncingId(null);
    }
  };

  const handleIngestArchive = async (archivePath?: string) => {
    const key = archivePath ?? 'default';
    setIngestingArchive(key);
    setConnError(null);
    try {
      await onIngestPackageArchive(archivePath, filterProfile);
    } catch (err) {
      setConnError((err as Error).message || 'Package vectorization failed');
    } finally {
      setIngestingArchive(null);
    }
  };

  const handleReloadDisk = async () => {
    setReloadingDisk(true);
    setConnError(null);
    try {
      await onReloadPackagesFromDisk();
    } catch (err) {
      setConnError((err as Error).message || 'Reload from disk failed');
    } finally {
      setReloadingDisk(false);
    }
  };

  const handleCopyCommand = (id: string, cmd: string) => {
    void navigator.clipboard?.writeText(cmd);
    setCopiedCmdId(id);
    window.setTimeout(() => setCopiedCmdId((prev) => (prev === id ? null : prev)), 1500);
  };

  const effectiveSource =
    runnerSource ||
    availablePackageArchives[0]?.relativePath ||
    'public/assets/aistudio/rea-rea-agents-6.8.0_a6250980.zip';
  const stage1WorkflowCmd =
    'gh workflow run fetch-embedding-models.yml -f models="Xenova/bge-m3,Xenova/e5-base-v2,Xenova/e5-large-v2" -f dtype="q8"';
  const stage2WorkflowCmd = `gh workflow run vectorize-sources.yml -f source_path="${effectiveSource}" -f model_id="${runnerModel}" -f filter_profile="${filterProfile}" -f chunk_size="${runnerChunkSize}" -f auto_commit=true`;
  const localCliCmd = `npm run vectorize -- --source ${effectiveSource} --model ${runnerModel} --profile ${filterProfile} --chunk-size ${runnerChunkSize}`;
  const clonedLfsCount = localModels.filter(
    (m) => m.id !== 'local-subword-bm25' && m.installedInLfs
  ).length;

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
              <h1 className="text-xl font-semibold text-slate-900">
                Semantic Routing &amp; RAG Playground
              </h1>
              <p className="text-sm text-slate-600 mt-1">
                Test incoming prompts across{' '}
                <span className="font-mono text-slate-800">{config.mode}</span> similarity,{' '}
                <span className="font-mono text-slate-800">{config.aggregation}</span> aggregation,
                and external RAG connectors.
              </p>
            </div>
            <div className="flex items-center gap-4 shrink-0">
              <button
                type="button"
                onClick={onNavigateToInstructions}
                className="text-sm font-medium text-slate-600 hover:text-slate-900 hover:underline whitespace-nowrap shrink-0"
              >
                Instructions
              </button>
              <button
                type="button"
                onClick={onNavigateToRoutes}
                className="text-sm font-medium text-blue-600 hover:text-blue-700 hover:underline whitespace-nowrap shrink-0"
              >
                Manage Routes
              </button>
            </div>
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
                    void onRunRoute(query, useRag);
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

              <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-100">
                <div className="flex items-center gap-4">
                  <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={useRag}
                      onChange={(e) => setUseRag(e.target.checked)}
                      className="rounded border-slate-300 text-blue-600"
                    />
                    RAG Connector Augmentation ({ragChunksCount} chunks)
                  </label>
                  <button
                    type="button"
                    onClick={() => setConnectorsOpen((v) => !v)}
                    className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:underline whitespace-nowrap shrink-0"
                  >
                    <Database className="w-3.5 h-3.5" />
                    {connectorsOpen
                      ? 'Hide Connectors'
                      : `Webhooks & URLs (${ragConnectors.length})`}
                  </button>
                </div>

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

          {/* External Webhook / URL RAG Connector Drawer */}
          {connectorsOpen && (
            <div className="mt-5 pt-5 border-t border-slate-200 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold text-slate-900">
                    External Webhook &amp; URL RAG Connectors
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Fetch HTTP/HTTPS JSON feeds, webhooks, or TRINITY :7700 endpoints and index via
                    EmbeddingsBridge for unified HTTP + MCP retrieval.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => applyTrinityPreset('query')}
                    className="px-2.5 py-1 text-[11px] font-mono font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded whitespace-nowrap shrink-0"
                  >
                    Preset: TRINITY :7700 /query
                  </button>
                  <button
                    type="button"
                    onClick={() => applyTrinityPreset('context')}
                    className="px-2.5 py-1 text-[11px] font-mono font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded whitespace-nowrap shrink-0"
                  >
                    Preset: TRINITY :7700 /context
                  </button>
                </div>
              </div>

              {connError && (
                <div
                  role="alert"
                  className="px-3 py-2 text-xs text-rose-800 bg-rose-50 border border-rose-200 rounded"
                >
                  {connError}
                </div>
              )}

              <div className="border border-slate-200 rounded-md overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                      <th className="py-2 px-3 font-medium">Connector</th>
                      <th className="py-2 px-3 font-medium">Method / Parser</th>
                      <th className="py-2 px-3 text-right font-medium">Chunks</th>
                      <th className="py-2 px-3 text-right font-medium">Status</th>
                      <th className="py-2 px-3 text-right font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {ragConnectors.map((conn) => (
                      <tr key={conn.id} className="hover:bg-slate-50">
                        <td className="py-2 px-3 max-w-xs">
                          <div className="font-semibold text-slate-900 truncate">{conn.name}</div>
                          <div className="font-mono text-[11px] text-slate-500 truncate">
                            {conn.url}
                          </div>
                        </td>
                        <td className="py-2 px-3 font-mono text-[11px] text-slate-700 whitespace-nowrap">
                          {conn.method} · {conn.parserMode}
                          {conn.jsonPath ? ` (${conn.jsonPath})` : ''}
                        </td>
                        <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-800">
                          {conn.chunkCount}
                        </td>
                        <td className="py-2 px-3 text-right whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => void onToggleRagConnector(conn)}
                            className={`font-mono text-[11px] font-medium hover:underline ${
                              !conn.enabled
                                ? 'text-slate-400'
                                : conn.lastStatus === 'error'
                                  ? 'text-rose-700'
                                  : conn.lastStatus === 'ok'
                                    ? 'text-emerald-700'
                                    : 'text-amber-700'
                            }`}
                          >
                            {!conn.enabled
                              ? 'DISABLED'
                              : conn.lastStatus === 'ok'
                                ? `SYNCED (${conn.lastLatencyMs?.toFixed(0) ?? 0}ms)`
                                : conn.lastStatus === 'error'
                                  ? 'ERROR'
                                  : 'IDLE'}
                          </button>
                        </td>
                        <td className="py-2 px-3 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => void handleSync(conn.id)}
                              disabled={syncingId === conn.id}
                              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded whitespace-nowrap"
                            >
                              <RefreshCw
                                className={`w-3 h-3 ${syncingId === conn.id ? 'animate-spin' : ''}`}
                              />
                              {syncingId === conn.id ? 'Syncing' : 'Sync'}
                            </button>
                            <button
                              type="button"
                              onClick={() => void onDeleteRagConnector(conn.id)}
                              aria-label={`Delete connector ${conn.name}`}
                              className="p-1 text-slate-400 hover:text-rose-600 rounded"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {(ingestedPackages.length > 0 || availablePackageArchives.length > 0) && (
                <div
                  data-testid="ingested-packages-panel"
                  className="bg-slate-50 border border-slate-200 rounded-md p-4 space-y-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="text-xs font-semibold text-slate-900">
                        Vectorized ZIP Package Stores ({ingestedPackages.length} persisted)
                      </h3>
                      <p className="text-[11px] text-slate-500 mt-0.5">
                        Float32 embeddings persisted under <code className="font-mono">data/packages/</code> and served on HTTP :3000 + MCP stdio.
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <div
                        role="group"
                        aria-label="Archive filter profile"
                        className="inline-flex p-0.5 bg-slate-200/80 rounded border border-slate-300 text-[11px]"
                      >
                        <button
                          type="button"
                          onClick={() => setFilterProfile('full-scripts')}
                          className={`px-2 py-1 rounded font-medium whitespace-nowrap ${
                            filterProfile === 'full-scripts'
                              ? 'bg-white text-slate-900 shadow-xs'
                              : 'text-slate-600 hover:text-slate-900'
                          }`}
                        >
                          Include scripts/
                        </button>
                        <button
                          type="button"
                          onClick={() => setFilterProfile('core-docs')}
                          className={`px-2 py-1 rounded font-medium whitespace-nowrap ${
                            filterProfile === 'core-docs'
                              ? 'bg-white text-slate-900 shadow-xs'
                              : 'text-slate-600 hover:text-slate-900'
                          }`}
                        >
                          Docs &amp; Core Only
                        </button>
                      </div>
                      <button
                        type="button"
                        disabled={reloadingDisk}
                        onClick={() => void handleReloadDisk()}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-slate-700 bg-white hover:bg-slate-100 border border-slate-300 rounded disabled:opacity-50 whitespace-nowrap shrink-0"
                      >
                        <RefreshCw className={`w-3 h-3 ${reloadingDisk ? 'animate-spin' : ''}`} />
                        {reloadingDisk ? 'Reloading...' : 'Reload Disk Stores'}
                      </button>
                    </div>
                  </div>

                  {ingestedPackages.length > 0 && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                      {ingestedPackages.map((pkg) => {
                        const categorySummary = Object.entries(pkg.categories ?? {})
                          .sort((a, b) => b[1] - a[1])
                          .map(([cat, count]) => `${cat}: ${count}`)
                          .join(' · ');
                        return (
                          <div
                            key={pkg.id}
                            className="p-3 bg-white border border-slate-200 rounded text-xs space-y-1.5"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-mono font-semibold text-slate-900">
                                {pkg.packageName}@{pkg.version}
                              </span>
                              <span className="font-mono tabular-nums text-[11px] text-emerald-700 font-medium">
                                {pkg.chunkCount} chunks · {pkg.dimensions}d
                              </span>
                            </div>
                            <div className="text-[11px] text-slate-600 font-mono truncate">
                              {pkg.encoderModel} · {pkg.fileCount} files · {pkg.filterProfile ?? 'full-scripts'}
                            </div>
                            {categorySummary && (
                              <div className="text-[11px] text-slate-600 font-mono tabular-nums leading-relaxed">
                                {categorySummary}
                              </div>
                            )}
                            <div className="text-[11px] text-slate-500 font-mono truncate">
                              {pkg.storageFiles.vectors}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {availablePackageArchives.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[11px] font-medium text-slate-600">
                        Archives in assets:
                      </span>
                      {availablePackageArchives.map((arch) => {
                        const already = ingestedPackages.some(
                          (p) => p.sourceArchive === arch.relativePath
                        );
                        const busy = ingestingArchive === arch.relativePath;
                        return (
                          <button
                            key={arch.relativePath}
                            type="button"
                            disabled={busy}
                            onClick={() => void handleIngestArchive(arch.relativePath)}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-mono font-medium text-slate-700 bg-white hover:bg-slate-100 border border-slate-300 rounded disabled:opacity-50 whitespace-nowrap shrink-0"
                          >
                            <RefreshCw className={`w-3 h-3 ${busy ? 'animate-spin' : ''}`} />
                            {already ? 'Re-Vectorize' : 'Ingest & Vectorize'} {arch.fileName}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {/* External Chunking & GitHub Workflow Runner */}
                  <div
                    data-testid="external-runner-panel"
                    className="pt-3 border-t border-slate-200 space-y-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h4 className="text-xs font-semibold text-slate-900 flex items-center gap-1.5">
                          <Terminal className="w-3.5 h-3.5 text-slate-600" />
                          External Chunking &amp; GitHub Workflow Runner
                        </h4>
                        <p className="text-[11px] text-slate-500 mt-0.5">
                          Stage 1 clones ONNX candidates into Git LFS (<code className="font-mono">models/</code>); Stage 2 chunks, vectorizes offline, and auto-commits <code className="font-mono">data/packages/</code>.
                        </p>
                      </div>
                      <span className="text-[11px] font-mono tabular-nums text-slate-600">
                        {clonedLfsCount} / 4 ONNX models in Git LFS
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <div>
                        <label
                          htmlFor="runner-source-input"
                          className="block text-[11px] font-medium text-slate-700 mb-1"
                        >
                          Source Archive / Dir
                        </label>
                        <input
                          id="runner-source-input"
                          type="text"
                          value={runnerSource}
                          onChange={(e) => setRunnerSource(e.target.value)}
                          className="w-full px-2 py-1 text-[11px] font-mono bg-white border border-slate-300 rounded"
                        />
                      </div>
                      <div>
                        <label
                          htmlFor="runner-model-select"
                          className="block text-[11px] font-medium text-slate-700 mb-1"
                        >
                          LFS Model Candidate
                        </label>
                        <select
                          id="runner-model-select"
                          value={runnerModel}
                          onChange={(e) => setRunnerModel(e.target.value as EncoderModelId)}
                          className="w-full px-2 py-1 text-[11px] font-mono bg-white border border-slate-300 rounded"
                        >
                          <option value="bge-m3">Xenova/bge-m3 (1024d CLS)</option>
                          <option value="e5-large-v2">Xenova/e5-large-v2 (1024d Mean)</option>
                          <option value="e5-base-v2">Xenova/e5-base-v2 (768d Mean)</option>
                          <option value="e5-small-v2">Xenova/e5-small-v2 (384d Mean)</option>
                        </select>
                      </div>
                      <div>
                        <label
                          htmlFor="runner-chunk-size"
                          className="block text-[11px] font-medium text-slate-700 mb-1"
                        >
                          Chunk Size (chars)
                        </label>
                        <select
                          id="runner-chunk-size"
                          value={runnerChunkSize}
                          onChange={(e) => setRunnerChunkSize(e.target.value)}
                          className="w-full px-2 py-1 text-[11px] font-mono bg-white border border-slate-300 rounded"
                        >
                          <option value="1200">1200 chars</option>
                          <option value="1800">1800 chars (default)</option>
                          <option value="2400">2400 chars</option>
                        </select>
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      {[
                        {
                          id: 'stage1',
                          label: 'Stage 1 · One-time Git LFS Model Clone',
                          cmd: stage1WorkflowCmd,
                        },
                        {
                          id: 'stage2',
                          label: 'Stage 2 · GitHub Action Vectorize & Auto-Commit',
                          cmd: stage2WorkflowCmd,
                        },
                        {
                          id: 'cli',
                          label: 'Local CLI · Run Standalone Runner',
                          cmd: localCliCmd,
                        },
                      ].map((item) => (
                        <div
                          key={item.id}
                          className="flex items-center justify-between gap-2 px-2.5 py-1.5 bg-white border border-slate-200 rounded text-[11px]"
                        >
                          <div className="min-w-0 flex-1">
                            <span className="font-medium text-slate-600 mr-2">{item.label}:</span>
                            <code className="font-mono text-slate-800 break-all">{item.cmd}</code>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleCopyCommand(item.id, item.cmd)}
                            aria-label={`Copy ${item.label} command`}
                            className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 rounded shrink-0 whitespace-nowrap"
                          >
                            {copiedCmdId === item.id ? (
                              <>
                                <Check className="w-3 h-3 text-emerald-700" />
                                Copied
                              </>
                            ) : (
                              <>
                                <Copy className="w-3 h-3" />
                                Copy
                              </>
                            )}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              <form
                onSubmit={handleAddConnector}
                className="grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-end bg-slate-50 border border-slate-200 rounded-md p-3"
              >
                <div className="sm:col-span-3">
                  <label htmlFor="rag-conn-name" className="block text-[11px] font-medium text-slate-700 mb-1">
                    Name
                  </label>
                  <input
                    id="rag-conn-name"
                    type="text"
                    required
                    value={connName}
                    onChange={(e) => setConnName(e.target.value)}
                    placeholder="Docs Webhook"
                    className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-300 rounded"
                  />
                </div>
                <div className="sm:col-span-4">
                  <label htmlFor="rag-conn-url" className="block text-[11px] font-medium text-slate-700 mb-1">
                    Webhook / URL (http/https)
                  </label>
                  <input
                    id="rag-conn-url"
                    type="url"
                    required
                    value={connUrl}
                    onChange={(e) => setConnUrl(e.target.value)}
                    placeholder="https://api.example.com/rag.json"
                    className="w-full px-2.5 py-1.5 text-xs font-mono bg-white border border-slate-300 rounded"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label htmlFor="rag-conn-parser" className="block text-[11px] font-medium text-slate-700 mb-1">
                    Method / Format
                  </label>
                  <div className="flex gap-1">
                    <select
                      aria-label="Connector HTTP method"
                      value={connMethod}
                      onChange={(e) => setConnMethod(e.target.value as 'GET' | 'POST')}
                      className="w-1/2 px-1.5 py-1.5 text-xs font-mono bg-white border border-slate-300 rounded"
                    >
                      <option value="GET">GET</option>
                      <option value="POST">POST</option>
                    </select>
                    <select
                      id="rag-conn-parser"
                      value={connParser}
                      onChange={(e) => setConnParser(e.target.value as RagParserMode)}
                      className="w-1/2 px-1.5 py-1.5 text-xs font-mono bg-white border border-slate-300 rounded"
                    >
                      <option value="auto">auto</option>
                      <option value="json">json</option>
                      <option value="text">text</option>
                      <option value="html">html</option>
                    </select>
                  </div>
                </div>
                <div className="sm:col-span-2">
                  <label htmlFor="rag-conn-jpath" className="block text-[11px] font-medium text-slate-700 mb-1">
                    JSON Path (opt)
                  </label>
                  <input
                    id="rag-conn-jpath"
                    type="text"
                    value={connJsonPath}
                    onChange={(e) => setConnJsonPath(e.target.value)}
                    placeholder="documents"
                    className="w-full px-2.5 py-1.5 text-xs font-mono bg-white border border-slate-300 rounded"
                  />
                </div>
                <div className="sm:col-span-1">
                  <button
                    type="submit"
                    disabled={creatingConn}
                    className="w-full inline-flex items-center justify-center gap-1 px-2.5 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded whitespace-nowrap"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add
                  </button>
                </div>
                {connMethod === 'POST' && (
                  <div className="sm:col-span-12 pt-1">
                    <label htmlFor="rag-conn-body" className="block text-[11px] font-medium text-slate-700 mb-1">
                      POST JSON Request Body (e.g. TRINITY <code className="font-mono">/query</code> or{' '}
                      <code className="font-mono">/context</code> payload)
                    </label>
                    <textarea
                      id="rag-conn-body"
                      rows={2}
                      value={connRequestBody}
                      onChange={(e) => setConnRequestBody(e.target.value)}
                      placeholder='{"query_text":"Semantic Router architecture","k":5}'
                      className="w-full px-2.5 py-1.5 text-xs font-mono bg-white border border-slate-300 rounded"
                    />
                  </div>
                )}
              </form>
            </div>
          )}

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
              <div className="space-y-1.5 min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-xs font-medium">
                  {decision.matchedRoute ? (
                    <span className="inline-flex items-center gap-1.5 text-emerald-700 whitespace-nowrap shrink-0">
                      <CheckCircle2 className="w-4 h-4 shrink-0" />
                      Route Matched
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-amber-700 whitespace-nowrap shrink-0">
                      <AlertTriangle className="w-4 h-4 shrink-0" />
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

              <div className="grid grid-cols-3 gap-5 pt-3 lg:pt-0 border-t lg:border-t-0 border-slate-100 shrink-0">
                <div>
                  <div className="text-xs text-slate-500 whitespace-nowrap">Top Score</div>
                  <div className="text-lg font-mono tabular-nums font-semibold text-slate-900 mt-0.5 whitespace-nowrap">
                    {decision.topScore.toFixed(4)}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500 whitespace-nowrap">Threshold</div>
                  <div className="text-lg font-mono tabular-nums font-semibold text-slate-900 mt-0.5 whitespace-nowrap">
                    {decision.thresholdUsed !== null ? decision.thresholdUsed.toFixed(2) : '—'}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500 whitespace-nowrap">Latency</div>
                  <div className="text-lg font-mono tabular-nums font-semibold text-slate-900 mt-0.5 whitespace-nowrap">
                    {decision.latencyMs.toFixed(2)} ms
                  </div>
                </div>
              </div>
            </div>

            {/* Per-Encoder Ensemble Breakdown */}
            {decision.allScores.some((s) => s.perEncoderScores) && (
              <div
                data-testid="ensemble-breakdown-panel"
                className="p-6 bg-slate-50/40 space-y-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm font-semibold text-slate-900">
                    Per-Encoder Ensemble Breakdown
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-xs font-mono text-slate-600">
                    <span>Fusion: {decision.ensembleFusionMode ?? 'weighted_sum'}</span>
                    {decision.progressAutoAdvanceRoute && (
                      <span className="text-emerald-700 font-semibold">
                        EM-3 Milestone Crossed · Next Hint → {decision.progressAutoAdvanceRoute}
                      </span>
                    )}
                  </div>
                </div>

                <div className="overflow-x-auto border border-slate-200 rounded-md bg-white">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 text-[11px] font-medium text-slate-600">
                        <th className="py-2 px-3">Route</th>
                        <th className="py-2 px-3 text-right">EM-1 Intent</th>
                        <th className="py-2 px-3 text-right">EM-2 Domain</th>
                        <th className="py-2 px-3 text-right">EM-3 State</th>
                        <th className="py-2 px-3 text-right">Fused Score</th>
                        <th className="py-2 px-3 text-right">Threshold</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 text-xs font-mono tabular-nums">
                      {decision.allScores.slice(0, 4).map((row) => {
                        const isWinner = decision.matchedRouteId === row.routeId;
                        return (
                          <tr key={row.routeId} className={isWinner ? 'bg-blue-50/40' : ''}>
                            <td className="py-2 px-3 font-semibold text-slate-900">
                              {row.routeName}
                            </td>
                            <td className="py-2 px-3 text-right text-slate-700">
                              {row.perEncoderScores?.intent !== undefined
                                ? row.perEncoderScores.intent.toFixed(4)
                                : '—'}
                            </td>
                            <td className="py-2 px-3 text-right text-slate-700">
                              {row.perEncoderScores?.domain !== undefined
                                ? row.perEncoderScores.domain.toFixed(4)
                                : '—'}
                            </td>
                            <td className="py-2 px-3 text-right text-slate-700">
                              {row.perEncoderScores?.state !== undefined
                                ? row.perEncoderScores.state.toFixed(4)
                                : '—'}
                            </td>
                            <td className="py-2 px-3 text-right font-bold text-slate-900">
                              {(row.ensembleFusedScore ?? row.score).toFixed(4)}
                            </td>
                            <td
                              className={`py-2 px-3 text-right ${
                                row.passed ? 'text-emerald-700 font-semibold' : 'text-slate-500'
                              }`}
                            >
                              {row.threshold.toFixed(2)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Retrieved RAG Chunks */}
            {decision.ragMatches && decision.ragMatches.length > 0 && (
              <div className="p-6 bg-slate-50/60 space-y-2.5">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-900">
                    RAG Connector Context Retrieved ({decision.ragMatches.length} chunks)
                  </h3>
                  <span className="text-xs font-mono text-slate-500">
                    Injected into ChatGPT System Instructions
                  </span>
                </div>
                <div className="space-y-2">
                  {decision.ragMatches.map((m, idx) => (
                    <div
                      key={m.chunkId}
                      className="p-3 bg-white border border-slate-200 rounded-md text-xs space-y-1"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 text-slate-600">
                        <span className="font-semibold text-slate-900 truncate">
                          [{idx + 1}] {m.connectorName}
                          {m.filePath ? (
                            <span className="ml-2 font-mono font-normal text-[11px] text-blue-700">
                              {m.filePath}
                            </span>
                          ) : null}
                        </span>
                        <span className="font-mono tabular-nums text-emerald-700 shrink-0">
                          Score {m.score.toFixed(3)} (D {m.denseScore.toFixed(2)} / S{' '}
                          {m.sparseScore.toFixed(2)})
                        </span>
                      </div>
                      <p className="text-slate-700 leading-relaxed whitespace-pre-wrap break-words">
                        {m.text}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}

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
              <div className="p-6 bg-slate-50/40 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-slate-900">
                    Provider Function Execution
                  </h3>
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-mono tabular-nums text-slate-600">
                      {decision.providerExecution.handlerName} ·{' '}
                      {decision.providerExecution.providerKind} ·{' '}
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

                {decision.appliedInstructions && (
                  <div
                    className={`grid grid-cols-1 gap-3 text-[11px] ${
                      decision.appliedInstructions.chatgptSystemPrompt ? 'md:grid-cols-2' : ''
                    }`}
                  >
                    <div className="p-2.5 bg-white border border-slate-200 rounded">
                      <div className="font-semibold text-slate-700 mb-1">
                        Embedding LM Formatted Query
                      </div>
                      <div className="font-mono text-slate-600 break-words">
                        {decision.appliedInstructions.embeddingQueryPreview}
                      </div>
                    </div>
                    {decision.appliedInstructions.chatgptSystemPrompt && (
                      <div className="p-2.5 bg-white border border-slate-200 rounded">
                        <div className="font-semibold text-slate-700 mb-1">
                          Resolved ChatGPT System Instructions
                        </div>
                        <div className="font-mono text-slate-600 whitespace-pre-wrap max-h-24 overflow-y-auto">
                          {decision.appliedInstructions.chatgptSystemPrompt}
                        </div>
                      </div>
                    )}
                  </div>
                )}
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
                      <th className="py-2.5 px-2.5">Route</th>
                      <th className="py-2.5 px-2.5 text-right">Score</th>
                      <th className="py-2.5 px-2.5 text-right">Threshold</th>
                      <th className="py-2.5 px-2.5 text-right">Margin</th>
                      <th className="py-2.5 px-2.5 w-36">Threshold Bar</th>
                      <th className="py-2.5 px-2.5">Top Utterance</th>
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
                            <td className="py-2.5 px-2.5">
                              <button
                                type="button"
                                onClick={() =>
                                  setExpandedRouteId(isExpanded ? null : row.routeId)
                                }
                                aria-expanded={isExpanded}
                                className="inline-flex items-center gap-1.5 font-mono text-xs font-semibold text-slate-900 hover:text-blue-600 whitespace-nowrap"
                              >
                                {isExpanded ? (
                                  <ChevronUp className="w-3.5 h-3.5 text-slate-400" />
                                ) : (
                                  <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                                )}
                                {row.routeName}
                              </button>
                              <div className="text-xs text-slate-500 pl-5 truncate max-w-[175px]">
                                {row.routeType === 'dynamic' ? 'Dynamic' : 'Static'} ·{' '}
                                {row.targetModel}
                              </div>
                            </td>

                            <td className="py-2.5 px-2.5 text-right font-mono tabular-nums text-xs font-semibold text-slate-900 whitespace-nowrap">
                              {row.score.toFixed(4)}
                            </td>

                            <td className="py-2.5 px-2.5 text-right font-mono tabular-nums text-xs text-slate-600 whitespace-nowrap">
                              {row.threshold.toFixed(2)}
                            </td>

                            <td
                              className={`py-2.5 px-2.5 text-right font-mono tabular-nums text-xs font-medium whitespace-nowrap ${
                                row.margin >= 0 ? 'text-emerald-700' : 'text-slate-500'
                              }`}
                            >
                              {row.margin >= 0 ? `+${row.margin.toFixed(3)}` : row.margin.toFixed(3)}
                            </td>

                            <td className="py-2.5 px-2.5">
                              <div
                                className="relative h-2.5 w-32 bg-slate-100 rounded-xs overflow-visible border border-slate-200"
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

                            <td className="py-2.5 px-2.5 text-xs text-slate-600 max-w-[180px] truncate">
                              {row.topUtterance}
                            </td>
                          </tr>

                          {isExpanded && (
                            <tr className="bg-slate-50">
                              <td colSpan={6} className="px-6 py-3">
                                <div className="text-xs font-medium text-slate-700 mb-2">
                                  Utterance-level scores for{' '}
                                  <span className="font-mono">{row.routeName}</span> (Dense:{' '}
                                  <span className="font-mono tabular-nums">
                                    {row.denseScore.toFixed(3)}
                                  </span>{' '}
                                  · Sparse:{' '}
                                  <span className="font-mono tabular-nums">
                                    {row.sparseScore.toFixed(3)}
                                  </span>
                                  )
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
                    <div className="text-slate-900 font-medium truncate">
                      {entry.result.query}
                    </div>
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
