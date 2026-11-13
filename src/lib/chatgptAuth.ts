import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type {
  AuthorizeParamEntry,
  AuthorizePreviewResult,
  ChatGptModelInfo,
  ChatGptProfile,
  DeviceAuthPollResult,
  DeviceAuthSessionInfo,
  OpenAiFlowMode,
} from './types.ts';

const OPENAI_ISSUER = 'https://auth.openai.com';
const OPENAI_RESOURCE = 'https://api.openai.com/v1';
const AGENT_NAME_HINT = 'Semantic Router Studio';

export const DYNAMIC_AGENT_SCOPE =
  'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export const WEBSITE_CLIENT_SCOPE = 'openid profile email';
export const DEVICE_AUTH_DEFAULT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const DEVICE_AUTH_VERIFICATION_URI = 'https://auth.openai.com/codex/device';
const DEVICE_AUTH_USERCODE_ENDPOINT = 'https://auth.openai.com/api/accounts/deviceauth/usercode';
const DEVICE_AUTH_TOKEN_ENDPOINT = 'https://auth.openai.com/api/accounts/deviceauth/token';
const DEVICE_AUTH_REDIRECT_URI = 'https://auth.openai.com/deviceauth/callback';

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
}

const DEFAULT_DISCOVERY: OidcDiscovery = {
  issuer: OPENAI_ISSUER,
  authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize',
  token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token',
  revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke',
  jwks_uri: 'https://auth.openai.com/.well-known/jwks.json',
  userinfo_endpoint: 'https://auth.openai.com/api/accounts/oauth/userinfo',
};

interface StoredChatGptProfile {
  profileId: string;
  issuedClientId: string;
  flowMode: OpenAiFlowMode;
  issuer: string;
  subject: string;
  email: string | null;
  name: string | null;
  workspaceId: string | null;
  idToken: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
  grantedScopes: string[];
  sharing: boolean;
  createdAt: string;
  updatedAt: string;
}

interface PersistedAuthStore {
  activeProfileId: string | null;
  profiles: Record<string, StoredChatGptProfile>;
}

export interface SignInTransaction {
  state: string;
  codeVerifier: string;
  codeChallenge: string;
  nonce: string;
  flowMode: OpenAiFlowMode;
  requestedClientId: string;
  expectedIssuedClientId: string | null;
  redirectUri: string;
  profileId: string | null;
  browserSessionId: string;
  expiresAt: number;
  loopbackServer?: http.Server;
}

interface DeviceAuthTransaction {
  deviceAuthId: string;
  userCode: string;
  clientId: string;
  intervalSec: number;
  expiresAt: number;
}

export function randomUrlSafe(byteCount = 32): string {
  return crypto.randomBytes(byteCount).toString('base64url');
}

export function computeS256Challenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

/**
 * RFC 3986 percent-encoding using %20 for spaces rather than '+' from URLSearchParams,
 * matching OpenAI Sign in with ChatGPT dynamic_agent_client authorize validation.
 */
