import React, { useEffect, useState } from 'react';
import {
  BookOpen,
  ChevronDown,
  ChevronUp,
  Download,
  Pencil,
  RotateCcw,
  Save,
  Table2,
} from 'lucide-react';
import { buildLibraryKnowledgeMarkdown } from '../lib/architectureBlueprints';
import type { LibraryKnowledgeState } from '../lib/types';
import { MermaidDiagram } from './MermaidDiagram';

interface ArchitectureBlueprintDrawerProps {
  knowledge: LibraryKnowledgeState;
  onSaveKnowledge: (next: Partial<LibraryKnowledgeState>) => Promise<void>;
  onResetKnowledge: () => Promise<void>;
}

const STORAGE_OPEN_KEY = 'sr_arch_blueprint_open';

export function ArchitectureBlueprintDrawer({
  knowledge,
  onSaveKnowledge,
  onResetKnowledge,
}: ArchitectureBlueprintDrawerProps) {
  const [isOpen, setIsOpen] = useState<boolean>(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_OPEN_KEY);
      return saved === null ? true : saved === 'true';
    } catch {
      return true;
    }
  });
  const [showMatrix, setShowMatrix] = useState(true);
  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState<LibraryKnowledgeState>(knowledge);
  const [saving, setSaving] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);

  useEffect(() => {
    setDraft(knowledge);
  }, [knowledge]);

  const toggleOpen = () => {
    const next = !isOpen;
    setIsOpen(next);
    try {
      window.localStorage.setItem(STORAGE_OPEN_KEY, String(next));
    } catch {
      // Ignore storage errors
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveNotice(null);
    try {
      await onSaveKnowledge({
        notes: draft.notes,
        blueprints: draft.blueprints,
      });
      setSaveNotice('Saved to library knowledge');
      setEditMode(false);
      setTimeout(() => setSaveNotice(null), 2400);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setSaving(true);
    setSaveNotice(null);
    try {
      await onResetKnowledge();
      setEditMode(false);
      setSaveNotice('Restored default blueprints');
      setTimeout(() => setSaveNotice(null), 2400);
    } finally {
      setSaving(false);
    }
  };

  const handleExportMarkdown = () => {
    const md = buildLibraryKnowledgeMarkdown(draft);
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'architecture-blueprints-library.md';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const updateBlueprintCode = (index: 0 | 1, code: string) => {
    setDraft((prev) => {
      const nextBlueprints: LibraryKnowledgeState['blueprints'] = [
        index === 0 ? { ...prev.blueprints[0], mermaidCode: code } : prev.blueprints[0],
        index === 1 ? { ...prev.blueprints[1], mermaidCode: code } : prev.blueprints[1],
      ];
      return { ...prev, blueprints: nextBlueprints };
    });
  };

  const [leftBlueprint, rightBlueprint] = draft.blueprints;

  return (
    <section
      aria-label="Architecture Blueprints and Library Knowledge"
      className="mt-6 bg-white border border-slate-200 rounded-lg overflow-hidden"
    >
      {/* Collapsible Window Header Bar */}
      <div className="px-5 py-3.5 bg-slate-50/90 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={toggleOpen}
          aria-expanded={isOpen}
          className="flex items-center gap-2.5 text-left min-w-0 group focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded"
        >
          <BookOpen className="w-4 h-4 text-blue-600 shrink-0" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-slate-900 group-hover:text-blue-700 transition-colors">
              Architecture Blueprints &amp; Library Knowledge
            </h2>
            <p className="text-xs text-slate-500 truncate">
              {leftBlueprint.title} · {rightBlueprint.title} · Saved{' '}
              <span className="font-mono tabular-nums">
                {new Date(knowledge.updatedAt).toLocaleTimeString([], {
                  hour12: false,
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            </p>
          </div>
        </button>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {saveNotice && (
            <span className="text-xs font-medium text-emerald-700 mr-1 whitespace-nowrap">
              {saveNotice}
            </span>
          )}

          {isOpen && (
            <>
              <button
                type="button"
                onClick={() => setShowMatrix((v) => !v)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  showMatrix
                    ? 'bg-blue-50 text-blue-700 border-blue-200'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                }`}
              >
                <Table2 className="w-3.5 h-3.5" />
                Comparison Matrix
              </button>

              {editMode ? (
                <>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void handleSave()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
                  >
                    <Save className="w-3.5 h-3.5" />
                    {saving ? 'Saving...' : 'Save Library'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDraft(knowledge);
                      setEditMode(false);
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setEditMode(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0"
                >
                  <Pencil className="w-3.5 h-3.5" />
                  Edit Knowledge
                </button>
              )}

              <button
                type="button"
                disabled={saving}
                onClick={() => void handleReset()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Reset
              </button>

              <button
                type="button"
                onClick={handleExportMarkdown}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0"
              >
                <Download className="w-3.5 h-3.5" />
                Export .md
              </button>
            </>
          )}

          <button
            type="button"
            onClick={toggleOpen}
            aria-expanded={isOpen}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-800 bg-white border border-slate-300 hover:bg-slate-100 rounded-md transition-colors whitespace-nowrap shrink-0"
          >
            {isOpen ? (
              <>
                <ChevronDown className="w-3.5 h-3.5" />
                Collapse Window
              </>
            ) : (
              <>
                <ChevronUp className="w-3.5 h-3.5" />
                Expand Blueprints
              </>
            )}
          </button>
        </div>
      </div>

      {isOpen && (
        <div className="p-5 space-y-6">
          {/* Shared Color Key & Library Notes */}
          <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4 pb-4 border-b border-slate-200">
            <div className="flex-1 min-w-0">
              <div className="text-xs font-semibold text-slate-700 mb-1">
                Library Knowledge Summary
              </div>
              {editMode ? (
                <textarea
                  rows={2}
                  value={draft.notes}
                  onChange={(e) => setDraft((prev) => ({ ...prev, notes: e.target.value }))}
                  className="w-full px-3 py-2 text-xs text-slate-800 bg-slate-50 border border-slate-300 rounded-md focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              ) : (
                <p className="text-xs text-slate-600 leading-relaxed max-w-4xl">{draft.notes}</p>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-4 text-xs text-slate-600 shrink-0">
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                <span className="w-2.5 h-2.5 rounded-xs bg-slate-100 border border-slate-600" />
                Ingress &amp; Framing
              </span>
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                <span className="w-2.5 h-2.5 rounded-xs bg-blue-50 border border-blue-700" />
                Shared Semantic Core (384d)
              </span>
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                <span className="w-2.5 h-2.5 rounded-xs bg-emerald-50 border border-emerald-700" />
                RAG &amp; Storage Tier
              </span>
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                <span className="w-2.5 h-2.5 rounded-xs bg-amber-50 border border-amber-700" />
                Governance, Auth &amp; Security
              </span>
            </div>
          </div>

          {/* Side-by-Side Mermaid Blueprints */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-stretch">
            {/* Side A */}
            <div className="flex flex-col space-y-2.5 min-w-0">
              <div>
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-sm font-semibold text-slate-900">
                    Side A · {leftBlueprint.title}
                  </h3>
                  <span className="text-[11px] font-mono text-slate-500 truncate">
                    /app/applet
                  </span>
                </div>
                <p className="text-xs text-slate-600 mt-0.5">{leftBlueprint.summary}</p>
                <div className="mt-1.5 text-[11px] font-mono text-slate-500 truncate">
                  {leftBlueprint.portsAndProtocols.join(' · ')}
                </div>
              </div>

              <MermaidDiagram
                title={leftBlueprint.title}
                code={leftBlueprint.mermaidCode}
                editable={editMode}
                onChangeCode={(next) => updateBlueprintCode(0, next)}
              />
            </div>

            {/* Side B */}
            <div className="flex flex-col space-y-2.5 min-w-0">
              <div>
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-sm font-semibold text-slate-900">
                    Side B · {rightBlueprint.title}
                  </h3>
                  <span className="text-[11px] font-mono text-slate-500 truncate">
                    Torrent-rag-uagl.zip
                  </span>
                </div>
                <p className="text-xs text-slate-600 mt-0.5">{rightBlueprint.summary}</p>
                <div className="mt-1.5 text-[11px] font-mono text-slate-500 truncate">
                  {rightBlueprint.portsAndProtocols.join(' · ')}
                </div>
              </div>

              <MermaidDiagram
                title={rightBlueprint.title}
                code={rightBlueprint.mermaidCode}
                editable={editMode}
                onChangeCode={(next) => updateBlueprintCode(1, next)}
              />
            </div>
          </div>

          {/* Shared Architecture vs. Differences Comparison Matrix */}
          {showMatrix && (
            <div className="pt-2 border-t border-slate-200">
              <div className="flex items-baseline justify-between gap-2 mb-3">
                <h3 className="text-sm font-semibold text-slate-900">
                  Shared Architecture &amp; Divergence Blueprint Matrix
                </h3>
                <span className="text-xs text-slate-500 font-mono tabular-nums">
                  {draft.comparisonMatrix.length} architectural axes
                </span>
              </div>

              <div className="overflow-x-auto border border-slate-200 rounded-md">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-slate-700 font-semibold">
                      <th className="py-2.5 px-3 w-44">Dimension</th>
                      <th className="py-2.5 px-3">{leftBlueprint.title}</th>
                      <th className="py-2.5 px-3">{rightBlueprint.title}</th>
                      <th className="py-2.5 px-3 bg-blue-50/40 text-blue-950">
                        Shared Architecture / Bridge
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {draft.comparisonMatrix.map((row) => (
                      <tr key={row.dimension} className="hover:bg-slate-50/70 align-top">
                        <td className="py-2.5 px-3 font-medium text-slate-900 whitespace-nowrap">
                          {row.dimension}
                        </td>
                        <td className="py-2.5 px-3 text-slate-700 leading-relaxed">
                          {row.semanticRouterStudio}
                        </td>
                        <td className="py-2.5 px-3 text-slate-700 leading-relaxed">
                          {row.torrentRagUagl}
                        </td>
                        <td className="py-2.5 px-3 text-slate-800 bg-blue-50/20 leading-relaxed">
                          {row.sharedPattern}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
