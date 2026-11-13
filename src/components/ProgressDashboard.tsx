import React, { useState } from 'react';
import {
  Activity,
  CheckCircle2,
  Compass,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  XCircle,
} from 'lucide-react';
import { SEED_PROJECT_MILESTONES } from '../lib/seedData';
import type {
  AgentStateSnapshot,
  ProjectMilestone,
  ProjectProgressState,
  RouteDefinition,
} from '../lib/types';

interface ProgressDashboardProps {
  progressState: ProjectProgressState;
  agentState: AgentStateSnapshot;
  routes: RouteDefinition[];
  onEvaluateOutput: (outputText: string) => Promise<void>;
  onSaveMilestones: (milestones: ProjectMilestone[]) => Promise<void>;
  onClearRouteOverride: () => Promise<void>;
}

const SIMULATION_SAMPLES = [
  {
    label: 'Simulate SQL Analytics Output',
    text: 'Generate production PostgreSQL window function queries, composite B-Tree index plans, and retention SQL analytics.',
  },
  {
    label: 'Simulate Billing Refund Extraction',
    text: 'Extract structured order IDs (ORD-XXXX) and refund reasons for duplicate credit card charge disputes.',
  },
  {
    label: 'Simulate RAG Grounding Response',
    text: 'Ground final assistant responses with retrieved external webhook or TRINITY FAISS knowledge chunks and source citations.',
  },
];

