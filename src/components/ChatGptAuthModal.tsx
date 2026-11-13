import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  KeyRound,
  LogOut,
  Plus,
  RefreshCw,
  ShieldCheck,
  Terminal,
  UserCheck,
  X,
} from 'lucide-react';
import type {
  AuthorizePreviewResult,
  ChatGptModelInfo,
  ChatGptSessionState,
  DeviceAuthPollResult,
  DeviceAuthSessionInfo,
  OpenAiFlowMode,
} from '../lib/types';

interface ChatGptAuthModalProps {
  isOpen: boolean;
  session: ChatGptSessionState | null;
  onClose: () => void;
  onSessionChange: () => Promise<void>;
}

const FLOW_TABS: Array<{ id: OpenAiFlowMode; label: string; subtitle: string }> = [
  {
    id: 'dynamic_agent',
    label: 'Dynamic Agent PKCE',
    subtitle: 'dynamic_agent_client + 127.0.0.1 + plan usage',
  },
  {
    id: 'device_code',
    label: 'Device Code Login',
    subtitle: 'One-time code on OpenAI device verification page',
  },
  {
    id: 'website_client',
    label: 'Website oaiapp_ Client',
    subtitle: 'Hosted /auth/openai/callback with client_id',
  },
];

export function ChatGptAuthModal({
  isOpen,
  session,
  onClose,
  onSessionChange,
}: ChatGptAuthModalProps) {
  const [flowMode, setFlowMode] = useState<OpenAiFlowMode>('dynamic_agent');
  const [clientIdOverride, setClientIdOverride] = useState('');
  const [debuggerOpen, setDebuggerOpen] = useState(true);
  const [preview, setPreview] = useState<AuthorizePreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const [pendingAuthUrl, setPendingAuthUrl] = useState<string | null>(null);
  const [pendingRedirectUri, setPendingRedirectUri] = useState<string | null>(null);
  const [redirectPasteUrl, setRedirectPasteUrl] = useState('');

  const [deviceSession, setDeviceSession] = useState<DeviceAuthSessionInfo | null>(null);
  const [devicePolling, setDevicePolling] = useState(false);
  const [deviceSecondsLeft, setDeviceSecondsLeft] = useState(0);
  const pollTimerRef = useRef<number | null>(null);

  const [loadingAuth, setLoadingAuth] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyOutput, setVerifyOutput] = useState<string | null>(null);
  const [models, setModels] = useState<ChatGptModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !session) return;
    setFlowMode(session.defaultFlowMode);
    setError(null);
    setVerifyOutput(null);
    if (session.activeProfile?.sharing) {
      void loadModels();
    } else {
      setModels([]);
    }
  }, [isOpen, session]);

  useEffect(() => {
    if (!isOpen) {
      if (pollTimerRef.current !== null) {
        window.clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      setDevicePolling(false);
      return;
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setPreviewLoading(true);
      try {
        const res = await fetch('/api/auth/openai/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            flowMode,
            clientIdOverride: clientIdOverride.trim() || null,
          }),
        });
        if (res.ok && !cancelled) {
          const data = (await res.json()) as AuthorizePreviewResult;
          setPreview(data);
        }
      } catch {
        // Non-fatal debugger preview failure
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [isOpen, flowMode, clientIdOverride, session?.activeProfileId]);

  useEffect(() => {
    if (!deviceSession) {
      setDeviceSecondsLeft(0);
      return;
    }
    const updateTick = () => {
      const remaining = Math.max(0, Math.floor((deviceSession.expiresAt - Date.now()) / 1000));
      setDeviceSecondsLeft(remaining);
    };
    updateTick();
    const id = window.setInterval(updateTick, 1000);
    return () => window.clearInterval(id);
  }, [deviceSession]);

  const copyText = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey((prev) => (prev === key ? null : prev)), 1500);
    } catch {
      // Clipboard blocked in headless frames
    }
  };

  const loadModels = async () => {
    setModelsLoading(true);
    try {
      const res = await fetch('/api/auth/openai/models');
      const data = (await res.json()) as { models?: ChatGptModelInfo[]; error?: string };
      if (res.ok && Array.isArray(data.models)) {
        setModels(data.models);
      }
    } finally {
      setModelsLoading(false);
    }
  };

  if (!isOpen) return null;

  const stopDevicePolling = () => {
    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    setDevicePolling(false);
  };

  const scheduleDevicePoll = (deviceAuthId: string, intervalSec: number) => {
    pollTimerRef.current = window.setTimeout(async () => {
      try {
        const res = await fetch('/api/auth/openai/device/poll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceAuthId }),
        });
        const data = (await res.json()) as DeviceAuthPollResult;
        if (data.status === 'authorized') {
          stopDevicePolling();
          setDeviceSession(null);
          await onSessionChange();
          return;
        }
        if (data.status === 'pending') {
          scheduleDevicePoll(deviceAuthId, data.intervalSec ?? intervalSec);
          return;
        }
        stopDevicePolling();
        setError(data.error || 'Device code verification ended.');
      } catch (err) {
        stopDevicePolling();
        setError((err as Error).message || 'Device polling failed.');
      }
    }, Math.max(3, intervalSec) * 1000);
  };

  const handleStartDeviceAuth = async () => {
    setError(null);
    stopDevicePolling();
    setLoadingAuth(true);
    try {
      const res = await fetch('/api/auth/openai/device/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientIdOverride: clientIdOverride.trim() || null,
        }),
      });
      const data = (await res.json()) as DeviceAuthSessionInfo & { error?: string };
      if (!res.ok || !data.deviceAuthId || !data.userCode) {
        throw new Error(data.error || 'Could not generate OpenAI device code.');
      }
      setDeviceSession(data);
      setDevicePolling(true);
      scheduleDevicePoll(data.deviceAuthId, data.intervalSec);
    } catch (err) {
      setError((err as Error).message || 'Device authorization failed to start.');
    } finally {
      setLoadingAuth(false);
    }
  };

  const startSignIn = async (profileId: string | null = null) => {
    if (flowMode === 'device_code' && !profileId) {
      await handleStartDeviceAuth();
      return;
    }

    setError(null);
    setLoadingAuth(true);
    try {
      const effectiveFlow: OpenAiFlowMode =
        flowMode === 'device_code' ? 'dynamic_agent' : flowMode;
      const res = await fetch('/api/auth/openai/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          flowMode: effectiveFlow,
          profileId,
          clientIdOverride: clientIdOverride.trim() || null,
          useLoopback: effectiveFlow === 'dynamic_agent',
        }),
      });
      const data = (await res.json()) as {
        authUrl?: string;
        redirectUri?: string;
        preview?: AuthorizePreviewResult;
        error?: string;
      };
      if (!res.ok || !data.authUrl) {
        throw new Error(data.error || 'Failed to initiate Sign in with ChatGPT.');
      }

      setPendingAuthUrl(data.authUrl);
      setPendingRedirectUri(data.redirectUri ?? null);
      if (data.preview) {
        setPreview(data.preview);
      }

      const popup = window.open(
        data.authUrl,
        'chatgpt_oauth_popup',
        'width=600,height=720,resizable=yes,scrollbars=yes'
      );
      if (!popup) {
        setError(
          'Popup was blocked by your browser. Allow popups or open the authorization link below directly.'
        );
      }
    } catch (err) {
      setError((err as Error).message || 'Could not start OpenAI OAuth flow.');
    } finally {
      setLoadingAuth(false);
    }
  };

  const handleCompleteRedirectUrl = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!redirectPasteUrl.trim()) return;
    setError(null);
    setLoadingAuth(true);
    try {
      const res = await fetch('/api/auth/openai/complete-redirect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirectUrl: redirectPasteUrl.trim() }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Callback exchange failed.');
      }
      setRedirectPasteUrl('');
      setPendingAuthUrl(null);
      await onSessionChange();
    } catch (err) {
      setError((err as Error).message || 'Failed to exchange authorization code.');
    } finally {
      setLoadingAuth(false);
    }
  };

  const handleSelectProfile = async (profileId: string) => {
    setError(null);
    const res = await fetch('/api/auth/openai/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId }),
    });
    if (res.ok) {
      await onSessionChange();
    }
  };

  const handleLogout = async (profileId?: string, removeProfile = false) => {
    setError(null);
    await fetch('/api/auth/openai/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId, removeProfile }),
    });
    setVerifyOutput(null);
    setModels([]);
    await onSessionChange();
  };

  const handleVerifyPlanUsage = async () => {
    setError(null);
    setVerifyOutput(null);
    setVerifying(true);
    try {
      const res = await fetch('/api/auth/openai/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        model?: string;
        text?: string;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Token sharing verification failed.');
      }
      setVerifyOutput(`${data.model}: ${data.text}`);
    } catch (err) {
      setError((err as Error).message || 'Verification failed.');
    } finally {
      setVerifying(false);
    }
  };

  const active = session?.activeProfile ?? null;
  const profiles = session?.profiles ?? [];
  const effectiveWebsiteClient =
    clientIdOverride.trim() || session?.configuredClientId || null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="chatgpt-auth-title"
    >
      <div className="w-full max-w-3xl max-h-[92vh] overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-lg">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <div>
            <h2 id="chatgpt-auth-title" className="text-lg font-semibold text-slate-900">
              Sign in with ChatGPT
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              OpenAI OAuth 2.0 PKCE (S256), Device Code Flow &amp; OIDC JWKS Verification
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close ChatGPT account dialog"
            className="p-2 text-slate-500 hover:text-slate-900 rounded-md hover:bg-slate-100 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          {error && (
            <div
              role="alert"
              className="px-4 py-3 text-sm text-rose-800 bg-rose-50 border border-rose-200 rounded-md"
            >
              {error}
            </div>
          )}

          {/* Active Connected Profile Card */}
          {active && active.connected ? (
            <div className="p-4 bg-slate-50 border border-slate-200 rounded-md space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2 text-xs font-medium text-emerald-700">
                    <CheckCircle2 className="w-4 h-4" />
                    Connected to ChatGPT
                  </div>
                  <div className="text-sm font-semibold text-slate-900">
                    {active.email ?? active.name ?? active.subject}
                  </div>
                  <div className="text-xs font-mono text-slate-500">
                    Client: {active.issuedClientId} ·{' '}
                    {active.sharing
                      ? 'ChatGPT plan usage enabled (chatgpt.tokens.use.direct)'
                      : 'Identity only (no token sharing)'}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {active.sharing && (
                    <button
                      type="button"
                      disabled={verifying}
                      onClick={() => void handleVerifyPlanUsage()}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 rounded-md transition-colors whitespace-nowrap"
                    >
                      <ShieldCheck className="w-3.5 h-3.5" />
                      {verifying ? 'Verifying...' : 'Verify Plan Usage'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void handleLogout(active.profileId, false)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-100 rounded-md transition-colors whitespace-nowrap"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    Sign Out
                  </button>
                </div>
              </div>

              {verifyOutput && (
                <div className="px-3 py-2 text-xs font-mono text-emerald-800 bg-emerald-50 border border-emerald-200 rounded">
                  Verified: {verifyOutput}
                </div>
              )}

              {active.sharing && (
                <div className="pt-2 border-t border-slate-200 space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-slate-700">Account Model Catalog</span>
                    <button
                      type="button"
                      onClick={() => void loadModels()}
                      disabled={modelsLoading}
                      className="inline-flex items-center gap-1 text-blue-600 hover:underline whitespace-nowrap"
                    >
                      <RefreshCw className={`w-3 h-3 ${modelsLoading ? 'animate-spin' : ''}`} />
                      Refresh
                    </button>
                  </div>
                  {models.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {models.slice(0, 10).map((m) => (
                        <span
                          key={m.slug}
                          className="px-2 py-1 text-[11px] font-mono bg-white border border-slate-200 rounded text-slate-700"
                        >
                          {m.slug}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div className="text-xs text-slate-500">
                      {modelsLoading
                        ? 'Fetching account models...'
                        : 'Model list loaded on demand from /v1/models.'}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="p-5 bg-slate-50 border border-slate-200 rounded-md space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  Connect your ChatGPT account
                </h3>
                <p className="text-xs text-slate-600 mt-1">
                  Authenticate via <span className="font-mono">auth.openai.com</span> using your
                  ChatGPT Plus, Pro, Team, or Enterprise plan without API keys.
                </p>
              </div>

              {/* 3-Tab OAuth Flow Selector */}
              <div
                role="tablist"
                aria-label="Sign in with ChatGPT authentication flow"
                className="grid grid-cols-1 sm:grid-cols-3 gap-2"
              >
                {FLOW_TABS.map((tab) => {
                  const selected = flowMode === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      onClick={() => {
                        setFlowMode(tab.id);
                        setError(null);
                      }}
                      className={`text-left p-3 rounded-md border transition-colors ${
                        selected
                          ? 'bg-white border-blue-600 ring-1 ring-blue-600'
                          : 'bg-white border-slate-200 hover:border-slate-300'
                      }`}
                    >
                      <div className="text-xs font-semibold text-slate-900 whitespace-nowrap">
                        {tab.label}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-1">
                        {tab.subtitle}
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Public oaiapp_ Client ID Input for Website / Device Testing */}
              {flowMode !== 'dynamic_agent' && (
                <div className="p-3.5 bg-white border border-slate-200 rounded-md space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <label
                      htmlFor="openai-public-client-id"
                      className="text-xs font-semibold text-slate-800"
                    >
                      Public OAuth Client ID {flowMode === 'device_code' ? '(optional override)' : '(required for Website flow)'}
                    </label>
                    <span className="text-[11px] font-mono text-slate-500">
                      Public identifier only — never enter secrets
                    </span>
                  </div>
                  <input
                    id="openai-public-client-id"
                    type="text"
                    value={clientIdOverride}
                    onChange={(e) => setClientIdOverride(e.target.value)}
                    placeholder={
                      session?.configuredClientId ??
                      (flowMode === 'website_client'
                        ? 'oaiapp_xxxxxxxxxxxxxxxxxxxx'
                        : 'Leave blank for default public Codex CLI client ID')
                    }
                    className="w-full px-3 py-1.5 text-xs font-mono bg-slate-50 border border-slate-300 rounded focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                  {flowMode === 'website_client' && (
                    <p className="text-[11px] text-slate-500">
                      Register one of the hosted callback URIs below in OpenAI Developer Platform before signing in with an <span className="font-mono">oaiapp_</span> Client ID.
                    </p>
                  )}
                </div>
              )}

              {/* Device Code Verification Card */}
              {flowMode === 'device_code' && deviceSession && (
                <div className="p-4 bg-white border border-blue-200 rounded-md space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-900">
                      Enter this one-time code at OpenAI Device Login
                    </span>
                    <span className="text-xs font-mono tabular-nums text-slate-600">
                      Expires in {Math.floor(deviceSecondsLeft / 60)}:
                      {String(deviceSecondsLeft % 60).padStart(2, '0')}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3 p-3 bg-slate-50 border border-slate-200 rounded">
                    <span
                      data-testid="device-user-code"
                      className="text-xl font-bold font-mono tracking-widest tabular-nums text-slate-950"
                    >
                      {deviceSession.userCode}
                    </span>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => void copyText('device_code', deviceSession.userCode)}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-100 rounded whitespace-nowrap"
                      >
                        {copiedKey === 'device_code' ? (
                          <Check className="w-3.5 h-3.5 text-emerald-600" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                        {copiedKey === 'device_code' ? 'Copied' : 'Copy Code'}
                      </button>
                      <a
                        href={deviceSession.verificationUri}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded whitespace-nowrap"
                      >
                        Open Device Verification
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    </div>
                  </div>

                  <div className="flex items-center justify-between text-xs text-slate-600">
                    <span className="font-mono">
                      {devicePolling
                        ? `Polling OpenAI deviceauth/token every ${deviceSession.intervalSec}s...`
                        : 'Polling paused.'}
                    </span>
                    {devicePolling && (
                      <button
                        type="button"
                        onClick={stopDevicePolling}
                        className="text-slate-600 hover:text-rose-600 font-medium whitespace-nowrap"
                      >
                        Stop Polling
                      </button>
                    )}
                  </div>
                </div>
              )}

              <div className="space-y-2">
                {flowMode === 'device_code' ? (
                  <button
                    type="button"
                    disabled={loadingAuth}
                    onClick={() => void handleStartDeviceAuth()}
                    className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-slate-950 hover:bg-slate-800 disabled:opacity-50 rounded-md transition-colors whitespace-nowrap shrink-0"
                  >
                    <KeyRound className="w-4 h-4" />
                    {loadingAuth
                      ? 'Generating Code...'
                      : deviceSession
                        ? 'Generate New Device Code'
                        : 'Generate Device Code'}
                  </button>
                ) : (
                  <button
                    type="button"
                    data-oai-siwc-button=""
                    data-oai-siwc-button-client={
                      flowMode === 'website_client'
                        ? effectiveWebsiteClient ?? 'oaiapp_missing'
                        : 'dynamic_agent_client'
                    }
                    disabled={loadingAuth || (flowMode === 'website_client' && !effectiveWebsiteClient)}
                    onClick={() => void startSignIn(null)}
                    className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-slate-950 hover:bg-slate-800 disabled:opacity-50 rounded-md transition-colors whitespace-nowrap shrink-0"
                  >
                    <UserCheck className="w-4 h-4" />
                    {loadingAuth ? 'Opening OpenAI Auth...' : 'Continue with ChatGPT'}
                  </button>
                )}

                <div className="text-[11px] font-mono text-slate-500 break-all">
                  {flowMode === 'dynamic_agent'
                    ? 'Scope: openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
                    : flowMode === 'device_code'
                      ? 'Works across Cloud Run containers without local port 1455'
                      : `Callback: ${session?.webCallbackUrl ?? '/auth/openai/callback'}`}
                </div>
              </div>
            </div>
          )}

          {/* Pending Authorization Link & Loopback URL Recovery */}
          {pendingAuthUrl && (
            <div className="p-4 bg-white border border-slate-200 rounded-md space-y-3 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-slate-900">
                  Authorization Transaction Started
                </span>
                <a
                  href={pendingAuthUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-blue-600 hover:underline font-medium whitespace-nowrap"
                >
                  Open OpenAI Sign-In Tab
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
              {pendingRedirectUri && (
                <div className="text-slate-600">
                  Redirect URI:{' '}
                  <span className="font-mono text-slate-900">{pendingRedirectUri}</span>
                </div>
              )}
              <form onSubmit={handleCompleteRedirectUrl} className="space-y-2 pt-1">
                <label htmlFor="oauth-redirect-paste" className="block text-slate-600">
                  If OpenAI redirected to <span className="font-mono">127.0.0.1</span> in your
                  browser on a remote Cloud Run URL, copy the full address-bar callback URL and paste
                  it here to finish PKCE exchange:
                </label>
                <div className="flex gap-2">
                  <input
                    id="oauth-redirect-paste"
                    type="url"
                    value={redirectPasteUrl}
                    onChange={(e) => setRedirectPasteUrl(e.target.value)}
                    placeholder="http://127.0.0.1:1455/auth/callback?code=...&state=...&client_id=..."
                    className="flex-1 px-3 py-1.5 text-xs font-mono bg-slate-50 border border-slate-300 rounded focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                  <button
                    type="submit"
                    disabled={loadingAuth || !redirectPasteUrl.trim()}
                    className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded whitespace-nowrap shrink-0"
                  >
                    Complete Exchange
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* Saved Profiles Switcher */}
          {profiles.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Saved ChatGPT Profiles ({profiles.length})
                </h3>
                <button
                  type="button"
                  data-oai-siwc-button=""
                  onClick={() => void startSignIn(null)}
                  className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:underline whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add Account
                </button>
              </div>
              <div className="divide-y divide-slate-200 border border-slate-200 rounded-md">
                {profiles.map((p) => {
                  const isActive = active?.profileId === p.profileId;
                  return (
                    <div
                      key={p.profileId}
                      className={`flex items-center justify-between gap-3 px-4 py-2.5 text-xs ${
                        isActive ? 'bg-blue-50/40' : 'bg-white'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="font-semibold text-slate-900 truncate">
                          {p.email ?? p.name ?? p.subject}
                        </div>
                        <div className="font-mono text-[11px] text-slate-500 truncate">
                          {p.issuedClientId} ·{' '}
                          {p.connected ? 'Connected' : 'Signed out (registration kept)'}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {!p.connected ? (
                          <button
                            type="button"
                            onClick={() => void startSignIn(p.profileId)}
                            className="px-2.5 py-1 text-xs font-medium text-slate-900 bg-slate-100 hover:bg-slate-200 rounded whitespace-nowrap"
                          >
                            Reconnect
                          </button>
                        ) : !isActive ? (
                          <button
                            type="button"
                            onClick={() => void handleSelectProfile(p.profileId)}
                            className="px-2.5 py-1 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded whitespace-nowrap"
                          >
                            Use Profile
                          </button>
                        ) : (
                          <span className="font-medium text-emerald-700">Active</span>
                        )}
                        <button
                          type="button"
                          onClick={() => void handleLogout(p.profileId, true)}
                          className="px-2 py-1 text-xs text-slate-500 hover:text-rose-600 whitespace-nowrap"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Live Authorize URL Parameter Debugger Panel */}
          <div className="border border-slate-200 rounded-md bg-white overflow-hidden">
            <button
              type="button"
              onClick={() => setDebuggerOpen((prev) => !prev)}
              aria-expanded={debuggerOpen}
              className="w-full px-4 py-2.5 bg-slate-50 hover:bg-slate-100/80 flex items-center justify-between text-xs font-semibold text-slate-800 border-b border-slate-200 transition-colors"
            >
              <span className="inline-flex items-center gap-2">
                <Terminal className="w-3.5 h-3.5 text-slate-600" />
                Live Authorize Parameter Debugger
              </span>
              <span className="inline-flex items-center gap-2 font-mono font-normal text-slate-500">
                {previewLoading
                  ? 'Updating...'
                  : preview
                    ? `${preview.params.length} params · ${preview.flowMode}`
                    : 'Inspect request'}
                {debuggerOpen ? (
                  <ChevronDown className="w-4 h-4" />
                ) : (
                  <ChevronRight className="w-4 h-4" />
                )}
              </span>
            </button>

            {debuggerOpen && preview && (
              <div className="p-4 space-y-3 text-xs">
                {preview.warnings.length > 0 ? (
                  <div className="p-3 bg-amber-50 border border-amber-200 rounded text-amber-900 space-y-1">
                    {preview.warnings.map((w, idx) => (
                      <div key={idx} className="flex items-start gap-2">
                        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-600" />
                        <span>{w}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-emerald-700 font-medium">
                    <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                    <span>
                      Valid parameter contract ({preview.flowMode === 'dynamic_agent'
                        ? 'strict dynamic_agent_client params, RFC 3986 %20 space encoding, website ext_* params excluded'
                        : preview.flowMode === 'device_code'
                          ? 'OpenAI deviceauth flow with full chatgpt.tokens.use.direct plan usage'
                          : 'Website OAuth client contract with registered hosted callback URI'})
                    </span>
                  </div>
                )}

                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-slate-700">
                      Endpoint: <span className="font-mono text-slate-900">{preview.endpoint}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => void copyText('auth_url', pendingAuthUrl ?? preview.authUrl)}
                      className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded whitespace-nowrap"
                    >
                      {copiedKey === 'auth_url' ? (
                        <Check className="w-3 h-3 text-emerald-600" />
                      ) : (
                        <Copy className="w-3 h-3" />
                      )}
                      {copiedKey === 'auth_url' ? 'Copied URL' : 'Copy Authorize URL'}
                    </button>
                  </div>
                  <div
                    data-testid="authorize-url-preview"
                    className="p-2.5 bg-slate-50 border border-slate-200 rounded font-mono text-[11px] text-slate-700 break-all max-h-24 overflow-y-auto"
                  >
                    {pendingAuthUrl ?? preview.authUrl}
                  </div>
                </div>

                <div className="border border-slate-200 rounded overflow-x-auto">
                  <table className="w-full text-left border-collapse text-[11px]">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                        <th className="py-1.5 px-3 font-semibold">Parameter</th>
                        <th className="py-1.5 px-3 font-semibold">Value</th>
                        <th className="py-1.5 px-3 font-semibold">Spec Note</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {preview.params.map((p) => (
                        <tr key={p.key} className="bg-white">
                          <td className="py-1.5 px-3 font-mono font-medium text-slate-900 whitespace-nowrap">
                            {p.key}
                          </td>
                          <td className="py-1.5 px-3 font-mono text-slate-700 break-all max-w-xs">
                            {p.value}
                          </td>
                          <td className="py-1.5 px-3 text-slate-500">{p.note}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          {/* Host & Callback Reference Metadata */}
          {session && (
            <div className="pt-3 border-t border-slate-200 text-[11px] font-mono text-slate-500 space-y-1">
              <div>ext_agent_host_id: {session.hostId}</div>
              <div>Loopback Redirect URI (dynamic_agent): http://127.0.0.1:1455/auth/callback</div>
              <div>Web Callback URI (oaiapp_): {session.webCallbackUrl}</div>
              <div>OIDC Issuer: https://auth.openai.com</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
