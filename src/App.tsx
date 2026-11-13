import React, { useCallback, useEffect, useState } from 'react';
import {
  BarChart3,
  Code2,
  Cpu,
  GitBranch,
  Menu,
  Plus,
  RotateCcw,
  Terminal,
  UserCheck,
  X,
} from 'lucide-react';
import { ChatGptAuthModal } from './components/ChatGptAuthModal';
import { EvaluationView } from './components/EvaluationView';
import { PlaygroundView } from './components/PlaygroundView';
import { ProvidersView } from './components/ProvidersView';
import { RouteEditorModal } from './components/RouteEditorModal';
import { RoutesView } from './components/RoutesView';
import { SdkView } from './components/SdkView';
import { DEFAULT_ROUTER_CONFIG, SAMPLE_PLAYGROUND_PROMPTS } from './lib/seedData';
import type {
  AggregationStrategy,
  ChatGptSessionState,
  EncoderModelId,
  EvalCase,
  EvalReport,
  FitReport,
  FunctionParameter,
  RouteDecisionResult,
  RouteDefinition,
  RouterConfig,
  RouteType,
  RoutingMode,
  RoutingTraceEntry,
  TelemetrySnapshot,
} from './lib/types';

type NavTab = 'playground' | 'routes' | 'evaluation' | 'providers' | 'sdk';

const TAB_LABELS: Record<NavTab, string> = {
  playground: 'Playground',
  routes: 'Routes',
  evaluation: 'Evaluation & Fit',
  providers: 'Providers & E5',
  sdk: 'SDK & API',
};

