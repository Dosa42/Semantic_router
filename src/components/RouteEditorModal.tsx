import React, { useEffect, useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import type { FunctionParameter, RouteDefinition, RouteType } from '../lib/types';

interface RouteEditorModalProps {
  isOpen: boolean;
  initialRoute: RouteDefinition | null;
  defaultThreshold: number;
  onClose: () => void;
  onSave: (payload: {
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
  }) => Promise<void>;
}

export function RouteEditorModal({
  isOpen,
  initialRoute,
  defaultThreshold,
  onClose,
  onSave,
}: RouteEditorModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [routeType, setRouteType] = useState<RouteType>('static');
  const [targetModel, setTargetModel] = useState('openai:chatgpt-flagship');
  const [scoreThreshold, setScoreThreshold] = useState(defaultThreshold);
  const [enabled, setEnabled] = useState(true);
  const [utterancesText, setUtterancesText] = useState('');
  const [fnName, setFnName] = useState('');
  const [fnDescription, setFnDescription] = useState('');
  const [fnParams, setFnParams] = useState<FunctionParameter[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    if (initialRoute) {
      setName(initialRoute.name);
      setDescription(initialRoute.description);
      setRouteType(initialRoute.routeType);
      setTargetModel(initialRoute.targetModel);
      setScoreThreshold(initialRoute.scoreThreshold);
      setEnabled(initialRoute.enabled);
      setUtterancesText(initialRoute.utterances.join('\n'));
      setFnName(initialRoute.functionSchema?.name ?? `${initialRoute.name}_handler`);
      setFnDescription(initialRoute.functionSchema?.description ?? '');
      setFnParams(initialRoute.functionSchema?.parameters ?? []);
    } else {
      setName('');
      setDescription('');
      setRouteType('static');
      setTargetModel('openai:chatgpt-flagship');
      setScoreThreshold(defaultThreshold);
      setEnabled(true);
      setUtterancesText('');
      setFnName('');
      setFnDescription('');
      setFnParams([
        { name: 'query_param', type: 'string', description: 'Extracted parameter value', required: true },
      ]);
    }
  }, [isOpen, initialRoute, defaultThreshold]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleAddParam = () => {
    setFnParams((prev) => [
      ...prev,
      { name: '', type: 'string', description: '', required: false },
    ]);
  };

  const handleRemoveParam = (index: number) => {
    setFnParams((prev) => prev.filter((_, idx) => idx !== index));
  };

  const handleParamChange = (
    index: number,
    patch: Partial<FunctionParameter>
  ) => {
    setFnParams((prev) =>
      prev.map((item, idx) => (idx === index ? { ...item, ...patch } : item))
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = name.trim();
    const utterances = utterancesText
      .split('\n')
      .map((u) => u.trim())
      .filter(Boolean);

    if (!cleanName) {
      setError('Route name is required.');
      return;
    }
    if (utterances.length === 0) {
      setError('Enter at least one example utterance (one per line).');
      return;
    }

    if (routeType === 'dynamic') {
      const cleanFn = fnName.trim() || `${cleanName}_tool`;
      const validParams = fnParams.filter((p) => p.name.trim().length > 0);
      if (validParams.length === 0) {
        setError('Dynamic routes require at least one named parameter.');
        return;
      }
      setSaving(true);
      try {
        await onSave({
          id: initialRoute?.id,
          name: cleanName,
          description: description.trim(),
          utterances,
          scoreThreshold,
          routeType,
          targetModel: targetModel.trim() || `tool:${cleanFn}`,
          enabled,
          functionSchema: {
            name: cleanFn,
            description: fnDescription.trim() || `Execute ${cleanFn}`,
            parameters: validParams.map((p) => ({ ...p, name: p.name.trim() })),
          },
        });
        onClose();
      } catch (err) {
        setError((err as Error).message || 'Failed to save route.');
      } finally {
        setSaving(false);
      }
      return;
    }

    setSaving(true);
    try {
      await onSave({
        id: initialRoute?.id,
        name: cleanName,
        description: description.trim(),
        utterances,
        scoreThreshold,
        routeType: 'static',
        targetModel: targetModel.trim() || 'openai:chatgpt-flagship',
        enabled,
      });
      onClose();
    } catch (err) {
      setError((err as Error).message || 'Failed to save route.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="route-editor-title"
    >
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-lg">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <h2 id="route-editor-title" className="text-lg font-semibold text-slate-900">
            {initialRoute ? `Edit Route: ${initialRoute.name}` : 'Create Semantic Route'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close route editor"
            className="p-2 text-slate-500 hover:text-slate-900 rounded-md hover:bg-slate-100 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          {error && (
            <div
              role="alert"
              className="px-4 py-3 text-sm text-rose-800 bg-rose-50 border border-rose-200 rounded-md"
            >
              {error}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="route-name-input" className="block text-sm font-medium text-slate-700 mb-1.5">
                Route Name
              </label>
              <input
                id="route-name-input"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., customer_support"
                className="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600"
              />
            </div>

            <div>
              <label htmlFor="route-target-input" className="block text-sm font-medium text-slate-700 mb-1.5">
                Target Handler / Model
              </label>
              <input
                id="route-target-input"
                type="text"
                value={targetModel}
                onChange={(e) => setTargetModel(e.target.value)}
                placeholder="e.g., openai:chatgpt-flagship"
                className="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600"
              />
            </div>
          </div>

          <div>
            <label htmlFor="route-desc-input" className="block text-sm font-medium text-slate-700 mb-1.5">
              Description
            </label>
            <input
              id="route-desc-input"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="When should incoming prompts match this route?"
              className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-center">
            <div>
              <span className="block text-sm font-medium text-slate-700 mb-1.5">Route Type</span>
              <div className="inline-flex p-1 bg-slate-100 rounded-md border border-slate-200">
                <button
                  type="button"
                  onClick={() => setRouteType('static')}
                  className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                    routeType === 'static'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Static Route
                </button>
                <button
                  type="button"
                  onClick={() => setRouteType('dynamic')}
                  className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                    routeType === 'dynamic'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Dynamic Tool Route
                </button>
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label htmlFor="route-threshold-slider" className="text-sm font-medium text-slate-700">
                  Score Threshold
                </label>
                <span className="text-sm font-mono tabular-nums font-semibold text-slate-900">
                  {scoreThreshold.toFixed(2)}
                </span>
              </div>
              <input
                id="route-threshold-slider"
                type="range"
                min={0.1}
                max={0.95}
                step={0.01}
                value={scoreThreshold}
                onChange={(e) => setScoreThreshold(Number(e.target.value))}
                className="w-full accent-blue-600 cursor-pointer"
              />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label htmlFor="route-utterances-input" className="text-sm font-medium text-slate-700">
                Training Utterances (one phrase per line)
              </label>
              <span className="text-xs font-mono tabular-nums text-slate-500">
                {utterancesText.split('\n').filter((l) => l.trim()).length} utterances
              </span>
            </div>
            <textarea
              id="route-utterances-input"
              rows={5}
              value={utterancesText}
              onChange={(e) => setUtterancesText(e.target.value)}
              placeholder={"how do I reset my password?\nI can't sign into my account\nunlock my user profile"}
              className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600"
            />
          </div>

          {routeType === 'dynamic' && (
            <div className="pt-4 border-t border-slate-200 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-900">Function Schema Definition</h3>
                <button
                  type="button"
                  onClick={handleAddParam}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add Parameter
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="fn-name-input" className="block text-xs font-medium text-slate-600 mb-1">
                    Function Name
                  </label>
                  <input
                    id="fn-name-input"
                    type="text"
                    value={fnName}
                    onChange={(e) => setFnName(e.target.value)}
                    placeholder="get_current_time"
                    className="w-full px-3 py-1.5 text-xs font-mono border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
                <div>
                  <label htmlFor="fn-desc-input" className="block text-xs font-medium text-slate-600 mb-1">
                    Function Description
                  </label>
                  <input
                    id="fn-desc-input"
                    type="text"
                    value={fnDescription}
                    onChange={(e) => setFnDescription(e.target.value)}
                    placeholder="Fetch current local time for a location"
                    className="w-full px-3 py-1.5 text-xs border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
              </div>

              <div className="space-y-2">
                {fnParams.map((param, idx) => (
                  <div
                    key={idx}
                    className="grid grid-cols-12 gap-2 items-center p-2.5 bg-slate-50 border border-slate-200 rounded-md"
                  >
                    <input
                      type="text"
                      aria-label={`Parameter ${idx + 1} name`}
                      value={param.name}
                      onChange={(e) => handleParamChange(idx, { name: e.target.value })}
                      placeholder="param_name"
                      className="col-span-3 px-2 py-1 text-xs font-mono bg-white border border-slate-300 rounded"
                    />
                    <select
                      aria-label={`Parameter ${idx + 1} type`}
                      value={param.type}
                      onChange={(e) =>
                        handleParamChange(idx, {
                          type: e.target.value as FunctionParameter['type'],
                        })
                      }
                      className="col-span-2 px-2 py-1 text-xs bg-white border border-slate-300 rounded"
                    >
                      <option value="string">string</option>
                      <option value="number">number</option>
                      <option value="boolean">boolean</option>
                    </select>
                    <input
                      type="text"
                      aria-label={`Parameter ${idx + 1} description`}
                      value={param.description}
                      onChange={(e) => handleParamChange(idx, { description: e.target.value })}
                      placeholder="Description"
                      className="col-span-4 px-2 py-1 text-xs bg-white border border-slate-300 rounded"
                    />
                    <label className="col-span-2 flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={param.required}
                        onChange={(e) => handleParamChange(idx, { required: e.target.checked })}
                        className="rounded border-slate-300 text-blue-600"
                      />
                      Req
                    </label>
                    <button
                      type="button"
                      aria-label={`Remove parameter ${param.name || idx + 1}`}
                      onClick={() => handleRemoveParam(idx)}
                      className="col-span-1 flex justify-center p-1 text-slate-400 hover:text-rose-600"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center justify-between pt-4 border-t border-slate-200">
            <label className="inline-flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                className="rounded border-slate-300 text-blue-600"
              />
              Enable route in active index
            </label>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
              >
                {saving ? 'Saving...' : initialRoute ? 'Save Changes' : 'Create Route'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
