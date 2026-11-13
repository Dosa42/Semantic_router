import React, { useState } from 'react';
import { CheckCircle2, Play, Plus, Sliders, Trash2, XCircle } from 'lucide-react';
import type { EvalCase, EvalReport, FitReport, RouteDefinition } from '../lib/types';

interface EvaluationViewProps {
  routes: RouteDefinition[];
  evalCases: EvalCase[];
  evalReport: EvalReport | null;
  fitReport: FitReport | null;
  loadingEval: boolean;
  loadingFit: boolean;
  onRunEvaluation: () => Promise<void>;
  onRunFit: () => Promise<void>;
  onAddEvalCase: (query: string, expectedRoute: string | null) => Promise<void>;
  onDeleteEvalCase: (id: string) => Promise<void>;
}

export function EvaluationView({
  routes,
  evalCases,
  evalReport,
  fitReport,
  loadingEval,
  loadingFit,
  onRunEvaluation,
  onRunFit,
  onAddEvalCase,
  onDeleteEvalCase,
}: EvaluationViewProps) {
  const [newQuery, setNewQuery] = useState('');
  const [expectedRoute, setExpectedRoute] = useState<string>(routes[0]?.name ?? '');
  const [formError, setFormError] = useState<string | null>(null);

  const handleAddCase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newQuery.trim()) {
      setFormError('Enter a test query before adding an evaluation case.');
      return;
    }
    setFormError(null);
    await onAddEvalCase(newQuery.trim(), expectedRoute === '__none__' ? null : expectedRoute || null);
    setNewQuery('');
  };

  return (
    <div className="space-y-6">
      {/* Header & Controls */}
      <section className="bg-white border border-slate-200 rounded-lg p-6">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">
              Batch Evaluation & Threshold Optimization
            </h1>
            <p className="text-sm text-slate-600 mt-1">
              Benchmark routing accuracy across labeled queries and execute coordinate-ascent{' '}
              <span className="font-mono text-slate-800">fit()</span> to calibrate route thresholds.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => void onRunEvaluation()}
              disabled={loadingEval || loadingFit}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-50 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              <Play className="w-4 h-4" />
              {loadingEval ? 'Evaluating...' : 'Run Evaluation'}
            </button>

            <button
              type="button"
              onClick={() => void onRunFit()}
              disabled={loadingFit || loadingEval}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              <Sliders className="w-4 h-4" />
              {loadingFit ? 'Optimizing...' : 'Optimize Thresholds (fit)'}
            </button>
          </div>
        </div>

        {/* KPI Strip */}
        <div className="mt-6 grid grid-cols-2 lg:grid-cols-4 border border-slate-200 rounded-md divide-y lg:divide-y-0 lg:divide-x divide-slate-200 bg-slate-50/50">
          <div className="p-4">
            <div className="text-xs font-medium text-slate-500">Overall Accuracy</div>
            <div className="text-2xl font-mono tabular-nums font-bold text-slate-900 mt-1">
              {evalReport ? `${(evalReport.accuracy * 100).toFixed(1)}%` : '—'}
            </div>
            <div className="text-xs text-slate-500 mt-0.5 tabular-nums">
              {evalReport
                ? `${evalReport.correctCases} of ${evalReport.totalCases} correct`
                : 'Run evaluation to score'}
            </div>
          </div>

          <div className="p-4">
            <div className="text-xs font-medium text-slate-500">Route Match Rate</div>
            <div className="text-2xl font-mono tabular-nums font-bold text-slate-900 mt-1">
              {evalReport && evalReport.totalCases > 0
                ? `${((evalReport.matchedCount / evalReport.totalCases) * 100).toFixed(1)}%`
                : '—'}
            </div>
            <div className="text-xs text-slate-500 mt-0.5 tabular-nums">
              {evalReport ? `${evalReport.fallbackCount} routed to None` : 'Pending run'}
            </div>
          </div>

          <div className="p-4">
            <div className="text-xs font-medium text-slate-500">Out-of-Domain FPR</div>
            <div className="text-2xl font-mono tabular-nums font-bold text-slate-900 mt-1">
              {evalReport ? `${(evalReport.falsePositiveRate * 100).toFixed(1)}%` : '—'}
            </div>
            <div className="text-xs text-slate-500 mt-0.5">False matches on None queries</div>
          </div>

          <div className="p-4">
            <div className="text-xs font-medium text-slate-500">Test Dataset Size</div>
            <div className="text-2xl font-mono tabular-nums font-bold text-slate-900 mt-1">
              {evalCases.length}
            </div>
            <div className="text-xs text-slate-500 mt-0.5 truncate">
              {evalReport ? evalReport.encoderUsed : `${routes.filter((r) => r.enabled).length} active routes`}
            </div>
          </div>
        </div>

        {/* Fit Optimization Summary */}
        {fitReport && (
          <div className="mt-5 p-4 bg-emerald-50/70 border border-emerald-200 rounded-md">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-semibold text-emerald-900">
                Threshold Optimization Complete ({(fitReport.beforeAccuracy * 100).toFixed(1)}% →{' '}
                {(fitReport.afterAccuracy * 100).toFixed(1)}%)
              </div>
              <span className="text-xs font-mono tabular-nums text-emerald-800">
                {fitReport.changes.length} route threshold(s) updated
              </span>
            </div>
            {fitReport.changes.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs font-mono text-emerald-900">
                {fitReport.changes.map((c) => (
                  <span key={c.routeId} className="tabular-nums">
                    {c.routeName}: {c.previousThreshold.toFixed(2)} → {c.optimizedThreshold.toFixed(2)}
                  </span>
                ))}
              </div>
            ) : (
              <p className="mt-1 text-xs text-emerald-800">
                Existing route thresholds are already optimal for the current evaluation dataset.
              </p>
            )}
          </div>
        )}
      </section>

      {/* Per-Route Precision / Recall Table */}
      {evalReport && (
        <section className="bg-white border border-slate-200 rounded-lg p-6">
          <h2 className="text-base font-semibold text-slate-900 mb-3">Per-Route Performance</h2>
          <div className="overflow-x-auto border border-slate-200 rounded-md">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-xs font-medium text-slate-600">
                  <th className="py-2.5 px-4">Route</th>
                  <th className="py-2.5 px-4 text-right">Support</th>
                  <th className="py-2.5 px-4 text-right">Precision</th>
                  <th className="py-2.5 px-4 text-right">Recall</th>
                  <th className="py-2.5 px-4 text-right">F1 Score</th>
                  <th className="py-2.5 px-4 text-right">Threshold</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-xs">
                {evalReport.routeMetrics.map((m) => (
                  <tr key={m.routeName} className="hover:bg-slate-50">
                    <td className="py-2.5 px-4 font-mono font-semibold text-slate-900">
                      {m.routeName}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-700">
                      {m.support}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-800">
                      {(m.precision * 100).toFixed(0)}%
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-800">
                      {(m.recall * 100).toFixed(0)}%
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums font-semibold text-slate-900">
                      {(m.f1 * 100).toFixed(0)}%
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-700">
                      {m.currentThreshold.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Add Test Case & Prediction Table */}
      <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-slate-900">Evaluation Dataset & Predictions</h2>
          <span className="text-xs font-mono tabular-nums text-slate-500">
            {evalCases.length} labeled cases
          </span>
        </div>

        <form onSubmit={handleAddCase} className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end">
          <div className="sm:col-span-7">
            <label htmlFor="eval-query-input" className="block text-xs font-medium text-slate-700 mb-1">
              Test Query
            </label>
            <input
              id="eval-query-input"
              type="text"
              value={newQuery}
              onChange={(e) => setNewQuery(e.target.value)}
              placeholder="e.g., Check local time in Berlin right now"
              className="w-full px-3 py-2 text-sm bg-slate-50 border border-slate-300 rounded-md focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
          </div>

          <div className="sm:col-span-3">
            <label htmlFor="eval-expected-select" className="block text-xs font-medium text-slate-700 mb-1">
              Expected Route
            </label>
            <select
              id="eval-expected-select"
              value={expectedRoute}
              onChange={(e) => setExpectedRoute(e.target.value)}
              className="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-600"
            >
              {routes.map((r) => (
                <option key={r.id} value={r.name}>
                  {r.name}
                </option>
              ))}
              <option value="__none__">None (Fallback)</option>
            </select>
          </div>

          <div className="sm:col-span-2">
            <button
              type="submit"
              className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              <Plus className="w-4 h-4" />
              Add Case
            </button>
          </div>
        </form>

        {formError && (
          <div role="alert" className="text-xs text-rose-700">
            {formError}
          </div>
        )}

        <div className="overflow-x-auto border border-slate-200 rounded-md">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-xs font-medium text-slate-600">
                <th className="py-2.5 px-4">Query</th>
                <th className="py-2.5 px-4">Expected</th>
                <th className="py-2.5 px-4">Predicted</th>
                <th className="py-2.5 px-4 text-right">Top Score</th>
                <th className="py-2.5 px-4">Outcome</th>
                <th className="py-2.5 px-4 text-right">Remove</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-xs">
              {evalCases.map((c) => {
                const pred = evalReport?.predictions.find((p) => p.id === c.id);
                return (
                  <tr key={c.id} className="hover:bg-slate-50">
                    <td className="py-2.5 px-4 text-slate-900 max-w-md">{c.query}</td>
                    <td className="py-2.5 px-4 font-mono text-slate-700 whitespace-nowrap">
                      {c.expectedRoute ?? 'None'}
                    </td>
                    <td className="py-2.5 px-4 font-mono text-slate-900 whitespace-nowrap">
                      {pred ? pred.predictedRoute ?? 'None' : '—'}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-700">
                      {pred ? pred.topScore.toFixed(4) : '—'}
                    </td>
                    <td className="py-2.5 px-4 whitespace-nowrap">
                      {pred ? (
                        pred.correct ? (
                          <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            Pass
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-rose-700 font-medium">
                            <XCircle className="w-3.5 h-3.5" />
                            Miss
                          </span>
                        )
                      ) : (
                        <span className="text-slate-400">Not run</span>
                      )}
                    </td>
                    <td className="py-2.5 px-4 text-right">
                      <button
                        type="button"
                        onClick={() => void onDeleteEvalCase(c.id)}
                        aria-label={`Delete evaluation case ${c.query}`}
                        className="p-1 text-slate-400 hover:text-rose-600 rounded"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
