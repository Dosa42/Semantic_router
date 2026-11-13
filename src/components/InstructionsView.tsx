import React, { useEffect, useMemo, useState } from 'react';
import {
  Bot,
  Cpu,
  Pencil,
  RefreshCw,
  RotateCcw,
  Save,
} from 'lucide-react';
import { formatEmbeddingText, resolveChatGptSystemPrompt } from '../lib/instructions';
import type {
  RouteDefinition,
  RouterConfig,
  SystemInstructionsConfig,
} from '../lib/types';

interface InstructionsViewProps {
  instructions: SystemInstructionsConfig;
  config: RouterConfig;
  routes: RouteDefinition[];
  onSaveInstructions: (next: SystemInstructionsConfig) => Promise<void>;
  onResetInstructions: () => Promise<void>;
  onRewarmEmbeddings: () => Promise<void>;
  onEditRoute: (route: RouteDefinition) => void;
}

export function InstructionsView({
  instructions,
  config,
  routes,
  onSaveInstructions,
  onResetInstructions,
  onRewarmEmbeddings,
  onEditRoute,
}: InstructionsViewProps) {
  const [draft, setDraft] = useState<SystemInstructionsConfig>(instructions);
  const [sampleText, setSampleText] = useState(
    'Write a PostgreSQL query using window functions to rank top customers.'
  );
  const [saving, setSaving] = useState(false);
  const [rewarming, setRewarming] = useState(false);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  useEffect(() => {
    setDraft(instructions);
  }, [instructions]);

  const previewQueryVectorInput = useMemo(
    () => formatEmbeddingText(sampleText, 'query', draft.embedding),
    [sampleText, draft.embedding]
  );

  const previewPassageVectorInput = useMemo(
    () =>
      formatEmbeddingText(
        'join orders and users tables in PostgreSQL to calculate retention',
        'passage',
        draft.embedding
      ),
    [draft.embedding]
  );

  const previewChatGptPrompt = useMemo(
    () =>
      resolveChatGptSystemPrompt(draft.chatgpt, {
        ragMatches: [
          {
            chunkId: 'preview-1',
            connectorId: 'preview-conn',
            connectorName: 'RAG Architecture Feed',
            sourceUrl: 'https://docs.example.com/rag',
            text: 'Composite B-Tree indexes order equality predicates before range columns.',
            score: 0.842,
            denseScore: 0.88,
            sparseScore: 0.74,
          },
        ],
      }),
    [draft.chatgpt]
  );

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSavedNotice(null);
    try {
      await onSaveInstructions(draft);
      setSavedNotice('System instructions saved and synced to router & MCP engine.');
      window.setTimeout(() => setSavedNotice(null), 3000);
    } finally {
      setSaving(false);
    }
  };

  const handleRewarm = async () => {
    setRewarming(true);
    try {
      await onRewarmEmbeddings();
    } finally {
      setRewarming(false);
    }
  };

  return (
    <div className="space-y-6">
      <form onSubmit={handleSave} className="space-y-6">
        {/* Header Action Strip */}
        <section className="bg-white border border-slate-200 rounded-lg p-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">
              Dual System Instructions
            </h1>
            <p className="text-sm text-slate-600 mt-1">
              Configure instruction templates for the{' '}
              <span className="font-mono text-slate-800">{config.encoderModel}</span> Embedding
              LM alongside system prompts for the ChatGPT AI dispatch layer.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={() => void handleRewarm()}
              disabled={rewarming}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${rewarming ? 'animate-spin' : ''}`} />
              {rewarming ? 'Re-warming...' : 'Re-warm Embeddings'}
            </button>
            <button
              type="button"
              onClick={() => void onResetInstructions()}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reset Defaults
            </button>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              <Save className="w-3.5 h-3.5" />
              {saving ? 'Saving...' : 'Save Instructions'}
            </button>
          </div>
        </section>

        {savedNotice && (
          <div
            role="status"
            className="px-4 py-3 text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-md"
          >
            {savedNotice}
          </div>
        )}

        {/* Dual Column Workbench: Embedding LM (Left) + ChatGPT AI (Right) */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
          {/* Left: Embedding LM Instructions */}
          <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
            <div className="flex items-center justify-between gap-2 pb-3 border-b border-slate-200">
              <div className="flex items-center gap-2">
                <Cpu className="w-4 h-4 text-blue-600" />
                <h2 className="text-base font-semibold text-slate-900">
                  Embedding LM Instructions
                </h2>
              </div>
              <span className="text-xs font-mono text-slate-500">
                {config.encoderModel}
              </span>
            </div>

            <div className="space-y-3">
              <div>
                <label
                  htmlFor="emb-query-template"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Query Instruction Template
                </label>
                <input
                  id="emb-query-template"
                  type="text"
                  value={draft.embedding.queryTemplate}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      embedding: { ...prev.embedding, queryTemplate: e.target.value },
                    }))
                  }
                  placeholder="query: {instruction}{context}{text}"
                  className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-300 rounded-md focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
                <p className="text-[11px] text-slate-500 mt-1">
                  Tokens: <span className="font-mono">{'{instruction}'}</span>,{' '}
                  <span className="font-mono">{'{context}'}</span>,{' '}
                  <span className="font-mono">{'{text}'}</span>
                </p>
              </div>

              <div>
                <label
                  htmlFor="emb-passage-template"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Passage &amp; RAG Chunk Template
                </label>
                <input
                  id="emb-passage-template"
                  type="text"
                  value={draft.embedding.passageTemplate}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      embedding: { ...prev.embedding, passageTemplate: e.target.value },
                    }))
                  }
                  placeholder="passage: {context}{text}"
                  className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-300 rounded-md focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div>
                <label
                  htmlFor="emb-task-instruction"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Global Task Instruction Prefix (Optional)
                </label>
                <textarea
                  id="emb-task-instruction"
                  rows={2}
                  value={draft.embedding.taskInstruction}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      embedding: { ...prev.embedding, taskInstruction: e.target.value },
                    }))
                  }
                  placeholder="e.g., Instruct: Classify user intent into semantic routes."
                  className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-300 rounded-md focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
                <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={draft.embedding.stripExtraWhitespace}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        embedding: {
                          ...prev.embedding,
                          stripExtraWhitespace: e.target.checked,
                        },
                      }))
                    }
                    className="rounded border-slate-300 text-blue-600"
                  />
                  Collapse whitespace
                </label>

                <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={draft.embedding.lowercaseInput}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        embedding: {
                          ...prev.embedding,
                          lowercaseInput: e.target.checked,
                        },
                      }))
                    }
                    className="rounded border-slate-300 text-blue-600"
                  />
                  Lowercase input
                </label>

                <div>
                  <label
                    htmlFor="emb-max-chars"
                    className="block text-[11px] text-slate-600 mb-0.5"
                  >
                    Max Chars
                  </label>
                  <input
                    id="emb-max-chars"
                    type="number"
                    min={64}
                    max={4096}
                    value={draft.embedding.maxChars}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        embedding: {
                          ...prev.embedding,
                          maxChars: Number(e.target.value) || 512,
                        },
                      }))
                    }
                    className="w-full px-2 py-1 text-xs font-mono tabular-nums bg-slate-50 border border-slate-300 rounded"
                  />
                </div>
              </div>
            </div>

            {/* Live Embedding Render Preview */}
            <div className="pt-4 border-t border-slate-200 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-800">
                  Live EmbeddingsBridge Payload Preview
                </span>
              </div>
              <input
                type="text"
                aria-label="Sample prompt for embedding preview"
                value={sampleText}
                onChange={(e) => setSampleText(e.target.value)}
                className="w-full px-2.5 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded"
              />
              <div className="space-y-1.5 font-mono text-[11px]">
                <div className="p-2.5 bg-slate-900 text-slate-100 rounded border border-slate-800 break-all">
                  <span className="text-sky-400 mr-2">[QUERY]</span>
                  {previewQueryVectorInput}
                </div>
                <div className="p-2.5 bg-slate-900 text-slate-100 rounded border border-slate-800 break-all">
                  <span className="text-emerald-400 mr-2">[PASSAGE]</span>
                  {previewPassageVectorInput}
                </div>
              </div>
            </div>
          </section>

          {/* Right: ChatGPT AI Instructions */}
          <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
            <div className="flex items-center justify-between gap-2 pb-3 border-b border-slate-200">
              <div className="flex items-center gap-2">
                <Bot className="w-4 h-4 text-blue-600" />
                <h2 className="text-base font-semibold text-slate-900">
                  ChatGPT AI System Instructions
                </h2>
              </div>
              <span className="text-xs font-mono text-slate-500">
                Responses API :443
              </span>
            </div>

            <div className="space-y-3">
              <div>
                <label
                  htmlFor="gpt-response-prompt"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Primary Response System Prompt
                </label>
                <textarea
                  id="gpt-response-prompt"
                  rows={3}
                  value={draft.chatgpt.responseSystemPrompt}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      chatgpt: { ...prev.chatgpt, responseSystemPrompt: e.target.value },
                    }))
                  }
                  className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-300 rounded-md focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div>
                <label
                  htmlFor="gpt-extraction-prompt"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Dynamic Tool Parameter Extraction Prompt
                </label>
                <textarea
                  id="gpt-extraction-prompt"
                  rows={2}
                  value={draft.chatgpt.extractionSystemPrompt}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      chatgpt: { ...prev.chatgpt, extractionSystemPrompt: e.target.value },
                    }))
                  }
                  className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-300 rounded-md focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div>
                <label
                  htmlFor="gpt-rag-template"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  RAG Context Injection Wrapper
                </label>
                <textarea
                  id="gpt-rag-template"
                  rows={2}
                  value={draft.chatgpt.ragContextTemplate}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      chatgpt: { ...prev.chatgpt, ragContextTemplate: e.target.value },
                    }))
                  }
                  className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-300 rounded-md focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div className="flex flex-wrap items-center gap-6 pt-1">
                <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={draft.chatgpt.enforceCitations}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        chatgpt: { ...prev.chatgpt, enforceCitations: e.target.checked },
                      }))
                    }
                    className="rounded border-slate-300 text-blue-600"
                  />
                  Enforce RAG source citations ([1], [2])
                </label>

                <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={draft.chatgpt.conciseMode}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        chatgpt: { ...prev.chatgpt, conciseMode: e.target.checked },
                      }))
                    }
                    className="rounded border-slate-300 text-blue-600"
                  />
                  Concise output constraint
                </label>
              </div>
            </div>

            <div className="pt-4 border-t border-slate-200 space-y-1.5">
              <div className="text-xs font-semibold text-slate-800">
                Resolved ChatGPT Instructions Preview (with RAG)
              </div>
              <pre className="p-3 bg-slate-900 text-slate-100 rounded border border-slate-800 font-mono text-[11px] whitespace-pre-wrap max-h-44 overflow-y-auto">
                {previewChatGptPrompt}
              </pre>
            </div>
          </section>
        </div>
      </form>

      {/* Per-Route System Instruction Overrides Matrix */}
      <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Per-Route Instruction Overrides
            </h2>
            <p className="text-xs text-slate-600 mt-0.5">
              Routes may override the global Embedding LM context prefix or ChatGPT AI system
              prompt when matched.
            </p>
          </div>
          <span className="text-xs font-mono tabular-nums text-slate-500">
            {
              routes.filter(
                (r) =>
                  r.instructionOverrides?.embeddingContextPrefix ||
                  r.instructionOverrides?.chatgptSystemInstruction
              ).length
            }{' '}
            / {routes.length} customized
          </span>
        </div>

        <div className="overflow-x-auto border border-slate-200 rounded-md">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                <th className="py-2.5 px-4 font-semibold">Route</th>
                <th className="py-2.5 px-4 font-semibold">Embedding LM Override</th>
                <th className="py-2.5 px-4 font-semibold">ChatGPT AI Override</th>
                <th className="py-2.5 px-4 text-right font-semibold">Edit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {routes.map((route) => (
                <tr key={route.id} className="hover:bg-slate-50">
                  <td className="py-2.5 px-4 font-mono font-semibold text-slate-900 whitespace-nowrap">
                    {route.name}
                    <div className="text-[11px] font-sans font-normal text-slate-500">
                      {route.targetModel}
                    </div>
                  </td>
                  <td className="py-2.5 px-4 font-mono text-slate-700 max-w-xs truncate">
                    {route.instructionOverrides?.embeddingContextPrefix || (
                      <span className="text-slate-400 font-sans">Inherits global</span>
                    )}
                  </td>
                  <td className="py-2.5 px-4 text-slate-700 max-w-md truncate">
                    {route.instructionOverrides?.chatgptSystemInstruction || (
                      <span className="text-slate-400">Inherits global</span>
                    )}
                  </td>
                  <td className="py-2.5 px-4 text-right whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => onEditRoute(route)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded transition-colors whitespace-nowrap shrink-0"
                    >
                      <Pencil className="w-3 h-3" />
                      Override
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
