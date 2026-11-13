import React, { useMemo, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import {
  generateCurlSdkCode,
  generatePythonSdkCode,
  generateTypeScriptSdkCode,
} from '../lib/sdkCodeGen';
import type { RouteDefinition, RouterConfig } from '../lib/types';

interface SdkViewProps {
  routes: RouteDefinition[];
  config: RouterConfig;
}

export function SdkView({ routes, config }: SdkViewProps) {
  const [lang, setLang] = useState<'python' | 'typescript' | 'curl'>('python');
  const [copied, setCopied] = useState(false);

  const snippet = useMemo(() => {
    if (lang === 'python') return generatePythonSdkCode(routes, config);
    if (lang === 'typescript') return generateTypeScriptSdkCode(config);
    return generateCurlSdkCode(config);
  }, [lang, routes, config]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard fallback ignored cleanly
    }
  };

  return (
    <div className="space-y-6">
      <section className="bg-white border border-slate-200 rounded-lg p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-5">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">SDK & API Export</h1>
            <p className="text-sm text-slate-600 mt-1">
              Generated directly from your {routes.filter((r) => r.enabled).length} active routes and{' '}
              <span className="font-mono text-slate-800">{config.mode}</span> router settings.
            </p>
          </div>

          <button
            type="button"
            onClick={() => void handleCopy()}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0"
          >
            {copied ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
            {copied ? 'Copied' : 'Copy Snippet'}
          </button>
        </div>

        <div className="flex items-center justify-between gap-3 mb-3">
          <div
            role="group"
            aria-label="SDK language selector"
            className="inline-flex p-1 bg-slate-100 border border-slate-200 rounded-md"
          >
            {(
              [
                { id: 'python', label: 'Python (semantic-router)' },
                { id: 'typescript', label: 'TypeScript (REST)' },
                { id: 'curl', label: 'cURL' },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setLang(tab.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                  lang === tab.id
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <pre className="p-5 text-xs leading-relaxed font-mono text-slate-100 bg-slate-900 rounded-md overflow-x-auto border border-slate-800">
          <code>{snippet}</code>
        </pre>
      </section>
    </div>
  );
}