export default function App() {
  const [activeTab, setActiveTab] = useState<NavTab>('playground');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const [routes, setRoutes] = useState<RouteDefinition[]>([]);
  const [evalCases, setEvalCases] = useState<EvalCase[]>([]);
  const [config, setConfig] = useState<RouterConfig>(DEFAULT_ROUTER_CONFIG);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [globalError, setGlobalError] = useState<string | null>(null);

  const [decision, setDecision] = useState<RouteDecisionResult | null>(null);
  const [routingLoading, setRoutingLoading] = useState(false);
  const [routingError, setRoutingError] = useState<string | null>(null);
  const [traceHistory, setTraceHistory] = useState<RoutingTraceEntry[]>([]);

  const [evalReport, setEvalReport] = useState<EvalReport | null>(null);
  const [fitReport, setFitReport] = useState<FitReport | null>(null);
  const [loadingEval, setLoadingEval] = useState(false);
  const [loadingFit, setLoadingFit] = useState(false);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingRoute, setEditingRoute] = useState<RouteDefinition | null>(null);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [chatGptSession, setChatGptSession] = useState<ChatGptSessionState | null>(null);
  const [telemetry, setTelemetry] = useState<TelemetrySnapshot | null>(null);
  const [telemetryStreamConnected, setTelemetryStreamConnected] = useState(false);
  const [probingTelemetry, setProbingTelemetry] = useState(false);

  const runRouteQuery = useCallback(async (query: string) => {
    setRoutingLoading(true);
    setRoutingError(null);
    try {
      const res = await fetch('/api/route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      const data = (await res.json()) as RouteDecisionResult & { error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Failed to route prompt');
      }
      setDecision(data);
      setTraceHistory((prev) => [
        {
          id: `trace-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          timestamp: new Date().toISOString(),
          result: data,
        },
        ...prev.slice(0, 19),
      ]);
    } catch (err) {
      setRoutingError((err as Error).message || 'Routing failed');
    } finally {
      setRoutingLoading(false);
    }
  }, []);

  const loadWorkspace = useCallback(async () => {
    setLoadingInitial(true);
    setGlobalError(null);
    try {
      const res = await fetch('/api/routes');
      if (!res.ok) throw new Error('Failed to load workspace routes');
      const data = (await res.json()) as {
        routes: RouteDefinition[];
        evalCases: EvalCase[];
        config: RouterConfig;
      };
      setRoutes(data.routes);
      setEvalCases(data.evalCases);
      setConfig(data.config);
    } catch (err) {
      setGlobalError((err as Error).message || 'Unable to connect to router server');
    } finally {
      setLoadingInitial(false);
    }
  }, []);

  const loadChatGptSession = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/openai/session');
      if (res.ok) {
        setChatGptSession((await res.json()) as ChatGptSessionState);
      }
    } catch {
      // Non-blocking if auth metadata fetch fails
    }
  }, []);

  useEffect(() => {
    void loadChatGptSession();
    void loadWorkspace().then(() => {
      void runRouteQuery(SAMPLE_PLAYGROUND_PROMPTS[0].prompt);
    });
  }, [loadChatGptSession, loadWorkspace, runRouteQuery]);

  useEffect(() => {
    const handleOAuthMessage = (event: MessageEvent) => {
      const origin = event.origin || '';
      if (
        !origin.endsWith('.run.app') &&
        !origin.includes('localhost') &&
        !origin.includes('127.0.0.1')
      ) {
        return;
      }
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS' && event.data?.provider === 'chatgpt') {
        void loadChatGptSession();
      }
    };
    window.addEventListener('message', handleOAuthMessage);
    return () => window.removeEventListener('message', handleOAuthMessage);
  }, [loadChatGptSession]);

  useEffect(() => {
    let active = true;
    const loadTelemetrySnapshot = async () => {
      try {
        const res = await fetch('/api/telemetry');
        if (res.ok && active) {
          setTelemetry((await res.json()) as TelemetrySnapshot);
        }
      } catch {
        // Non-blocking
      }
    };
    void loadTelemetrySnapshot();

    const es = new EventSource('/api/telemetry/stream');
    es.onopen = () => {
      if (active) setTelemetryStreamConnected(true);
    };
    es.onmessage = (event) => {
      if (!active) return;
      try {
        setTelemetry(JSON.parse(event.data) as TelemetrySnapshot);
        setTelemetryStreamConnected(true);
      } catch {
        // Ignore malformed frame
      }
    };
    es.onerror = () => {
      if (active) setTelemetryStreamConnected(false);
    };

    return () => {
      active = false;
      es.close();
    };
  }, []);

  const handleProbeHealth = useCallback(async () => {
    setProbingTelemetry(true);
    try {
      const res = await fetch('/api/telemetry/probe', { method: 'POST' });
      if (res.ok) {
        setTelemetry((await res.json()) as TelemetrySnapshot);
      }
    } finally {
      setProbingTelemetry(false);
    }
  }, []);

  const handleUpdateConfig = async (
    patch: Partial<RouterConfig> & { calibrateThresholds?: boolean }
  ) => {
    const nextConfig = { ...config, ...patch };
    setConfig(nextConfig);
    try {
      const res = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          config: RouterConfig;
          routes?: RouteDefinition[];
        };
        setConfig(data.config);
        if (data.routes) {
          setRoutes(data.routes);
        }
      }
    } catch {
      // Keep optimistic state if offline
    }
  };

  const handleSaveRoute = async (payload: {
    id?: string;
    name: string;
    description: string;
    utterances: string[];
    scoreThreshold: number;
    routeType: RouteType;
    targetModel: string;
    enabled: boolean;
    functionSchema?: {
      name: string;
      description: string;
      parameters: FunctionParameter[];
    };
  }) => {
    const isEdit = Boolean(payload.id);
    const url = isEdit ? `/api/routes/${payload.id}` : '/api/routes';
    const method = isEdit ? 'PUT' : 'POST';

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = (await res.json()) as { route?: RouteDefinition; error?: string };
    if (!res.ok || !data.route) {
      throw new Error(data.error || 'Failed to save route');
    }

    if (isEdit) {
      setRoutes((prev) => prev.map((r) => (r.id === data.route!.id ? data.route! : r)));
    } else {
      setRoutes((prev) => [data.route!, ...prev]);
    }
  };

  const handleToggleRoute = async (route: RouteDefinition) => {
    const res = await fetch(`/api/routes/${route.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !route.enabled }),
    });
    if (res.ok) {
      const data = (await res.json()) as { route: RouteDefinition };
      setRoutes((prev) => prev.map((r) => (r.id === route.id ? data.route : r)));
    }
  };

  const handleDeleteRoute = async (id: string) => {
    const res = await fetch(`/api/routes/${id}`, { method: 'DELETE' });
    if (res.ok) {
      setRoutes((prev) => prev.filter((r) => r.id !== id));
    }
  };

  const handleRunEvaluation = async () => {
    setLoadingEval(true);
    try {
      const res = await fetch('/api/evaluate', { method: 'POST' });
      if (res.ok) {
        const data = (await res.json()) as EvalReport;
        setEvalReport(data);
      }
    } finally {
      setLoadingEval(false);
    }
  };

  const handleRunFit = async () => {
    setLoadingFit(true);
    try {
      const res = await fetch('/api/fit', { method: 'POST' });
      if (res.ok) {
        const data = (await res.json()) as FitReport;
        setFitReport(data);
        setRoutes(data.updatedRoutes);
        // Refresh evaluation report immediately so UI reflects updated accuracy
        const evalRes = await fetch('/api/evaluate', { method: 'POST' });
        if (evalRes.ok) {
          setEvalReport((await evalRes.json()) as EvalReport);
        }
      }
    } finally {
      setLoadingFit(false);
    }
  };

  const handleAddEvalCase = async (query: string, expectedRoute: string | null) => {
    const res = await fetch('/api/eval-cases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, expectedRoute }),
    });
    if (res.ok) {
      const data = (await res.json()) as { evalCase: EvalCase };
      setEvalCases((prev) => [data.evalCase, ...prev]);
    }
  };

  const handleDeleteEvalCase = async (id: string) => {
    const res = await fetch(`/api/eval-cases/${id}`, { method: 'DELETE' });
    if (res.ok) {
      setEvalCases((prev) => prev.filter((c) => c.id !== id));
    }
  };

  const handleResetWorkspace = async () => {
    const res = await fetch('/api/reset', { method: 'POST' });
    if (res.ok) {
      const data = (await res.json()) as {
        routes: RouteDefinition[];
        evalCases: EvalCase[];
        config: RouterConfig;
      };
      setRoutes(data.routes);
      setEvalCases(data.evalCases);
      setConfig(data.config);
      setFitReport(null);
      setEvalReport(null);
      void runRouteQuery(SAMPLE_PLAYGROUND_PROMPTS[0].prompt);
    }
  };

  const navItems: Array<{ id: NavTab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
    { id: 'playground', label: 'Playground', icon: Terminal },
    { id: 'routes', label: 'Routes', icon: GitBranch },
    { id: 'evaluation', label: 'Evaluation & Fit', icon: BarChart3 },
    { id: 'providers', label: 'Providers & E5', icon: Cpu },
    { id: 'sdk', label: 'SDK & API', icon: Code2 },
  ];

  const sidebarContent = (
    <div className="flex flex-col h-full bg-white border-r border-slate-200">
      <div className="h-14 px-5 flex items-center justify-between border-b border-slate-200">
        <a
          href="#playground"
          onClick={(e) => {
            e.preventDefault();
            setActiveTab('playground');
            setMobileNavOpen(false);
          }}
          className="text-base font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
        >
          Semantic Router
        </a>
        <button
          type="button"
          onClick={() => setMobileNavOpen(false)}
          aria-label="Close navigation menu"
          className="lg:hidden p-1.5 text-slate-500 hover:text-slate-900 rounded-md"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <nav aria-label="Primary navigation" className="p-3 space-y-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                setActiveTab(item.id);
                setMobileNavOpen(false);
                if (item.id === 'evaluation' && !evalReport && !loadingEval) {
                  void handleRunEvaluation();
                }
              }}
              className={`w-full flex items-center justify-between px-3 py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap ${
                active
                  ? 'bg-blue-50 text-blue-700'
                  : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              <span className="flex items-center gap-2.5">
                <Icon className={`w-4 h-4 ${active ? 'text-blue-600' : 'text-slate-500'}`} />
                {item.label}
              </span>
              {item.id === 'routes' && (
                <span className="text-xs font-mono tabular-nums text-slate-500">
                  {routes.filter((r) => r.enabled).length}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Router Index Configuration Panel */}
      <div className="mt-auto p-4 border-t border-slate-200 space-y-3.5 bg-slate-50/70">
        <div>
          <label htmlFor="sidebar-encoder-select" className="block text-xs font-semibold text-slate-700 mb-1">
            Encoder Model
          </label>
          <select
            id="sidebar-encoder-select"
            value={config.encoderModel}
            onChange={(e) =>
              void handleUpdateConfig({
                encoderModel: e.target.value as EncoderModelId,
                calibrateThresholds: true,
              })
            }
            className="w-full px-2.5 py-1.5 text-xs font-mono bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-600"
          >
            <option value="e5-small-v2">intfloat/e5-small-v2</option>
            <option value="local-subword-bm25">subword-256d-bm25</option>
          </select>
        </div>

        <div>
          <span className="block text-xs font-semibold text-slate-700 mb-1.5">
            Index Mode
          </span>
          <div
            role="group"
            aria-label="Routing mode"
            className="grid grid-cols-3 p-0.5 bg-slate-200/70 rounded-md"
          >
            {(['hybrid', 'dense', 'sparse'] as RoutingMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => void handleUpdateConfig({ mode })}
                className={`py-1 text-xs font-medium rounded capitalize transition-colors whitespace-nowrap ${
                  config.mode === mode
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>

        {config.mode === 'hybrid' && (
          <div>
            <div className="flex items-center justify-between text-xs mb-1">
              <label htmlFor="sidebar-alpha-slider" className="font-medium text-slate-700">
                Dense Alpha
              </label>
              <span className="font-mono tabular-nums text-slate-900">
                {config.alpha.toFixed(2)}
              </span>
            </div>
            <input
              id="sidebar-alpha-slider"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={config.alpha}
              onChange={(e) => void handleUpdateConfig({ alpha: Number(e.target.value) })}
              className="w-full accent-blue-600 cursor-pointer"
            />
          </div>
        )}

        <div>
          <label htmlFor="sidebar-aggregation-select" className="block text-xs font-medium text-slate-700 mb-1">
            Aggregation
          </label>
          <select
            id="sidebar-aggregation-select"
            value={config.aggregation}
            onChange={(e) =>
              void handleUpdateConfig({
                aggregation: e.target.value as AggregationStrategy,
              })
            }
            className="w-full px-2.5 py-1.5 text-xs font-mono bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-600"
          >
            <option value="max">max</option>
            <option value="mean">mean</option>
            <option value="top_k_mean">top_k_mean</option>
          </select>
        </div>

        <button
          type="button"
          onClick={() => void handleResetWorkspace()}
          className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition-colors whitespace-nowrap"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          Restore Default Routes
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen flex bg-slate-50 text-slate-900">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:block w-60 shrink-0 sticky top-0 h-screen">
        {sidebarContent}
      </aside>

      {/* Mobile Drawer */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-40 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-950/40"
            onClick={() => setMobileNavOpen(false)}
          />
          <aside className="relative z-50 w-64 max-w-[80vw] h-full">{sidebarContent}</aside>
        </div>
      )}

      {/* Main Content Shell */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="h-14 px-4 sm:px-6 bg-white border-b border-slate-200 flex items-center justify-between gap-4 sticky top-0 z-30">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              aria-label="Open navigation menu"
              className="lg:hidden p-2 -ml-2 text-slate-600 hover:text-slate-900 rounded-md hover:bg-slate-100"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-sm truncate">
              <span className="text-slate-500">Workspace</span>
              <span aria-hidden="true" className="text-slate-300">
                /
              </span>
              <span className="font-semibold text-slate-900">{TAB_LABELS[activeTab]}</span>
            </div>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              data-oai-siwc-button=""
              data-oai-siwc-button-client={
                chatGptSession?.configuredClientId ?? 'dynamic_agent_client'
              }
              onClick={() => setAuthModalOpen(true)}
              className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                chatGptSession?.activeProfile?.connected
                  ? 'text-emerald-800 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100'
                  : 'text-white bg-slate-950 hover:bg-slate-800'
              }`}
            >
              <UserCheck className="w-3.5 h-3.5" />
              {chatGptSession?.activeProfile?.connected
                ? chatGptSession.activeProfile.email ?? 'ChatGPT Connected'
                : 'Continue with ChatGPT'}
            </button>

            <button
              type="button"
              onClick={() => {
                setEditingRoute(null);
                setEditorOpen(true);
              }}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              New Route
            </button>
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-[1480px] w-full mx-auto">
          {globalError && (
            <div
              role="alert"
              className="mb-6 px-4 py-3 text-sm text-rose-800 bg-rose-50 border border-rose-200 rounded-md"
            >
              {globalError}
            </div>
          )}

          {loadingInitial ? (
            <div className="space-y-4">
              <div className="h-44 bg-white border border-slate-200 rounded-lg animate-pulse" />
              <div className="h-64 bg-white border border-slate-200 rounded-lg animate-pulse" />
            </div>
          ) : (
            <>
              {activeTab === 'playground' && (
                <PlaygroundView
                  config={config}
                  decision={decision}
                  loading={routingLoading}
                  error={routingError}
                  traceHistory={traceHistory}
                  telemetry={telemetry}
                  telemetryStreamConnected={telemetryStreamConnected}
                  probingTelemetry={probingTelemetry}
                  onProbeHealth={handleProbeHealth}
                  onRunRoute={runRouteQuery}
                  onNavigateToRoutes={() => setActiveTab('routes')}
                  onOpenChatGptAuth={() => setAuthModalOpen(true)}
                />
              )}

              {activeTab === 'routes' && (
                <RoutesView
                  routes={routes}
                  onNewRoute={() => {
                    setEditingRoute(null);
                    setEditorOpen(true);
                  }}
                  onEditRoute={(route) => {
                    setEditingRoute(route);
                    setEditorOpen(true);
                  }}
                  onToggleRoute={handleToggleRoute}
                  onDeleteRoute={handleDeleteRoute}
                />
              )}

              {activeTab === 'evaluation' && (
                <EvaluationView
                  routes={routes}
                  evalCases={evalCases}
                  evalReport={evalReport}
                  fitReport={fitReport}
                  loadingEval={loadingEval}
                  loadingFit={loadingFit}
                  onRunEvaluation={handleRunEvaluation}
                  onRunFit={handleRunFit}
                  onAddEvalCase={handleAddEvalCase}
                  onDeleteEvalCase={handleDeleteEvalCase}
                />
              )}

              {activeTab === 'providers' && (
                <ProvidersView
                  config={config}
                  onSelectEncoder={(encoderModel) =>
                    handleUpdateConfig({ encoderModel, calibrateThresholds: true })
                  }
                />
              )}

              {activeTab === 'sdk' && <SdkView routes={routes} config={config} />}
            </>
          )}
        </main>
      </div>

      <RouteEditorModal
        isOpen={editorOpen}
        initialRoute={editingRoute}
        defaultThreshold={config.defaultThreshold}
        onClose={() => setEditorOpen(false)}
        onSave={handleSaveRoute}
      />

      <ChatGptAuthModal
        isOpen={authModalOpen}
        session={chatGptSession}
        onClose={() => setAuthModalOpen(false)}
        onSessionChange={loadChatGptSession}
      />
    </div>
  );
}
