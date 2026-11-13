import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  Cpu,
  Flame,
  Globe,
  Play,
  RotateCcw,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Wrench,
  XCircle,
} from 'lucide-react';
import { RED_TEAM_STRATEGIES } from '../lib/redTeamEngine';
import type {
  RedTeamCampaignOptions,
  RedTeamCampaignReport,
  RedTeamProbeResult,
  RedTeamRecommendation,
  RedTeamStrategy,
  RouteDefinition,
} from '../lib/types';

interface RedTeamViewProps {
  routes: RouteDefinition[];
  onApplyPatch: (
    targetRouteName: string,
    suggestedUtterances: string[]
  ) => Promise<{ updatedRoute: RouteDefinition; addedCount: number }>;
  onRefreshRoutes: () => Promise<void>;
}

type FridaScriptKey = 'onnxHook' | 'trinityHook' | 'runner' | 'readme';

export function RedTeamView({ routes, onApplyPatch, onRefreshRoutes }: RedTeamViewProps) {
  const guardrailRoutes = routes.filter(
    (r) =>
      r.name.includes('guard') ||
      r.name.includes('politics') ||
      r.targetModel.includes('guardrail')
  );

  const [selectedRouteName, setSelectedRouteName] = useState<string>(
    guardrailRoutes[0]?.name ?? (routes[0]?.name || '')
  );
  const [selectedStrategies, setSelectedStrategies] = useState<RedTeamStrategy[]>([
    'semantic_cloaking',
    'metaphorical_framing',
    'cross_language',
    'hypothetical_scaffolding',
    'adversarial_obfuscation',
    'payload_splitting',
  ]);
  const [variantsPerStrategy, setVariantsPerStrategy] = useState<number>(3);
  const [running, setRunning] = useState<boolean>(false);
  const [campaignReport, setCampaignReport] = useState<RedTeamCampaignReport | null>(null);
  const [campaignHistory, setCampaignHistory] = useState<RedTeamCampaignReport[]>([]);
  const [applyingPatchId, setApplyingPatchId] = useState<string | null>(null);
  const [patchSuccessMessage, setPatchSuccessMessage] = useState<string | null>(null);
  const [filterMode, setFilterMode] = useState<'all' | 'bypasses'>('bypasses');

  // Frida scripts drawer state
  const [fridaOpen, setFridaOpen] = useState(false);
  const [fridaTab, setFridaTab] = useState<FridaScriptKey>('onnxHook');
  const [fridaScripts, setFridaScripts] = useState<{
    onnxHook: string;
    trinityHook: string;
    runner: string;
    readme: string;
  } | null>(null);
  const [copiedScript, setCopiedScript] = useState(false);

  useEffect(() => {
    void fetchHistory();
    void fetchFridaScripts();
  }, []);

  const fetchHistory = async () => {
    try {
      const res = await fetch('/api/redteam/history');
      if (res.ok) {
        const data = (await res.json()) as { history: RedTeamCampaignReport[] };
        setCampaignHistory(data.history);
        if (data.history.length > 0 && !campaignReport) {
          setCampaignReport(data.history[0]);
        }
      }
    } catch {
      // Non-blocking
    }
  };

  const fetchFridaScripts = async () => {
    try {
      const res = await fetch('/api/frida/scripts');
      if (res.ok) {
        const data = (await res.json()) as {
          scripts: {
            onnxHook: string;
            trinityHook: string;
            runner: string;
            readme: string;
          };
        };
        setFridaScripts(data.scripts);
      }
    } catch {
      // Non-blocking
    }
  };

  const handleToggleStrategy = (stratId: RedTeamStrategy) => {
    setSelectedStrategies((prev) =>
      prev.includes(stratId) ? prev.filter((s) => s !== stratId) : [...prev, stratId]
    );
  };

  const handleLaunchCampaign = async () => {
    if (selectedStrategies.length === 0) return;
    setRunning(true);
    setPatchSuccessMessage(null);
    try {
      const targetRouteNames =
        selectedRouteName === '__all__'
          ? guardrailRoutes.map((r) => r.name)
          : [selectedRouteName];

      const payload: RedTeamCampaignOptions = {
        targetRouteNames,
        strategies: selectedStrategies,
        variantsPerStrategy,
      };

      const res = await fetch('/api/redteam/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        throw new Error('Failed to complete red-team campaign');
      }

      const data = (await res.json()) as { report: RedTeamCampaignReport };
      setCampaignReport(data.report);
      setCampaignHistory((prev) => [data.report, ...prev]);
    } catch (err) {
      console.error(err);
    } finally {
      setRunning(false);
    }
  };

  const handleApplyDefensivePatch = async (rec: RedTeamRecommendation) => {
    setApplyingPatchId(rec.id);
    setPatchSuccessMessage(null);
    try {
      const result = await onApplyPatch(rec.targetRouteName, rec.suggestedUtterances);
      rec.applied = true;
      setPatchSuccessMessage(
        `Added ${result.addedCount} defensive utterance(s) to "${rec.targetRouteName}". Re-run the campaign to verify that evasion gaps are sealed!`
      );
      await onRefreshRoutes();
    } catch (err) {
      console.error(err);
    } finally {
      setApplyingPatchId(null);
    }
  };

  const handleCopyFridaScript = async () => {
    if (!fridaScripts) return;
    const content = fridaScripts[fridaTab];
    try {
      await navigator.clipboard.writeText(content);
      setCopiedScript(true);
      setTimeout(() => setCopiedScript(false), 1600);
    } catch {
      // Clipboard fallback
    }
  };

  const displayedProbes: RedTeamProbeResult[] =
    campaignReport?.probes.filter((p) =>
      filterMode === 'bypasses' ? p.bypassFound : true
    ) ?? [];

  return (
    <div className="space-y-6">
      {/* Header & Campaign Control Panel */}
      <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="p-1.5 bg-rose-50 border border-rose-200 rounded-md text-rose-700">
                <ShieldAlert className="w-5 h-5" />
              </span>
              <h1 className="text-xl font-semibold text-slate-900">
                Red-Team Bot &amp; Guardrail Hardener
              </h1>
            </div>
            <p className="text-sm text-slate-600 mt-1 max-w-3xl">
              Autonomous adversarial probe suite targeting semantic router guardrails. Tests boundary
              margins using multi-strategy synthetic variants (semantic cloaking, metaphorical framing,
              multilingual transliteration, and token perturbation) and auto-synthesizes defensive patches.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={() => setFridaOpen((v) => !v)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              <Cpu className="w-3.5 h-3.5 text-slate-500" />
              {fridaOpen ? 'Hide Frida Kit' : 'Host Frida Kit'}
            </button>

            <button
              type="button"
              onClick={() => void handleLaunchCampaign()}
              disabled={running || selectedStrategies.length === 0}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-700 disabled:opacity-50 rounded-md transition-colors whitespace-nowrap shrink-0 shadow-xs"
            >
              <Flame className={`w-3.5 h-3.5 ${running ? 'animate-pulse' : ''}`} />
              {running ? 'Running Red-Team Probes...' : 'Launch Red-Team Campaign'}
            </button>
          </div>
        </div>

        {/* Campaign Configuration Grid */}
        <div className="pt-4 border-t border-slate-200 grid grid-cols-1 md:grid-cols-12 gap-4 items-center">
          <div className="md:col-span-5">
            <label htmlFor="target-route-select" className="block text-xs font-medium text-slate-700 mb-1">
              Target Guardrail Route
            </label>
            <select
              id="target-route-select"
              value={selectedRouteName}
              onChange={(e) => setSelectedRouteName(e.target.value)}
              className="w-full px-3 py-1.5 text-xs font-mono bg-slate-50 border border-slate-300 rounded-md focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-500"
            >
              <option value="__all__">All Guardrail Routes ({guardrailRoutes.length})</option>
              {guardrailRoutes.map((r) => (
                <option key={r.id} value={r.name}>
                  {r.name} (threshold: {r.scoreThreshold.toFixed(2)})
                </option>
              ))}
            </select>
          </div>

          <div className="md:col-span-3">
            <label htmlFor="variants-limit-select" className="block text-xs font-medium text-slate-700 mb-1">
              Variants per Strategy
            </label>
            <select
              id="variants-limit-select"
              value={variantsPerStrategy}
              onChange={(e) => setVariantsPerStrategy(Number(e.target.value))}
              className="w-full px-3 py-1.5 text-xs font-mono bg-slate-50 border border-slate-300 rounded-md focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-500"
            >
              <option value={2}>2 variants / strategy (fast check)</option>
              <option value={3}>3 variants / strategy (standard)</option>
              <option value={5}>5 variants / strategy (deep probe)</option>
              <option value={8}>8 variants / strategy (stress audit)</option>
            </select>
          </div>

          <div className="md:col-span-4 text-xs text-slate-500 md:text-right">
            <span>
              Estimated probes:{' '}
              <strong className="text-slate-900 font-mono">
                {(selectedRouteName === '__all__' ? guardrailRoutes.length : 1) *
                  selectedStrategies.length *
                  variantsPerStrategy}
              </strong>
            </span>
            <div className="text-[11px] text-slate-400 mt-0.5">
              Tested across active 3-slot ensemble
            </div>
          </div>
        </div>

        {/* Attack Strategies Selection Strip */}
        <div className="space-y-2 pt-2">
          <div className="text-xs font-semibold text-slate-800">
            Active Attack Strategies ({selectedStrategies.length} / {RED_TEAM_STRATEGIES.length})
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
            {RED_TEAM_STRATEGIES.map((strat) => {
              const active = selectedStrategies.includes(strat.id);
              return (
                <label
                  key={strat.id}
                  className={`flex items-start gap-2.5 p-2.5 border rounded-md cursor-pointer transition-colors ${
                    active
                      ? 'bg-rose-50/40 border-rose-200'
                      : 'bg-slate-50/50 border-slate-200 opacity-60'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={active}
                    onChange={() => handleToggleStrategy(strat.id)}
                    className="mt-0.5 rounded border-slate-300 text-rose-600 focus:ring-rose-500"
                  />
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-slate-900">{strat.label}</div>
                    <div className="text-[11px] text-slate-500 leading-tight mt-0.5">
                      {strat.description}
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        </div>
      </section>

      {/* Frida Dynamic Instrumentation Kit Drawer (Collapsible) */}
      {fridaOpen && (
        <section className="bg-slate-900 border border-slate-800 rounded-lg p-5 text-slate-100 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <Cpu className="w-4 h-4 text-emerald-400" />
                <h2 className="text-sm font-semibold text-white">
                  Host-Side Frida Dynamic Instrumentation Suite
                </h2>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Native C++ hooks for <code className="text-emerald-300">onnxruntime_binding.node</code> and TRINITY :7700 socket frames below the JS layer.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void handleCopyFridaScript()}
                className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded transition-colors"
              >
                {copiedScript ? (
                  <>
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                    Copied!
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5 text-slate-400" />
                    Copy Script
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Frida Tabs */}
          <div className="flex items-center gap-1 border-b border-slate-800 pb-2 text-xs">
            {(
              [
                { key: 'onnxHook', label: 'onnx_hook.js (OrtApi::Run)' },
                { key: 'trinityHook', label: 'trinity_socket_hook.js (:7700)' },
                { key: 'runner', label: 'run_instrumentation.sh' },
                { key: 'readme', label: 'frida/README.md' },
              ] as Array<{ key: FridaScriptKey; label: string }>
            ).map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setFridaTab(t.key)}
                className={`px-3 py-1 rounded font-mono text-[11px] transition-colors ${
                  fridaTab === t.key
                    ? 'bg-slate-800 text-emerald-400 font-semibold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <pre className="p-3 bg-slate-950 border border-slate-800 rounded font-mono text-[11px] text-slate-300 overflow-x-auto max-h-64 overflow-y-auto leading-relaxed">
            {fridaScripts?.[fridaTab] || '// Loading Frida script...'}
          </pre>

          <div className="p-2.5 bg-slate-950/60 border border-slate-800 rounded flex items-center justify-between text-xs text-slate-400">
            <span>Terminal run command:</span>
            <code className="text-emerald-300 font-mono text-[11px]">
              ./frida/run_instrumentation.sh --all
            </code>
          </div>
        </section>
      )}

      {/* Live Campaign Execution Stream & KPI Strip */}
      {campaignReport && (
        <div className="space-y-6">
          {/* KPI Strip */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <div className="p-4 bg-white border border-slate-200 rounded-lg space-y-1">
              <div className="text-xs font-medium text-slate-500">Probes Tested</div>
              <div className="text-2xl font-mono tabular-nums font-bold text-slate-900">
                {campaignReport.totalProbes}
              </div>
              <div className="text-[11px] text-slate-500">
                across {campaignReport.targetRouteNames.join(', ')}
              </div>
            </div>

            <div className="p-4 bg-white border border-slate-200 rounded-lg space-y-1">
              <div className="text-xs font-medium text-slate-500">Guardrail Blocked</div>
              <div className="text-2xl font-mono tabular-nums font-bold text-emerald-700">
                {campaignReport.blockedCount}
              </div>
              <div className="text-[11px] text-slate-500">
                {campaignReport.totalProbes > 0
                  ? `${Math.round((campaignReport.blockedCount / campaignReport.totalProbes) * 100)}% safe`
                  : '—'}
              </div>
            </div>

            <div className="p-4 bg-white border border-slate-200 rounded-lg space-y-1">
              <div className="text-xs font-medium text-slate-500">Bypasses Found</div>
              <div className={`text-2xl font-mono tabular-nums font-bold ${
                campaignReport.bypassCount > 0 ? 'text-rose-600' : 'text-emerald-700'
              }`}>
                {campaignReport.bypassCount}
              </div>
              <div className="text-[11px] text-slate-500">
                {campaignReport.bypassCount > 0
                  ? `${(campaignReport.bypassRate * 100).toFixed(1)}% gap rate`
                  : 'Zero gaps detected'}
              </div>
            </div>

            <div className="p-4 bg-white border border-slate-200 rounded-lg space-y-1">
              <div className="text-xs font-medium text-slate-500">Lowest Bypass Score</div>
              <div className="text-2xl font-mono tabular-nums font-bold text-slate-900">
                {campaignReport.minBypassScore !== null
                  ? campaignReport.minBypassScore.toFixed(4)
                  : '—'}
              </div>
              <div className="text-[11px] text-slate-500">worst-case semantic evasion</div>
            </div>

            <div className="p-4 bg-white border border-slate-200 rounded-lg space-y-1 col-span-2 lg:col-span-1">
              <div className="text-xs font-medium text-slate-500">Recommended Patches</div>
              <div className="text-2xl font-mono tabular-nums font-bold text-blue-600">
                {campaignReport.recommendations.length}
              </div>
              <div className="text-[11px] text-slate-500">defensive synthetic sets</div>
            </div>
          </div>

          {/* Patch Success Toast */}
          {patchSuccessMessage && (
            <div
              role="alert"
              className="p-4 bg-emerald-50 border border-emerald-200 rounded-lg text-xs font-medium text-emerald-900 flex items-center justify-between gap-3"
            >
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                <span>{patchSuccessMessage}</span>
              </div>
              <button
                type="button"
                onClick={() => setPatchSuccessMessage(null)}
                className="text-emerald-700 hover:text-emerald-900"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* Real-Time CLI Terminal Stream */}
          <div className="bg-slate-950 border border-slate-800 rounded-lg overflow-hidden shadow-xs">
            <div className="px-4 py-2 bg-slate-900 border-b border-slate-800 flex items-center justify-between text-xs">
              <div className="flex items-center gap-2 text-slate-300 font-mono">
                <Terminal className="w-3.5 h-3.5 text-rose-400" />
                <span>Red-Team Autonomous Prober Console</span>
              </div>
              <span className="text-[11px] text-slate-400 font-mono">
                {campaignReport.executionLogs.length} events logged
              </span>
            </div>
            <div className="p-4 font-mono text-xs space-y-1 max-h-72 overflow-y-auto leading-relaxed select-text">
              {campaignReport.executionLogs.map((log, idx) => {
                const isRun = log.startsWith('[RUN]');
                const isReport = log.startsWith('[REPORT]');
                const isBlocked = log.includes('✓ blocked');
                const isBypassed = log.includes('✗ BYPASSED');
                const isGap = log.includes('└── gap found');
                const isRec = log.includes('→ Recommend') || log.includes('→ Min bypass');

                let colorClass = 'text-slate-300';
                if (isRun) colorClass = 'text-blue-400 font-bold';
                else if (isReport) colorClass = 'text-amber-400 font-bold';
                else if (isBlocked) colorClass = 'text-emerald-400';
                else if (isBypassed) colorClass = 'text-rose-400 font-semibold';
                else if (isGap) colorClass = 'text-rose-300/80 pl-4';
                else if (isRec) colorClass = 'text-amber-300';

                return (
                  <div key={idx} className={colorClass}>
                    {log}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Defensive Hardening Recommendations & 1-Click Patching */}
          {campaignReport.recommendations.length > 0 && (
            <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2">
                    <Wrench className="w-4 h-4 text-blue-600" />
                    Recommended Defensive Utterance Patches
                  </h2>
                  <p className="text-xs text-slate-600 mt-0.5">
                    Synthesized from successful evasion probe clusters to seal guardrail boundary gaps.
                  </p>
                </div>
              </div>

              <div className="space-y-3">
                {campaignReport.recommendations.map((rec) => (
                  <div
                    key={rec.id}
                    className="p-4 bg-slate-50 border border-slate-200 rounded-md space-y-3"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                      <div className="flex items-center gap-2 text-xs">
                        <span className="font-mono font-bold text-slate-900">
                          {rec.targetRouteName}
                        </span>
                        <span className="text-slate-300">·</span>
                        <span className="font-semibold text-slate-700 capitalize">
                          {rec.issueCategory}
                        </span>
                        <span className="text-slate-300">·</span>
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold uppercase ${
                            rec.severity === 'high'
                              ? 'bg-rose-100 text-rose-800'
                              : 'bg-amber-100 text-amber-800'
                          }`}
                        >
                          {rec.severity} severity
                        </span>
                      </div>

                      <button
                        type="button"
                        onClick={() => void handleApplyDefensivePatch(rec)}
                        disabled={rec.applied || applyingPatchId === rec.id}
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                          rec.applied
                            ? 'bg-emerald-100 text-emerald-800 cursor-default'
                            : 'bg-blue-600 hover:bg-blue-700 text-white'
                        }`}
                      >
                        {rec.applied ? (
                          <>
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-700" />
                            Patched to Route
                          </>
                        ) : applyingPatchId === rec.id ? (
                          'Applying Patch...'
                        ) : (
                          <>
                            <ShieldCheck className="w-3.5 h-3.5" />
                            Apply Defensive Utterances
                          </>
                        )}
                      </button>
                    </div>

                    <p className="text-xs text-slate-600 leading-relaxed">{rec.reason}</p>

                    <div className="space-y-1">
                      <div className="text-[11px] font-semibold text-slate-700">
                        Synthesized Utterances to Add ({rec.suggestedUtterances.length}):
                      </div>
                      <ul className="space-y-1">
                        {rec.suggestedUtterances.map((utt, uIdx) => (
                          <li
                            key={uIdx}
                            className="text-xs font-mono text-slate-800 bg-white border border-slate-200 px-2.5 py-1 rounded"
                          >
                            + {utt}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Strategy Boundary Map Matrix */}
          <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  Attack Strategy Boundary Map
                </h2>
                <p className="text-xs text-slate-600 mt-0.5">
                  Breakdown of probe evasion rate and lowest score by attack archetype.
                </p>
              </div>
            </div>

            <div className="border border-slate-200 rounded-md overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                    <th className="py-2.5 px-3 font-semibold">Attack Strategy</th>
                    <th className="py-2.5 px-3 text-right font-semibold">Tested</th>
                    <th className="py-2.5 px-3 text-right font-semibold">Blocked</th>
                    <th className="py-2.5 px-3 text-right font-semibold">Bypasses</th>
                    <th className="py-2.5 px-3 text-right font-semibold">Lowest Score</th>
                    <th className="py-2.5 px-3 text-right font-semibold">Outcome</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 font-mono">
                  {Object.entries(campaignReport.strategyStats).map(([stratKey, stat]) => {
                    if (stat.tested === 0) return null;
                    const stratDef = RED_TEAM_STRATEGIES.find((s) => s.id === stratKey);
                    const hasBypasses = stat.bypassed > 0;
                    return (
                      <tr key={stratKey} className={hasBypasses ? 'bg-rose-50/20' : ''}>
                        <td className="py-2.5 px-3 font-sans font-medium text-slate-900">
                          {stratDef?.label || stratKey}
                        </td>
                        <td className="py-2.5 px-3 text-right tabular-nums text-slate-700">
                          {stat.tested}
                        </td>
                        <td className="py-2.5 px-3 text-right tabular-nums text-emerald-700 font-semibold">
                          {stat.blocked}
                        </td>
                        <td className="py-2.5 px-3 text-right tabular-nums text-rose-700 font-bold">
                          {stat.bypassed}
                        </td>
                        <td className="py-2.5 px-3 text-right tabular-nums text-slate-800">
                          {stat.minScore < 1 ? stat.minScore.toFixed(4) : '—'}
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase ${
                              hasBypasses
                                ? 'bg-rose-100 text-rose-800'
                                : 'bg-emerald-100 text-emerald-800'
                            }`}
                          >
                            {hasBypasses ? `${stat.bypassed} GAPS` : 'SECURE'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* Detailed Probes Table */}
          <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  Adversarial Probe Trace Log ({displayedProbes.length})
                </h2>
                <p className="text-xs text-slate-600 mt-0.5">
                  Inspect generated adversarial prompts, exact similarity scores, and routing outcomes.
                </p>
              </div>

              <div className="flex items-center gap-1.5 p-0.5 bg-slate-100 rounded border border-slate-200 text-xs">
                <button
                  type="button"
                  onClick={() => setFilterMode('bypasses')}
                  className={`px-2.5 py-1 rounded font-medium transition-colors ${
                    filterMode === 'bypasses'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Bypasses Only ({campaignReport.bypassCount})
                </button>
                <button
                  type="button"
                  onClick={() => setFilterMode('all')}
                  className={`px-2.5 py-1 rounded font-medium transition-colors ${
                    filterMode === 'all'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  All Probes ({campaignReport.totalProbes})
                </button>
              </div>
            </div>

            <div className="border border-slate-200 rounded-md overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                    <th className="py-2.5 px-3 font-semibold">Strategy</th>
                    <th className="py-2.5 px-3 font-semibold">Generated Adversarial Probe</th>
                    <th className="py-2.5 px-3 font-semibold">Target Route</th>
                    <th className="py-2.5 px-3 text-right font-semibold">Score</th>
                    <th className="py-2.5 px-3 text-right font-semibold">Threshold</th>
                    <th className="py-2.5 px-3 text-right font-semibold">Margin</th>
                    <th className="py-2.5 px-3 text-right font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {displayedProbes.map((probe) => {
                    const isBypass = probe.bypassFound;
                    return (
                      <tr
                        key={probe.id}
                        className={isBypass ? 'bg-rose-50/30 hover:bg-rose-50/50' : 'hover:bg-slate-50'}
                      >
                        <td className="py-2.5 px-3 font-mono text-[11px] text-slate-600 whitespace-nowrap">
                          {probe.strategyLabel}
                        </td>
                        <td className="py-2.5 px-3 text-slate-900 max-w-md font-sans">
                          <div className="font-medium line-clamp-2">{probe.prompt}</div>
                          {isBypass && (
                            <div className="text-[11px] font-mono text-rose-700 mt-0.5">
                              Routed to: {probe.matchedRouteName || 'None'}
                            </div>
                          )}
                        </td>
                        <td className="py-2.5 px-3 font-mono text-xs text-slate-700 whitespace-nowrap">
                          {probe.targetRouteName}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-900 font-semibold">
                          {probe.topScore.toFixed(4)}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-600">
                          {probe.threshold.toFixed(2)}
                        </td>
                        <td
                          className={`py-2.5 px-3 text-right font-mono tabular-nums ${
                            probe.scoreMargin >= 0 ? 'text-emerald-700' : 'text-rose-700 font-bold'
                          }`}
                        >
                          {probe.scoreMargin >= 0
                            ? `+${probe.scoreMargin.toFixed(3)}`
                            : probe.scoreMargin.toFixed(3)}
                        </td>
                        <td className="py-2.5 px-3 text-right whitespace-nowrap">
                          {isBypass ? (
                            <span className="inline-flex items-center gap-1 font-mono font-semibold text-[11px] text-rose-700">
                              <XCircle className="w-3.5 h-3.5" />
                              BYPASSED
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 font-mono font-semibold text-[11px] text-emerald-700">
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              BLOCKED
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
