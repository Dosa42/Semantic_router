import React, { useEffect, useId, useState } from 'react';
import mermaid from 'mermaid';
import { Check, Copy, ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';

let mermaidInitialized = false;

function ensureMermaidInitialized() {
  if (mermaidInitialized) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: 'base',
    securityLevel: 'loose',
    fontFamily: '"DM Sans", "Plus Jakarta Sans", system-ui, sans-serif',
    flowchart: {
      curve: 'basis',
      htmlLabels: true,
      useMaxWidth: true,
      nodeSpacing: 26,
      rankSpacing: 42,
      padding: 12,
    },
    themeVariables: {
      primaryColor: '#eff6ff',
      primaryBorderColor: '#1d4ed8',
      primaryTextColor: '#0f172a',
      secondaryColor: '#ecfdf5',
      tertiaryColor: '#f8fafc',
      lineColor: '#475569',
      edgeLabelBackground: '#ffffff',
      clusterBkg: '#f8fafc',
      clusterBorder: '#cbd5e1',
      fontSize: '12px',
    },
  });
  mermaidInitialized = true;
}

interface MermaidDiagramProps {
  code: string;
  title: string;
  editable?: boolean;
  onChangeCode?: (nextCode: string) => void;
}

export function MermaidDiagram({
  code,
  title,
  editable = false,
  onChangeCode,
}: MermaidDiagramProps) {
  const reactId = useId();
  const safeId = `mmd_${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const [viewMode, setViewMode] = useState<'diagram' | 'source'>('diagram');
  const [svgHtml, setSvgHtml] = useState<string>('');
  const [renderError, setRenderError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number>(100);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    if (viewMode !== 'diagram') return undefined;

    const renderDiagram = async () => {
      try {
        ensureMermaidInitialized();
        const renderKey = `${safeId}_${Date.now()}`;
        const { svg } = await mermaid.render(renderKey, code);
        if (active) {
          setSvgHtml(svg);
          setRenderError(null);
        }
      } catch (err) {
        if (active) {
          setRenderError((err as Error).message || 'Failed to render Mermaid diagram');
        }
      }
    };

    void renderDiagram();
    return () => {
      active = false;
    };
  }, [code, safeId, viewMode]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard blocked in restricted frame
    }
  };

  return (
    <div className="flex flex-col flex-1 border border-slate-200 rounded-md bg-white overflow-hidden">
      {/* Diagram Toolbar */}
      <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
        <div
          role="group"
          aria-label={`${title} view mode`}
          className="inline-flex items-center p-0.5 bg-slate-200/70 rounded-md"
        >
          <button
            type="button"
            onClick={() => setViewMode('diagram')}
            className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
              viewMode === 'diagram'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Mermaid SVG
          </button>
          <button
            type="button"
            onClick={() => setViewMode('source')}
            className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
              viewMode === 'source'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {editable ? 'Edit .mmd' : 'Source .mmd'}
          </button>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {viewMode === 'diagram' && (
            <div className="inline-flex items-center border border-slate-200 bg-white rounded-md">
              <button
                type="button"
                onClick={() => setZoom((z) => Math.max(70, z - 15))}
                aria-label="Zoom out diagram"
                className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-50"
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
              <span className="px-2 text-[11px] font-mono tabular-nums text-slate-700 border-x border-slate-200">
                {zoom}%
              </span>
              <button
                type="button"
                onClick={() => setZoom((z) => Math.min(180, z + 15))}
                aria-label="Zoom in diagram"
                className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-50"
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
              {zoom !== 100 && (
                <button
                  type="button"
                  onClick={() => setZoom(100)}
                  aria-label="Reset zoom"
                  className="p-1.5 text-slate-500 hover:text-slate-900 border-l border-slate-200"
                >
                  <RotateCcw className="w-3 h-3" />
                </button>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={() => void handleCopy()}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0"
          >
            {copied ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-600" />
                Copied
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                Copy .mmd
              </>
            )}
          </button>
        </div>
      </div>

      {/* Viewport */}
      {viewMode === 'diagram' ? (
        <div className="flex-1 overflow-auto bg-slate-50/40 p-4 min-h-[540px] max-h-[740px]">
          {renderError ? (
            <div className="p-4 text-xs text-rose-800 bg-rose-50 border border-rose-200 rounded-md font-mono whitespace-pre-wrap">
              Mermaid syntax error: {renderError}
            </div>
          ) : (
            <div
              className="origin-top-left transition-transform duration-150"
              style={{
                width: `${zoom}%`,
                minWidth: zoom > 100 ? `${zoom}%` : '100%',
              }}
              aria-label={`${title} Mermaid Architecture Diagram`}
              dangerouslySetInnerHTML={{ __html: svgHtml }}
            />
          )}
        </div>
      ) : (
        <div className="flex-1 flex flex-col bg-slate-950 text-slate-100 min-h-[540px] max-h-[740px]">
          {editable && onChangeCode ? (
            <textarea
              value={code}
              onChange={(e) => onChangeCode(e.target.value)}
              spellCheck={false}
              aria-label={`${title} Mermaid source editor`}
              className="flex-1 w-full p-4 text-xs font-mono leading-relaxed bg-slate-950 text-slate-100 focus:outline-none resize-none"
            />
          ) : (
            <pre className="flex-1 p-4 text-xs font-mono leading-relaxed overflow-auto text-slate-200">
              <code>{code}</code>
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
