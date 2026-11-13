import React, { useMemo, useState } from 'react';
import { Pencil, Search, Trash2 } from 'lucide-react';
import type { RouteDefinition } from '../lib/types';

interface RoutesViewProps {
  routes: RouteDefinition[];
  onNewRoute: () => void;
  onEditRoute: (route: RouteDefinition) => void;
  onToggleRoute: (route: RouteDefinition) => Promise<void>;
  onDeleteRoute: (id: string) => Promise<void>;
}

export function RoutesView({
  routes,
  onNewRoute,
  onEditRoute,
  onToggleRoute,
  onDeleteRoute,
}: RoutesViewProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'static' | 'dynamic'>('all');

  const filteredRoutes = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return routes.filter((route) => {
      if (typeFilter !== 'all' && route.routeType !== typeFilter) return false;
      if (!q) return true;
      return (
        route.name.toLowerCase().includes(q) ||
        route.description.toLowerCase().includes(q) ||
        route.targetModel.toLowerCase().includes(q) ||
        route.utterances.some((u) => u.toLowerCase().includes(q))
      );
    });
  }, [routes, searchQuery, typeFilter]);

  return (
    <div className="space-y-6">
      <section className="bg-white border border-slate-200 rounded-lg p-6">
        <div className="mb-5">
          <h1 className="text-xl font-semibold text-slate-900">Route Registry</h1>
          <p className="text-sm text-slate-600 mt-1">
            Configure semantic routes, example utterances, score thresholds, and dynamic tool schemas.
          </p>
        </div>

        {/* Search & Filter Toolbar */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
          <div className="relative flex-1 max-w-md">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <label htmlFor="routes-search-input" className="sr-only">
              Filter routes
            </label>
            <input
              id="routes-search-input"
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search routes, target models, or utterances..."
              className="w-full pl-9 pr-3 py-2 text-sm bg-slate-50 border border-slate-300 rounded-md focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
          </div>

          <div
            role="group"
            aria-label="Filter routes by type"
            className="inline-flex p-1 bg-slate-100 border border-slate-200 rounded-md self-start sm:self-auto"
          >
            {(['all', 'static', 'dynamic'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setTypeFilter(tab)}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                  typeFilter === tab
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {tab === 'all' ? `All (${routes.length})` : tab === 'static' ? 'Static' : 'Dynamic'}
              </button>
            ))}
          </div>
        </div>

        {/* Routes Table or Empty State */}
        {filteredRoutes.length === 0 ? (
          <div className="py-12 px-6 text-center border border-dashed border-slate-300 rounded-md bg-slate-50/50">
            <h2 className="text-sm font-semibold text-slate-900">No routes match your criteria</h2>
            <p className="text-sm text-slate-600 mt-1">
              {routes.length === 0
                ? 'Create your first semantic route with example utterances to begin routing prompts.'
                : 'Try clearing your search query or switching the route type filter.'}
            </p>
            <div className="mt-4 flex items-center justify-center gap-3">
              {routes.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    setTypeFilter('all');
                  }}
                  className="px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 whitespace-nowrap shrink-0"
                >
                  Clear Filters
                </button>
              )}
              <button
                type="button"
                onClick={onNewRoute}
                className="px-4 py-2 text-xs font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 whitespace-nowrap shrink-0"
              >
                Create Route
              </button>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto border border-slate-200 rounded-md">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-xs font-medium text-slate-600">
                  <th className="py-2.5 px-4">Route Name</th>
                  <th className="py-2.5 px-4">Type</th>
                  <th className="py-2.5 px-4">Target Handler</th>
                  <th className="py-2.5 px-4 text-right">Utterances</th>
                  <th className="py-2.5 px-4 text-right">Threshold</th>
                  <th className="py-2.5 px-4">Status</th>
                  <th className="py-2.5 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-sm">
                {filteredRoutes.map((route) => (
                  <tr key={route.id} className="hover:bg-slate-50">
                    <td className="py-3 px-4 max-w-xs">
                      <div className="font-mono text-xs font-semibold text-slate-900">
                        {route.name}
                      </div>
                      <div className="text-xs text-slate-500 truncate mt-0.5">
                        {route.description}
                      </div>
                    </td>

                    <td className="py-3 px-4 text-xs text-slate-700 whitespace-nowrap">
                      {route.routeType === 'dynamic' ? 'Dynamic Tool' : 'Static'}
                    </td>

                    <td className="py-3 px-4 font-mono text-xs text-slate-700 whitespace-nowrap">
                      {route.targetModel}
                    </td>

                    <td className="py-3 px-4 text-right font-mono tabular-nums text-xs text-slate-700">
                      {route.utterances.length}
                    </td>

                    <td className="py-3 px-4 text-right font-mono tabular-nums text-xs font-semibold text-slate-900">
                      {route.scoreThreshold.toFixed(2)}
                    </td>

                    <td className="py-3 px-4 whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => void onToggleRoute(route)}
                        aria-label={`Toggle route ${route.name} ${route.enabled ? 'off' : 'on'}`}
                        className={`text-xs font-medium hover:underline ${
                          route.enabled ? 'text-emerald-700' : 'text-slate-500'
                        }`}
                      >
                        {route.enabled ? 'Active' : 'Disabled'}
                      </button>
                    </td>

                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => onEditRoute(route)}
                          aria-label={`Edit route ${route.name}`}
                          className="p-1.5 text-slate-500 hover:text-blue-600 rounded hover:bg-slate-100 transition-colors"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void onDeleteRoute(route.id)}
                          aria-label={`Delete route ${route.name}`}
                          className="p-1.5 text-slate-500 hover:text-rose-600 rounded hover:bg-slate-100 transition-colors"
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
        )}
      </section>
    </div>
  );
}