export function ProgressDashboard({
  progressState,
  agentState,
  routes,
  onEvaluateOutput,
  onSaveMilestones,
  onClearRouteOverride,
}: ProgressDashboardProps) {
  const [evalText, setEvalText] = useState(SIMULATION_SAMPLES[0].text);
  const [evaluating, setEvaluating] = useState(false);

  const [newLabel, setNewLabel] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newThreshold, setNewThreshold] = useState(0.75);
  const [newRouteHint, setNewRouteHint] = useState('');
  const [savingMilestones, setSavingMilestones] = useState(false);

  const completedCount = progressState.progress.filter((p) => p.completed).length;
  const overallPct = Math.round((progressState.overallProgress ?? 0) * 100);
  const activeFocus = progressState.milestones.find((m) => m.id === progressState.currentFocusId);

  const handleEvaluateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!evalText.trim()) return;
    setEvaluating(true);
    try {
      await onEvaluateOutput(evalText);
    } finally {
      setEvaluating(false);
    }
  };

  const handleAddMilestone = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newLabel.trim() || !newDesc.trim()) return;
    setSavingMilestones(true);
    try {
      const next: ProjectMilestone[] = [
        ...progressState.milestones,
        {
          id: `ms-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          label: newLabel.trim(),
          description: newDesc.trim(),
          completionThreshold: Math.max(0.1, Math.min(0.99, newThreshold)),
          targetRouteHint: newRouteHint.trim() || undefined,
        },
      ];
      await onSaveMilestones(next);
      setNewLabel('');
      setNewDesc('');
      setNewRouteHint('');
    } finally {
      setSavingMilestones(false);
    }
  };

  const handleDeleteMilestone = async (id: string) => {
    setSavingMilestones(true);
    try {
      await onSaveMilestones(progressState.milestones.filter((m) => m.id !== id));
    } finally {
      setSavingMilestones(false);
    }
  };

  const handleResetDefaults = async () => {
    setSavingMilestones(true);
    try {
      await onSaveMilestones(structuredClone(SEED_PROJECT_MILESTONES));
    } finally {
      setSavingMilestones(false);
    }
  };

  const vecPreview = progressState.lastStateVecPreview ?? [];

  return (
    <div className="space-y-6">
      {/* Header & Overall Progress Summary */}
      <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-slate-900 flex items-center gap-2">
              <Compass className="w-5 h-5 text-blue-600 shrink-0" />
              Project Progress &amp; EM-3 State Tracker
            </h1>
            <p className="text-sm text-slate-600 mt-1">
              Continuous semantic alignment tracked by{' '}
              <span className="font-mono text-slate-800">BAAI/bge-m3</span> (1024-dim state space)
              with automatic <span className="font-mono text-slate-800">AgentState</span>{' '}
              milestone progression.
            </p>
          </div>

          <button
            type="button"
            onClick={() => void handleResetDefaults()}
            disabled={savingMilestones}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset Default Milestones
          </button>
        </div>

        {/* Summary Metrics Strip */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-md space-y-2">
            <div className="flex items-center justify-between text-xs text-slate-600">
              <span className="font-medium">Overall Alignment</span>
              <span className="font-mono tabular-nums font-bold text-slate-900">{overallPct}%</span>
            </div>
            <div className="h-2 bg-slate-200 rounded-sm overflow-hidden">
              <div
                className="h-full bg-blue-600 transition-all"
                style={{ width: `${Math.min(100, Math.max(0, overallPct))}%` }}
              />
            </div>
            <div className="text-[11px] font-mono tabular-nums text-slate-500">
              {completedCount} / {progressState.milestones.length} milestones crossed
            </div>
          </div>

          <div className="p-4 bg-slate-50 border border-slate-200 rounded-md space-y-1">
            <div className="text-xs font-medium text-slate-600">Active Focus Milestone</div>
            <div className="text-sm font-semibold text-slate-900 truncate">
              {activeFocus?.label ?? 'None'}
            </div>
            <div className="text-[11px] font-mono text-slate-500 truncate">
              Session {progressState.sessionId}
            </div>
          </div>

          <div className="p-4 bg-slate-50 border border-slate-200 rounded-md space-y-1">
            <div className="flex items-center justify-between text-xs font-medium text-slate-600">
              <span>AgentState Route Override</span>
              {agentState.routeOverride && (
                <button
                  type="button"
                  onClick={() => void onClearRouteOverride()}
                  className="text-blue-600 hover:underline inline-flex items-center gap-1 whitespace-nowrap"
                >
                  <XCircle className="w-3 h-3" />
                  Clear
                </button>
              )}
            </div>
            <div className="text-sm font-mono font-semibold text-slate-900">
              {agentState.routeOverride ?? 'None (Normal Semantic Routing)'}
            </div>
            <div className="text-[11px] font-mono text-slate-500 truncate">
              {agentState.lastCompletedMilestoneId
                ? `Last completed: ${agentState.lastCompletedMilestoneId}`
                : 'Awaiting first milestone crossing'}
            </div>
          </div>
        </div>
      </section>

      {/* Main Two-Column Grid: Milestones + Evaluator */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left: Milestone Alignment List & Add Form */}
        <section className="lg:col-span-7 bg-white border border-slate-200 rounded-lg p-6 space-y-5">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-900">
              Project Milestones ({progressState.milestones.length})
            </h2>
            <span className="text-xs font-mono text-slate-500">
              Updated {new Date(progressState.lastUpdatedAt).toLocaleTimeString()}
            </span>
          </div>

          <div className="space-y-3" data-testid="progress-milestone-list">
            {progressState.milestones.map((m) => {
              const prog = progressState.progress.find((p) => p.milestoneId === m.id);
              const score = prog?.score ?? 0;
              const completed = Boolean(prog?.completed);
              const isFocus = progressState.currentFocusId === m.id;
              const scorePct = Math.round(score * 100);
              const threshPct = Math.round(m.completionThreshold * 100);

              return (
                <div
                  key={m.id}
                  data-testid={`milestone-card-${m.id}`}
                  className={`p-4 rounded-md border space-y-2.5 ${
                    completed
                      ? 'bg-emerald-50/30 border-emerald-200'
                      : isFocus
                        ? 'bg-blue-50/30 border-blue-200'
                        : 'bg-slate-50/60 border-slate-200'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-semibold text-sm text-slate-900">{m.label}</span>
                        <span className="text-slate-300" aria-hidden="true">
                          ·
                        </span>
                        {completed ? (
                          <span className="inline-flex items-center gap-1 font-mono font-semibold text-emerald-700">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            Completed
                          </span>
                        ) : isFocus ? (
                          <span className="font-mono font-semibold text-blue-700">
                            Active Focus
                          </span>
                        ) : (
                          <span className="font-mono text-slate-500">Pending</span>
                        )}
                        {m.targetRouteHint && (
                          <>
                            <span className="text-slate-300" aria-hidden="true">
                              ·
                            </span>
                            <span className="font-mono text-slate-600">
                              Next hint → {m.targetRouteHint}
                            </span>
                          </>
                        )}
                      </div>
                      <p className="text-xs text-slate-600 leading-relaxed">{m.description}</p>
                    </div>

                    <button
                      type="button"
                      onClick={() => void handleDeleteMilestone(m.id)}
                      aria-label={`Remove milestone ${m.label}`}
                      className="p-1.5 text-slate-400 hover:text-rose-600 rounded transition-colors shrink-0"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {/* Cosine Similarity Progress Bar + Threshold Marker */}
                  <div className="space-y-1">
                    <div className="relative h-2 bg-slate-200 rounded-sm overflow-hidden">
                      <div
                        className={`h-full transition-all ${
                          completed ? 'bg-emerald-600' : 'bg-blue-600'
                        }`}
                        style={{ width: `${Math.min(100, Math.max(0, scorePct))}%` }}
                      />
                      <div
                        className="absolute top-0 bottom-0 w-0.5 bg-slate-900"
                        style={{ left: `${Math.min(99, Math.max(1, threshPct))}%` }}
                        title={`Completion threshold: ${m.completionThreshold.toFixed(2)}`}
                      />
                    </div>
                    <div className="flex items-center justify-between text-[11px] font-mono tabular-nums text-slate-600">
                      <span>
                        Cosine Sim: <strong className="text-slate-900">{score.toFixed(4)}</strong>
                      </span>
                      <span>Threshold: {m.completionThreshold.toFixed(2)}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Add Custom Milestone Form */}
          <form
            onSubmit={handleAddMilestone}
            className="pt-4 border-t border-slate-200 space-y-3"
          >
            <div className="text-xs font-semibold text-slate-800">Add Project Milestone</div>
            <div className="grid grid-cols-1 sm:grid-cols-12 gap-2.5">
              <div className="sm:col-span-5">
                <label htmlFor="ms-label-input" className="block text-[11px] text-slate-600 mb-1">
                  Label
                </label>
                <input
                  id="ms-label-input"
                  type="text"
                  required
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  placeholder="Deployment Readiness"
                  className="w-full px-2.5 py-1.5 text-xs bg-slate-50 border border-slate-300 rounded focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
              <div className="sm:col-span-3">
                <label htmlFor="ms-thresh-input" className="block text-[11px] text-slate-600 mb-1">
                  Threshold
                </label>
                <input
                  id="ms-thresh-input"
                  type="number"
                  step={0.01}
                  min={0.1}
                  max={0.99}
                  value={newThreshold}
                  onChange={(e) => setNewThreshold(Number(e.target.value))}
                  className="w-full px-2.5 py-1.5 text-xs font-mono tabular-nums bg-slate-50 border border-slate-300 rounded focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
              <div className="sm:col-span-4">
                <label htmlFor="ms-route-hint" className="block text-[11px] text-slate-600 mb-1">
                  Auto-Advance Hint (opt)
                </label>
                <select
                  id="ms-route-hint"
                  value={newRouteHint}
                  onChange={(e) => setNewRouteHint(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-xs font-mono bg-slate-50 border border-slate-300 rounded focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
                >
                  <option value="">None</option>
                  {routes.map((r) => (
                    <option key={r.id} value={r.name}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="sm:col-span-9">
                <label htmlFor="ms-desc-input" className="sr-only">
                  Milestone semantic description
                </label>
                <input
                  id="ms-desc-input"
                  type="text"
                  required
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  placeholder="Semantic target description embedded by EM-3 (BAAI/bge-m3)..."
                  className="w-full px-2.5 py-1.5 text-xs bg-slate-50 border border-slate-300 rounded focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
              <div className="sm:col-span-3">
                <button
                  type="submit"
                  disabled={savingMilestones || !newLabel.trim() || !newDesc.trim()}
                  className="w-full inline-flex items-center justify-center gap-1 px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded transition-colors whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add
                </button>
              </div>
            </div>
          </form>
        </section>

        {/* Right: EM-3 Evaluator, Vector Sparkline, and Session Memory Log */}
        <div className="lg:col-span-5 space-y-6">
          <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-blue-600" />
                Evaluate Output with EM-3 (bge-m3)
              </h2>
              <p className="text-xs text-slate-600 mt-1">
                Embed any agent/LLM output in 1024-dim state space and compute live cosine
                alignment across all active milestones.
              </p>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {SIMULATION_SAMPLES.map((sample) => (
                <button
                  key={sample.label}
                  type="button"
                  onClick={() => setEvalText(sample.text)}
                  className="px-2.5 py-1 text-[11px] font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded transition-colors whitespace-nowrap"
                >
                  {sample.label}
                </button>
              ))}
            </div>

            <form onSubmit={handleEvaluateSubmit} className="space-y-3">
              <label htmlFor="em3-eval-textarea" className="sr-only">
                Output text to evaluate against milestones
              </label>
              <textarea
                id="em3-eval-textarea"
                rows={3}
                value={evalText}
                onChange={(e) => setEvalText(e.target.value)}
                placeholder="Paste assistant or tool output..."
                className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-300 rounded-md focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
              <button
                type="submit"
                disabled={evaluating || !evalText.trim()}
                className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-md transition-colors whitespace-nowrap"
              >
                <Activity className="w-3.5 h-3.5" />
                {evaluating ? 'Scoring State Vector...' : 'Score Output Against Milestones'}
              </button>
            </form>

            {/* EM-3 State Vector Preview Sparkline */}
            {vecPreview.length > 0 && (
              <div className="pt-3 border-t border-slate-200 space-y-2">
                <div className="flex items-center justify-between text-[11px] font-mono text-slate-600">
                  <span>EM-3 State Vector Activation (first {vecPreview.length} dims)</span>
                  <span>1024-dim normalized</span>
                </div>
                <div className="p-2 bg-slate-950 border border-slate-800 rounded">
                  <svg
                    viewBox="0 0 240 44"
                    className="w-full h-10"
                    role="img"
                    aria-label="EM-3 1024-dimensional state vector activation sparkline"
                  >
                    <line x1="0" y1="22" x2="240" y2="22" stroke="#334155" strokeWidth="0.8" />
                    {vecPreview.map((val, idx) => {
                      const barH = Math.min(20, Math.max(2, Math.abs(val) * 160));
                      const x = idx * (240 / vecPreview.length) + 2;
                      const y = val >= 0 ? 22 - barH : 22;
                      return (
                        <rect
                          key={idx}
                          x={x}
                          y={y}
                          width={6}
                          height={barH}
                          rx={1}
                          fill={val >= 0 ? '#38BDF8' : '#818CF8'}
                        />
                      );
                    })}
                  </svg>
                </div>
              </div>
            )}
          </section>

          {/* Shared AgentState Session Memory Log */}
          <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">
                AgentState Session Memory Log
              </h2>
              <span className="text-xs font-mono tabular-nums text-slate-500">
                {agentState.sessionMemoryLog.length} events
              </span>
            </div>

            {agentState.sessionMemoryLog.length === 0 ? (
              <div className="p-4 text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-md">
                No milestone completion events recorded yet in this session.
              </div>
            ) : (
              <div className="divide-y divide-slate-200 border border-slate-200 rounded-md max-h-72 overflow-y-auto">
                {agentState.sessionMemoryLog.map((entry) => (
                  <div key={entry.id} className="p-3 text-xs space-y-1">
                    <div className="flex items-center justify-between gap-2 font-mono text-[11px] text-slate-500">
                      <span>{entry.source}</span>
                      <span>{new Date(entry.timestamp).toLocaleTimeString()}</span>
                    </div>
                    <div className="text-slate-800">{entry.message}</div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