export function serializeAuthorizeParams(
  entries: Array<{ key: string; value: string }>
): string {
  return entries
    .map(({ key, value }) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

export function sanitizePublicClientId(raw?: string | null): string | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;
  return trimmed.replace(/[\s\r\n\0]/g, '');
}

export function buildAuthorizePreviewPayload(opts: {
  authorizationEndpoint: string;
  flowMode: OpenAiFlowMode;
  hostId: string;
  configuredClientId: string | null;
  clientIdOverride?: string | null;
  webCallbackUrl: string;
  loopbackRedirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  existingProfile?: {
    issuedClientId: string;
    idToken: string | null;
    email: string | null;
  } | null;
  deviceToken?: string;
  loginSessionId?: string;
  loginStartedAtMs?: number;
}): AuthorizePreviewResult {
  const warnings: string[] = [];
  const cleanOverride = sanitizePublicClientId(opts.clientIdOverride);

  if (opts.flowMode === 'device_code') {
    const clientId = cleanOverride || opts.configuredClientId || DEVICE_AUTH_DEFAULT_CLIENT_ID;
    const params: AuthorizeParamEntry[] = [
      {
        key: 'client_id',
        value: clientId,
        required: true,
        note: cleanOverride
          ? 'Public client_id override for device auth'
          : 'OpenAI public device-auth client ID',
      },
      {
        key: 'scope',
        value: DYNAMIC_AGENT_SCOPE,
        required: true,
        note: 'Includes chatgpt.tokens.use.direct plan usage',
      },
      {
        key: 'verification_uri',
        value: DEVICE_AUTH_VERIFICATION_URI,
        required: true,
        note: 'Interactive user code verification page',
      },
      {
        key: 'redirect_uri',
        value: DEVICE_AUTH_REDIRECT_URI,
        required: true,
        note: 'Used during token exchange after user code approval',
      },
    ];
    return {
      endpoint: DEVICE_AUTH_USERCODE_ENDPOINT,
      authUrl: DEVICE_AUTH_VERIFICATION_URI,
      flowMode: 'device_code',
      clientId,
      redirectUri: DEVICE_AUTH_REDIRECT_URI,
      params,
      warnings,
    };
  }

  if (opts.flowMode === 'website_client') {
    const effectiveClientId = cleanOverride || opts.configuredClientId;
    if (!effectiveClientId) {
      warnings.push(
        'Enter a registered oaiapp_ Client ID above or set OPENAI_OAUTH_CLIENT_ID on the server before launching Website OAuth.'
      );
    } else if (
      !effectiveClientId.startsWith('oaiapp_') &&
      !effectiveClientId.startsWith('app_')
    ) {
      warnings.push(
        'Registered OpenAI OAuth Website Client IDs typically begin with oaiapp_ or app_.'
      );
    }

    const clientId = effectiveClientId || 'oaiapp_missing_client_id';
    const deviceToken =
      opts.deviceToken ??
      `dev_${crypto.createHash('sha256').update(opts.hostId).digest('hex').slice(0, 16)}`;
    const loginSessionId = opts.loginSessionId ?? `ls_${randomUrlSafe(12)}`;
    const loginStartedAtMs = opts.loginStartedAtMs ?? Date.now();

    const params: AuthorizeParamEntry[] = [
      { key: 'response_type', value: 'code', required: true, note: 'OAuth 2.0 authorization code' },
      { key: 'client_id', value: clientId, required: true, note: 'Registered OpenAI website client' },
      {
        key: 'redirect_uri',
        value: opts.webCallbackUrl,
        required: true,
        note: 'Must match one of the registered app redirect URIs',
      },
      { key: 'scope', value: WEBSITE_CLIENT_SCOPE, required: true, note: 'OpenAI website OIDC scopes' },
      { key: 'state', value: opts.state, required: true, note: 'CSRF state token' },
      { key: 'nonce', value: opts.nonce, required: true, note: 'OIDC id_token nonce' },
      { key: 'code_challenge_method', value: 'S256', required: true, note: 'PKCE SHA-256 method' },
      { key: 'code_challenge', value: opts.codeChallenge, required: true, note: 'PKCE code challenge' },
      { key: 'ext_device_token', value: deviceToken, required: false, note: 'Website flow device diagnostic ID' },
      { key: 'ext_login_session_id', value: loginSessionId, required: false, note: 'Website flow login session correlation ID' },
      { key: 'ext_login_started_at_ms', value: String(loginStartedAtMs), required: false, note: 'Website flow login start epoch ms' },
    ];

    const qs = serializeAuthorizeParams(params);
    return {
      endpoint: opts.authorizationEndpoint,
      authUrl: `${opts.authorizationEndpoint}?${qs}`,
      flowMode: 'website_client',
      clientId,
      redirectUri: opts.webCallbackUrl,
      params,
      warnings,
    };
  }

  // Strict dynamic_agent_client flow (OpenAI Token Sharing for Open Source Cookbook)
  // Never include website-only ext_device_token / ext_login_* params here;
  // never send an https:// redirect URI to dynamic_agent_client.
  const isReturning = Boolean(opts.existingProfile);
  const clientId = isReturning
    ? opts.existingProfile!.issuedClientId
    : 'dynamic_agent_client';

  if (cleanOverride && cleanOverride !== 'dynamic_agent_client') {
    warnings.push(
      `Custom client ID "${cleanOverride}" is ignored in Dynamic Agent PKCE mode (uses dynamic_agent_client); switch to Website oaiapp_ Client or Device Code to test it.`
    );
  }

  if (!opts.loopbackRedirectUri.startsWith('http://127.0.0.1:')) {
    warnings.push('dynamic_agent_client requires an http://127.0.0.1:<port>/auth/callback redirect_uri.');
  }

  const params: AuthorizeParamEntry[] = [
    { key: 'response_type', value: 'code', required: true, note: 'OAuth 2.0 authorization code' },
    {
      key: 'client_id',
      value: clientId,
      required: true,
      note: isReturning ? 'Issued dynamic agent client_id from profile' : 'OpenAI dynamic agent client identifier',
    },
  ];

  if (!isReturning) {
    params.push({
      key: 'agent_name_hint',
      value: AGENT_NAME_HINT,
      required: true,
      note: 'Displayed on consent screen during initial registration',
    });
  }

  params.push(
    {
      key: 'ext_agent_host_id',
      value: opts.hostId,
      required: true,
      note: 'Stable installation URN identifying this Semantic Router instance',
    },
    {
      key: 'redirect_uri',
      value: opts.loopbackRedirectUri,
      required: true,
      note: 'Strict 127.0.0.1 loopback callback required by dynamic_agent_client',
    },
    {
      key: 'scope',
      value: DYNAMIC_AGENT_SCOPE,
      required: true,
      note: 'OIDC + offline_access + resource.invoke + chatgpt.tokens.use.direct',
    },
    {
      key: 'resource',
      value: OPENAI_RESOURCE,
      required: true,
      note: 'RFC 8707 target API audience',
    },
    { key: 'state', value: opts.state, required: true, note: 'CSRF state token' },
    { key: 'nonce', value: opts.nonce, required: true, note: 'OIDC id_token nonce' },
    { key: 'code_challenge_method', value: 'S256', required: true, note: 'PKCE SHA-256 method' },
    { key: 'code_challenge', value: opts.codeChallenge, required: true, note: 'PKCE code challenge' }
  );

  if (isReturning && opts.existingProfile) {
    if (opts.existingProfile.idToken) {
      params.push({
        key: 'id_token_hint',
        value: opts.existingProfile.idToken,
        required: false,
        note: 'Previously issued ID token for silent account hint',
      });
    }
    if (opts.existingProfile.email) {
      params.push({
        key: 'login_hint',
        value: opts.existingProfile.email,
        required: false,
        note: 'Pre-fills account email on returning login',
      });
    }
  }

  const qs = serializeAuthorizeParams(params);
  return {
    endpoint: opts.authorizationEndpoint,
    authUrl: `${opts.authorizationEndpoint}?${qs}`,
    flowMode: 'dynamic_agent',
    clientId,
    redirectUri: opts.loopbackRedirectUri,
    params,
    warnings,
  };
}

export class ChatGptAuthManager {
  private readonly dataDir: string;
  private readonly hostFile: string;
  private readonly authFile: string;
  private discoveryCache: { value: OidcDiscovery; fetchedAt: number } | null = null;
  private jwksCache: { uri: string; fn: ReturnType<typeof createRemoteJWKSet> } | null = null;
  private transactions = new Map<string, SignInTransaction>(); // keyed by state
  private deviceTransactions = new Map<string, DeviceAuthTransaction>();
  private store: PersistedAuthStore;
  private hostId: string;

  constructor(rootDir: string) {
    this.dataDir = path.join(rootDir, 'data');
    this.hostFile = path.join(this.dataDir, 'chatgpt-host.json');
    this.authFile = path.join(this.dataDir, 'chatgpt-auth.json');
    this.hostId = this.loadOrCreateHostId();
    this.store = this.loadAuthStore();
  }

  private ensureDataDir(): void {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  private loadOrCreateHostId(): string {
    try {
      if (fs.existsSync(this.hostFile)) {
        const parsed = JSON.parse(fs.readFileSync(this.hostFile, 'utf-8')) as { hostId?: string };
        if (parsed.hostId && parsed.hostId.startsWith('urn:uuid:')) {
          return parsed.hostId;
        }
      }
    } catch {
      // Create fresh host ID below
    }
    const hostId = `urn:uuid:${crypto.randomUUID()}`;
    try {
      this.ensureDataDir();
      fs.writeFileSync(this.hostFile, JSON.stringify({ hostId }, null, 2), 'utf-8');
    } catch (err) {
      console.warn('Could not persist chatgpt-host.json:', (err as Error).message);
    }
    return hostId;
  }

  private loadAuthStore(): PersistedAuthStore {
    try {
      if (fs.existsSync(this.authFile)) {
        const parsed = JSON.parse(fs.readFileSync(this.authFile, 'utf-8')) as Partial<PersistedAuthStore>;
        if (parsed && typeof parsed.profiles === 'object' && parsed.profiles !== null) {
          return {
            activeProfileId: parsed.activeProfileId ?? null,
            profiles: parsed.profiles,
          };
        }
      }
    } catch {
      // Fallback to empty store
    }
    return { activeProfileId: null, profiles: {} };
  }

  private saveAuthStore(): void {
    try {
      this.ensureDataDir();
      fs.writeFileSync(this.authFile, JSON.stringify(this.store, null, 2), 'utf-8');
    } catch (err) {
      console.warn('Could not persist chatgpt-auth.json:', (err as Error).message);
    }
  }

  getHostId(): string {
    return this.hostId;
  }

  getConfiguredClientId(): string | null {
    const val = (process.env.OPENAI_OAUTH_CLIENT_ID ?? '').trim();
    return val.length > 0 ? val : null;
  }

  private getConfiguredClientSecret(): string | null {
    const val = (process.env.OPENAI_OAUTH_CLIENT_SECRET ?? '').trim();
    return val.length > 0 ? val : null;
  }

  getDefaultFlowMode(): OpenAiFlowMode {
    return this.getConfiguredClientId() ? 'website_client' : 'dynamic_agent';
  }

  async getDiscovery(): Promise<OidcDiscovery> {
    const now = Date.now();
    if (this.discoveryCache && now - this.discoveryCache.fetchedAt < 3600_000) {
      return this.discoveryCache.value;
    }
    try {
      const res = await Promise.race([
        fetch(`${OPENAI_ISSUER}/.well-known/openid-configuration`),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('OIDC discovery timeout')), 3000)),
      ]);
      if (res.ok) {
        const doc = (await res.json()) as OidcDiscovery;
        if (doc.issuer && doc.authorization_endpoint && doc.token_endpoint && doc.jwks_uri) {
          this.discoveryCache = { value: doc, fetchedAt: now };
          return doc;
        }
      }
    } catch {
      // Fallback to cached production discovery document
    }
    return DEFAULT_DISCOVERY;
  }

  private getJwks(jwksUri: string) {
    if (!this.jwksCache || this.jwksCache.uri !== jwksUri) {
      this.jwksCache = {
        uri: jwksUri,
        fn: createRemoteJWKSet(new URL(jwksUri)),
      };
    }
    return this.jwksCache.fn;
  }

  toPublicProfile(p: StoredChatGptProfile): ChatGptProfile {
    return {
      profileId: p.profileId,
      issuedClientId: p.issuedClientId,
      issuer: p.issuer,
      subject: p.subject,
      email: p.email,
      name: p.name,
      workspaceId: p.workspaceId,
      grantedScopes: p.grantedScopes,
      sharing: p.sharing,
      connected: Boolean(p.accessToken),
      expiresAt: p.expiresAt,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }

  listProfiles(): ChatGptProfile[] {
    return Object.values(this.store.profiles)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((p) => this.toPublicProfile(p));
  }

  getActiveProfile(): ChatGptProfile | null {
    const id = this.store.activeProfileId;
    if (!id || !this.store.profiles[id]) return null;
    return this.toPublicProfile(this.store.profiles[id]);
  }

  selectProfile(profileId: string): ChatGptProfile | null {
    if (!this.store.profiles[profileId]) return null;
    this.store.activeProfileId = profileId;
    this.saveAuthStore();
    return this.toPublicProfile(this.store.profiles[profileId]);
  }

  private pruneExpiredTransactions(): void {
    const now = Date.now();
    for (const [state, tx] of this.transactions.entries()) {
      if (tx.expiresAt <= now) {
        tx.loopbackServer?.close();
        this.transactions.delete(state);
      }
    }
    for (const [id, dtx] of this.deviceTransactions.entries()) {
      if (dtx.expiresAt <= now) {
        this.deviceTransactions.delete(id);
      }
    }
  }

  getLoopbackRuntimeStatus(): {
    listening: boolean;
    port: number | null;
    pendingOAuthCount: number;
    pendingDeviceCount: number;
  } {
    this.pruneExpiredTransactions();
    let listening = false;
    let port: number | null = null;
    for (const tx of this.transactions.values()) {
      if (tx.loopbackServer && tx.loopbackServer.listening) {
        listening = true;
        const addr = tx.loopbackServer.address();
        port = typeof addr === 'object' && addr ? addr.port : 1455;
        break;
      }
    }
    return {
      listening,
      port,
      pendingOAuthCount: this.transactions.size,
      pendingDeviceCount: this.deviceTransactions.size,
    };
  }

  async previewAuthorizationRequest(opts: {
    webCallbackUrl: string;
    flowMode?: OpenAiFlowMode;
    profileId?: string | null;
    clientIdOverride?: string | null;
  }): Promise<AuthorizePreviewResult> {
    const discovery = await this.getDiscovery();
    const configuredClientId = this.getConfiguredClientId();
    const flowMode: OpenAiFlowMode =
      opts.flowMode ?? (configuredClientId ? 'website_client' : 'dynamic_agent');
    const existingProfile =
      opts.profileId && this.store.profiles[opts.profileId]
        ? this.store.profiles[opts.profileId]
        : null;

    const sampleVerifier = randomUrlSafe(48);
    return buildAuthorizePreviewPayload({
      authorizationEndpoint: discovery.authorization_endpoint,
      flowMode,
      hostId: this.hostId,
      configuredClientId,
      clientIdOverride: opts.clientIdOverride,
      webCallbackUrl: opts.webCallbackUrl,
      loopbackRedirectUri: 'http://127.0.0.1:1455/auth/callback',
      state: 'preview_state_token',
      nonce: 'preview_nonce_token',
      codeChallenge: computeS256Challenge(sampleVerifier),
      existingProfile,
    });
  }

  async createAuthorizationRequest(opts: {
    browserSessionId: string;
    webCallbackUrl: string;
    flowMode?: OpenAiFlowMode;
    profileId?: string | null;
    clientIdOverride?: string | null;
    useLoopback?: boolean;
  }): Promise<{
    authUrl: string;
    state: string;
    redirectUri: string;
    flowMode: OpenAiFlowMode;
    preview: AuthorizePreviewResult;
  }> {
    this.pruneExpiredTransactions();
    const discovery = await this.getDiscovery();
    const configuredClientId = this.getConfiguredClientId();
    const cleanOverride = sanitizePublicClientId(opts.clientIdOverride);
    const flowMode: OpenAiFlowMode =
      opts.flowMode ?? (configuredClientId ? 'website_client' : 'dynamic_agent');

    if (flowMode === 'device_code') {
      throw new Error('Use /api/auth/openai/device/start for Device Code authentication.');
    }

    const existingProfile =
      opts.profileId && this.store.profiles[opts.profileId]
        ? this.store.profiles[opts.profileId]
        : null;

    let expectedIssuedClientId: string | null = null;
    if (flowMode === 'website_client') {
      const effectiveWebsiteClient = cleanOverride || configuredClientId;
      if (!effectiveWebsiteClient) {
        throw new Error(
          'Enter a registered oaiapp_ Client ID or configure OPENAI_OAUTH_CLIENT_ID on the server.'
        );
      }
      expectedIssuedClientId = effectiveWebsiteClient;
    } else if (existingProfile) {
      expectedIssuedClientId = existingProfile.issuedClientId;
    }

    const state = randomUrlSafe(24);
    const codeVerifier = randomUrlSafe(64);
    const codeChallenge = computeS256Challenge(codeVerifier);
    const nonce = randomUrlSafe(24);

    let loopbackRedirectUri = 'http://127.0.0.1:1455/auth/callback';
    let loopbackServer: http.Server | undefined;

    // dynamic_agent_client ALWAYS requires a 127.0.0.1 loopback redirect URI
    if (flowMode === 'dynamic_agent') {
      if (opts.useLoopback !== false) {
        try {
          const loopback = await this.startLoopbackListener(opts.webCallbackUrl);
          loopbackRedirectUri = loopback.redirectUri;
          loopbackServer = loopback.server;
        } catch {
          loopbackRedirectUri = 'http://127.0.0.1:1455/auth/callback';
        }
      }
    }

    const preview = buildAuthorizePreviewPayload({
      authorizationEndpoint: discovery.authorization_endpoint,
      flowMode,
      hostId: this.hostId,
      configuredClientId,
      clientIdOverride: cleanOverride,
      webCallbackUrl: opts.webCallbackUrl,
      loopbackRedirectUri,
      state,
      nonce,
      codeChallenge,
      existingProfile,
    });

    const tx: SignInTransaction = {
      state,
      codeVerifier,
      codeChallenge,
      nonce,
      flowMode,
      requestedClientId: preview.clientId,
      expectedIssuedClientId,
      redirectUri: preview.redirectUri,
      profileId: existingProfile?.profileId ?? null,
      browserSessionId: opts.browserSessionId,
      expiresAt: Date.now() + 10 * 60 * 1000,
      loopbackServer,
    };
    this.transactions.set(state, tx);

    return {
      authUrl: preview.authUrl,
      state,
      redirectUri: preview.redirectUri,
      flowMode,
      preview,
    };
  }

  private startLoopbackListener(
    webOriginCallbackUrl: string
  ): Promise<{ server: http.Server; redirectUri: string }> {
    return new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        try {
          const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
          if (reqUrl.pathname !== '/auth/callback' && reqUrl.pathname !== '/auth/callback/') {
            res.writeHead(404);
            res.end('Not Found');
            return;
          }

          const code = reqUrl.searchParams.get('code') ?? undefined;
          const state = reqUrl.searchParams.get('state') ?? undefined;
          const clientId = reqUrl.searchParams.get('client_id') ?? undefined;
          const error = reqUrl.searchParams.get('error') ?? undefined;
          const errorDescription = reqUrl.searchParams.get('error_description') ?? undefined;

          const profile = await this.completeAuthorizationCallback({
            code,
            state,
            clientId,
            error,
            errorDescription,
          });

          const webOrigin = new URL(webOriginCallbackUrl).origin;
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(buildPopupCompletionHtml(profile, webOrigin));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(buildPopupErrorHtml((err as Error).message));
        } finally {
          setTimeout(() => server.close(), 400);
        }
      });

      const listenOnPort = (port: number) => {
        server.once('error', () => {
          if (port !== 0) {
            listenOnPort(0);
          } else {
            reject(new Error('Failed to start 127.0.0.1 loopback callback server.'));
          }
        });
        server.listen(port, '127.0.0.1', () => {
          const addr = server.address();
          const boundPort = typeof addr === 'object' && addr ? addr.port : 1455;
          resolve({
            server,
            redirectUri: `http://127.0.0.1:${boundPort}/auth/callback`,
          });
        });
      };

      listenOnPort(1455);
    });
  }

  async startDeviceCodeAuth(opts?: {
    clientIdOverride?: string | null;
  }): Promise<DeviceAuthSessionInfo> {
    this.pruneExpiredTransactions();
    const clientId =
      sanitizePublicClientId(opts?.clientIdOverride) ||
      this.getConfiguredClientId() ||
      DEVICE_AUTH_DEFAULT_CLIENT_ID;

    const res = await fetch(DEVICE_AUTH_USERCODE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'SemanticRouterStudio/1.0',
      },
      body: JSON.stringify({ client_id: clientId }),
    });

    const contentType = res.headers.get('content-type') || '';
    const rawText = await res.text();
    if (contentType.includes('text/html') || rawText.includes('<!DOCTYPE html>')) {
      throw new Error(
        'OpenAI device auth endpoint blocked the remote container request (bot/Cloudflare check). Use Dynamic Agent PKCE + callback URL paste instead.'
      );
    }

    let parsed: {
      device_auth_id?: string;
      user_code?: string;
      usercode?: string;
      interval?: number | string;
      expires_in?: number;
      error?: string | { message?: string };
      error_description?: string;
    } = {};
    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new Error(`Unexpected response from OpenAI deviceauth/usercode (${res.status}).`);
    }

    if (!res.ok) {
      const errMsg =
        parsed.error_description ||
        (typeof parsed.error === 'string' ? parsed.error : parsed.error?.message) ||
        `Device auth initialization failed (${res.status})`;
      throw new Error(errMsg);
    }

    const deviceAuthId = parsed.device_auth_id;
    const userCode = parsed.user_code || parsed.usercode;
    if (!deviceAuthId || !userCode) {
      throw new Error('OpenAI deviceauth response did not include device_auth_id and user_code.');
    }

    const intervalSec = Math.max(3, Number(parsed.interval ?? 5) || 5);
    const ttlMs = (typeof parsed.expires_in === 'number' ? parsed.expires_in : 900) * 1000;
    const tx: DeviceAuthTransaction = {
      deviceAuthId,
      userCode,
      clientId,
      intervalSec,
      expiresAt: Date.now() + ttlMs,
    };
    this.deviceTransactions.set(deviceAuthId, tx);

    return {
      deviceAuthId,
      userCode,
      verificationUri: DEVICE_AUTH_VERIFICATION_URI,
      intervalSec,
      expiresAt: tx.expiresAt,
      clientId,
    };
  }

  async pollDeviceCodeAuth(deviceAuthId: string): Promise<DeviceAuthPollResult> {
    this.pruneExpiredTransactions();
    const tx = this.deviceTransactions.get(deviceAuthId);
    if (!tx) {
      return {
        status: 'expired',
        error: 'Device code session expired or was not found. Generate a new code.',
      };
    }

    const res = await fetch(DEVICE_AUTH_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'SemanticRouterStudio/1.0',
      },
      body: JSON.stringify({
        device_auth_id: tx.deviceAuthId,
        user_code: tx.userCode,
      }),
    });

    const contentType = res.headers.get('content-type') || '';
    const rawText = await res.text();
    if (contentType.includes('text/html') || rawText.includes('<!DOCTYPE html>')) {
      this.deviceTransactions.delete(deviceAuthId);
      return {
        status: 'error',
        error: 'OpenAI device auth endpoint rejected container polling. Use Dynamic Agent PKCE + callback URL paste.',
      };
    }

    if (res.status === 403 || res.status === 404 || res.status === 428) {
      return { status: 'pending', intervalSec: tx.intervalSec };
    }

    let data: {
      authorization_code?: string;
      code_verifier?: string;
      error?: string | { message?: string };
      error_description?: string;
    } = {};
    try {
      data = JSON.parse(rawText);
    } catch {
      return {
        status: 'error',
        error: `Unexpected deviceauth poll response (${res.status}).`,
      };
    }

    if (!res.ok) {
      const codeStr = typeof data.error === 'string' ? data.error : '';
      if (codeStr === 'authorization_pending' || codeStr === 'slow_down') {
        return { status: 'pending', intervalSec: tx.intervalSec };
      }
      this.deviceTransactions.delete(deviceAuthId);
      return {
        status: 'error',
        error:
          data.error_description ||
          (typeof data.error === 'string' ? data.error : data.error?.message) ||
          `Device auth polling failed (${res.status})`,
      };
    }

    if (!data.authorization_code || !data.code_verifier) {
      return { status: 'pending', intervalSec: tx.intervalSec };
    }

    this.deviceTransactions.delete(deviceAuthId);

    try {
      const profile = await this.exchangeCodeForProfile({
        clientId: tx.clientId,
        code: data.authorization_code,
        codeVerifier: data.code_verifier,
        redirectUri: DEVICE_AUTH_REDIRECT_URI,
        flowMode: 'device_code',
        expectedNonce: null,
        existingProfileId: null,
        includeResource: true,
      });
      return { status: 'authorized', profile };
    } catch (err) {
      return {
        status: 'error',
        error: (err as Error).message || 'Device authorization token exchange failed.',
      };
    }
  }

  private async exchangeCodeForProfile(opts: {
    clientId: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
    flowMode: OpenAiFlowMode;
    expectedNonce: string | null;
    existingProfileId: string | null;
    includeResource: boolean;
  }): Promise<ChatGptProfile> {
    const discovery = await this.getDiscovery();
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: opts.clientId,
      code: opts.code,
      code_verifier: opts.codeVerifier,
      redirect_uri: opts.redirectUri,
    });
    if (opts.includeResource) {
      tokenBody.set('resource', OPENAI_RESOURCE);
    }
    if (opts.flowMode === 'website_client') {
      const secret = this.getConfiguredClientSecret();
      if (secret) tokenBody.set('client_secret', secret);
    }

    const tokenRes = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody.toString(),
    });

    const tokenJson = (await tokenRes.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      id_token?: string;
      expires_in?: number;
      scope?: string;
      error?: string;
      error_description?: string;
    };

    if (!tokenRes.ok) {
      throw new Error(
        tokenJson.error_description ||
          tokenJson.error ||
          `Token exchange failed with HTTP ${tokenRes.status}`
      );
    }

    if (typeof tokenJson.id_token !== 'string') {
      throw new Error('ChatGPT did not return a verifiable id_token. Please try signing in again.');
    }

    const jwks = this.getJwks(discovery.jwks_uri);
    const { payload } = await jwtVerify(tokenJson.id_token, jwks, {
      issuer: discovery.issuer,
      audience: opts.clientId,
    });

    if (opts.expectedNonce !== null && payload.nonce !== opts.expectedNonce) {
      throw new Error('ID token nonce mismatch. Authentication rejected.');
    }
    if (typeof payload.sub !== 'string' || !payload.sub) {
      throw new Error('ID token missing subject (sub) claim.');
    }

    const authClaims = (payload['https://api.openai.com/auth'] ?? {}) as Record<string, unknown>;
    const workspaceId =
      typeof authClaims.chatgpt_account_id === 'string'
        ? authClaims.chatgpt_account_id
        : typeof payload.org_id === 'string'
          ? payload.org_id
          : null;

    const grantedScopes = (tokenJson.scope ?? '')
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const hasAccessToken =
      typeof tokenJson.access_token === 'string' && tokenJson.access_token.length > 0;
    const sharing = hasAccessToken && grantedScopes.includes('chatgpt.tokens.use.direct');
    const expiresAt =
      typeof tokenJson.expires_in === 'number'
        ? Date.now() + tokenJson.expires_in * 1000
        : null;

    const nowIso = new Date().toISOString();
    const profileId =
      opts.existingProfileId ??
      `chatgpt_${crypto
        .createHash('sha256')
        .update(`${payload.sub}:${opts.clientId}`)
        .digest('hex')
        .slice(0, 12)}`;

    const existing = this.store.profiles[profileId];
    const stored: StoredChatGptProfile = {
      profileId,
      issuedClientId: opts.clientId,
      flowMode: opts.flowMode,
      issuer: discovery.issuer,
      subject: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : existing?.email ?? null,
      name: typeof payload.name === 'string' ? payload.name : existing?.name ?? null,
      workspaceId,
      idToken: tokenJson.id_token,
      accessToken: tokenJson.access_token ?? null,
      refreshToken: tokenJson.refresh_token ?? existing?.refreshToken ?? null,
      expiresAt,
      grantedScopes,
      sharing,
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
    };

    this.store.profiles[profileId] = stored;
    this.store.activeProfileId = profileId;
    this.saveAuthStore();

    return this.toPublicProfile(stored);
  }

  async completeAuthorizationCallback(params: {
    code?: string;
    state?: string;
    clientId?: string;
    error?: string;
    errorDescription?: string;
  }): Promise<ChatGptProfile> {
    this.pruneExpiredTransactions();

    if (!params.state) {
      throw new Error('Missing OAuth state parameter in callback.');
    }
    const tx = this.transactions.get(params.state);
    if (!tx) {
      throw new Error('OAuth transaction state is invalid or expired. Please start sign-in again.');
    }

    // Consume transaction once
    this.transactions.delete(params.state);
    tx.loopbackServer?.close();

    if (params.error) {
      if (params.error === 'access_denied') {
        throw new Error('Sign in with ChatGPT was canceled or denied.');
      }
      throw new Error(params.errorDescription || `OAuth error: ${params.error}`);
    }

    if (!params.code) {
      throw new Error('Missing authorization code in OpenAI callback.');
    }

    let effectiveClientId: string;
    if (tx.expectedIssuedClientId) {
      if (params.clientId && params.clientId !== tx.expectedIssuedClientId) {
        throw new Error('Callback client_id does not match the selected account registration.');
      }
      effectiveClientId = tx.expectedIssuedClientId;
    } else {
      effectiveClientId = params.clientId || tx.requestedClientId;
      if (!effectiveClientId || effectiveClientId === 'dynamic_agent_client') {
        throw new Error('OpenAI did not return an issued client_id during dynamic registration.');
      }
    }

    return this.exchangeCodeForProfile({
      clientId: effectiveClientId,
      code: params.code,
      codeVerifier: tx.codeVerifier,
      redirectUri: tx.redirectUri,
      flowMode: tx.flowMode,
      expectedNonce: tx.nonce,
      existingProfileId: tx.profileId,
      includeResource: tx.flowMode === 'dynamic_agent',
    });
  }

  private async ensureValidAccessToken(profileId?: string): Promise<{
    profile: StoredChatGptProfile;
    accessToken: string;
  }> {
    const id = profileId ?? this.store.activeProfileId;
    if (!id || !this.store.profiles[id]) {
      throw new Error('No ChatGPT account is currently signed in.');
    }
    const profile = this.store.profiles[id];
    if (!profile.sharing || !profile.accessToken) {
      throw new Error(
        'ChatGPT plan usage (chatgpt.tokens.use.direct) is not enabled for this profile.'
      );
    }

    const needsRefresh =
      profile.expiresAt !== null && Date.now() >= profile.expiresAt - 60_000;

    if (!needsRefresh) {
      return { profile, accessToken: profile.accessToken };
    }

    if (!profile.refreshToken) {
      throw new Error('ChatGPT access token expired and no refresh_token is available. Reconnect your account.');
    }

    const discovery = await this.getDiscovery();
    const refreshBody = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: profile.issuedClientId,
      refresh_token: profile.refreshToken,
      resource: OPENAI_RESOURCE,
    });

    const res = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: refreshBody.toString(),
    });
    const data = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      id_token?: string;
      expires_in?: number;
      scope?: string;
      error?: string;
      error_description?: string;
    };

    if (!res.ok || !data.access_token) {
      throw new Error(
        data.error_description || data.error || 'Failed to refresh ChatGPT OAuth token.'
      );
    }

    profile.accessToken = data.access_token;
    if (data.refresh_token) profile.refreshToken = data.refresh_token;
    if (data.id_token) profile.idToken = data.id_token;
    if (typeof data.expires_in === 'number') {
      profile.expiresAt = Date.now() + data.expires_in * 1000;
    }
    if (data.scope) {
      profile.grantedScopes = data.scope.split(/\s+/).filter(Boolean);
      profile.sharing = profile.grantedScopes.includes('chatgpt.tokens.use.direct');
    }
    profile.updatedAt = new Date().toISOString();
    this.saveAuthStore();

    return { profile, accessToken: profile.accessToken };
  }

  async listModels(profileId?: string): Promise<ChatGptModelInfo[]> {
    const { accessToken } = await this.ensureValidAccessToken(profileId);
    const res = await fetch(`${OPENAI_RESOURCE}/models`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`OpenAI /v1/models failed (${res.status}): ${errText.slice(0, 160)}`);
    }
    const payload = (await res.json()) as {
      models?: Array<{ slug?: string; id?: string; display_name?: string; visibility?: string }>;
      data?: Array<{ id?: string; slug?: string; display_name?: string; visibility?: string }>;
    };

    const rawList = payload.models ?? payload.data ?? [];
    const visible = rawList.filter((m) => !m.visibility || m.visibility === 'list');
    return visible
      .map((m) => ({
        slug: m.slug ?? m.id ?? 'gpt-5',
        display_name: m.display_name ?? m.slug ?? m.id ?? 'ChatGPT Model',
      }))
      .filter((m) => Boolean(m.slug));
  }

  async pickModelSlug(
    preference: 'flagship' | 'fast',
    profileId?: string
  ): Promise<string> {
    const models = await this.listModels(profileId);
    if (models.length === 0) {
      return preference === 'fast' ? 'gpt-5-mini' : 'gpt-5';
    }
    if (preference === 'fast') {
      const fast = models.find((m) => /mini|nano|fast|flash/i.test(m.slug));
      if (fast) return fast.slug;
    }
    return models[0].slug;
  }

  async streamResponses(opts: {
    profileId?: string;
    model?: string;
    preference?: 'flagship' | 'fast';
    input: string;
    instructions?: string;
    timeoutMs?: number;
  }): Promise<{ model: string; text: string }> {
    const { profile, accessToken } = await this.ensureValidAccessToken(opts.profileId);
    const model =
      opts.model ??
      (await this.pickModelSlug(opts.preference ?? 'flagship', profile.profileId));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);

    try {
      const res = await fetch(`${OPENAI_RESOURCE}/responses`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          ...(opts.instructions ? { instructions: opts.instructions } : {}),
          input: [{ role: 'user', content: opts.input }],
          store: false,
          stream: true,
        }),
      });

      if (!res.ok || !res.body) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`OpenAI Responses API error (${res.status}): ${errBody.slice(0, 200)}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let text = '';
      let completed = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const chunks = buffer.split(/\r?\n\r?\n/);
        buffer = chunks.pop() ?? '';

        for (const chunk of chunks) {
          const dataLines = chunk
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim());

          for (const rawData of dataLines) {
            if (!rawData || rawData === '[DONE]') continue;
            try {
              const event = JSON.parse(rawData) as {
                type?: string;
                delta?: string;
                response?: { error?: { code?: string; message?: string } };
              };
              if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
                text += event.delta;
              } else if (event.type === 'response.failed') {
                const msg =
                  event.response?.error?.message ||
                  event.response?.error?.code ||
                  'OpenAI response failed.';
                throw new Error(msg);
              } else if (event.type === 'response.completed') {
                completed = true;
              }
            } catch (parseErr) {
              if (parseErr instanceof Error && !parseErr.message.includes('JSON')) {
                throw parseErr;
              }
            }
          }
        }
      }

      if (!completed) {
        throw new Error('OpenAI stream ended without response.completed.');
      }
      return { model, text: text.trim() };
    } finally {
      clearTimeout(timer);
    }
  }

  async logout(profileId?: string, removeProfile = false): Promise<void> {
    const id = profileId ?? this.store.activeProfileId;
    if (!id || !this.store.profiles[id]) return;
    const profile = this.store.profiles[id];

    // Best-effort OAuth token revocation
    try {
      const discovery = await this.getDiscovery();
      const tokenToRevoke = profile.refreshToken || profile.accessToken;
      if (tokenToRevoke) {
        await fetch(discovery.revocation_endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: profile.issuedClientId,
            token: tokenToRevoke,
          }).toString(),
        });
      }
    } catch {
      // Proceed with local credential cleanup even if revocation network fails
    }

    if (removeProfile) {
      delete this.store.profiles[id];
    } else {
      // Per cookbook Step 3: retain registration metadata through logout
      profile.accessToken = null;
      profile.refreshToken = null;
      profile.expiresAt = null;
      profile.sharing = false;
      profile.updatedAt = new Date().toISOString();
    }

    if (this.store.activeProfileId === id) {
      const next = Object.values(this.store.profiles).find((p) => p.accessToken);
      this.store.activeProfileId = next?.profileId ?? null;
    }
    this.saveAuthStore();
  }
}

export function extractClaimSummary(payload: JWTPayload): string {
  return typeof payload.email === 'string' ? payload.email : String(payload.sub ?? '');
}

export function buildPopupCompletionHtml(profile: ChatGptProfile, targetOrigin = '*'): string {
  const safePayload = JSON.stringify({
    type: 'OAUTH_AUTH_SUCCESS',
    provider: 'chatgpt',
    profileId: profile.profileId,
    email: profile.email,
    sharing: profile.sharing,
  });
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>ChatGPT Sign-In Complete</title></head>
  <body style="font-family: system-ui, sans-serif; padding: 32px; color: #0f172a;">
    <h1 style="font-size: 18px; margin-bottom: 8px;">Connected to ChatGPT</h1>
    <p style="font-size: 14px; color: #475569;">Authentication complete for ${escapeHtml(profile.email ?? profile.subject)}. You can close this window.</p>
    <script>
      if (window.opener) {
        window.opener.postMessage(${safePayload}, ${JSON.stringify(targetOrigin)});
        window.opener.postMessage(${safePayload}, '*');
        window.close();
      } else {
        window.location.href = '/';
      }
    </script>
  </body>
</html>`;
}

export function buildPopupErrorHtml(message: string): string {
  const safeErr = JSON.stringify({
    type: 'OAUTH_AUTH_ERROR',
    provider: 'chatgpt',
    error: message,
  });
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>ChatGPT Sign-In Failed</title></head>
  <body style="font-family: system-ui, sans-serif; padding: 32px; color: #881337;">
    <h1 style="font-size: 18px; margin-bottom: 8px;">Sign in with ChatGPT Error</h1>
    <p style="font-size: 14px;">${escapeHtml(message)}</p>
    <script>
      if (window.opener) {
        window.opener.postMessage(${safeErr}, '*');
      }
    </script>
  </body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
