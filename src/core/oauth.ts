// PKCE OAuth flow against claude.ai.
//
// initiateOAuthFlow() opens a tab to the authorize URL; the
// oauth_callback.html page in public/ posts the redirect back to
// the service worker, which calls handleOAuthRedirect(). Refresh
// happens lazily via getAccessToken() — callers always go through it.

import { StorageKey } from './protocol';
import { get as storageGet, getMany, set as storageSet, remove as storageRemove } from './storage';

const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const ACCOUNT_URL = 'https://api.anthropic.com/api/oauth/account/settings';
const CLIENT_ID = 'dae2cad8-15c5-43d2-9046-fcaecc135fa4';
const SCOPES = 'user:profile user:inference user:chat';
const REFRESH_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour
const TOKEN_FETCH_TIMEOUT_MS = 15_000;

// ============================================================
// PKCE primitives
// ============================================================

function base64UrlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function randomBase64Url(byteLen: number): string {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

function redirectUri(): string {
  return `chrome-extension://${chrome.runtime.id}/oauth_callback.html`;
}

// ============================================================
// Public API
// ============================================================

export async function initiateOAuthFlow(): Promise<void> {
  const state = randomBase64Url(32);
  const verifier = randomBase64Url(32);
  const challenge = await codeChallenge(verifier);

  await chrome.storage.local.set({
    [StorageKey.OAUTH_STATE]: state,
    [StorageKey.CODE_VERIFIER]: verifier,
  });

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    scope: SCOPES,
    redirect_uri: redirectUri(),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  await chrome.tabs.create({ url: `${AUTHORIZE_URL}?${params}` });
}

export interface RedirectResult { ok: boolean; error?: string }

export async function handleOAuthRedirect(redirectUrl: string, sourceTabId?: number): Promise<RedirectResult> {
  let url: URL;
  try { url = new URL(redirectUrl); }
  catch { return { ok: false, error: 'Bad redirect URL' }; }

  const error = url.searchParams.get('error');
  if (error) return { ok: false, error: url.searchParams.get('error_description') ?? error };

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return { ok: false, error: 'Missing code or state' };

  const stored = await getMany<{ [StorageKey.OAUTH_STATE]?: string; [StorageKey.CODE_VERIFIER]?: string }>([
    StorageKey.OAUTH_STATE,
    StorageKey.CODE_VERIFIER,
  ]);
  const storedState = stored[StorageKey.OAUTH_STATE];
  const verifier = stored[StorageKey.CODE_VERIFIER];

  if (!storedState || storedState !== state) return { ok: false, error: 'OAuth state mismatch' };
  if (!verifier) return { ok: false, error: 'Missing PKCE verifier' };

  const exchange = await tokenRequest({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code,
    redirect_uri: redirectUri(),
    state,
    code_verifier: verifier,
  });

  if (!exchange.ok || !exchange.accessToken) {
    return { ok: false, error: exchange.error ?? 'Token exchange failed' };
  }

  await persistTokens(exchange);
  await storageRemove(StorageKey.OAUTH_STATE, StorageKey.CODE_VERIFIER);
  if (sourceTabId != null) {
    try { await chrome.tabs.remove(sourceTabId); } catch {}
  }
  void fetchAccountUuid();
  return { ok: true };
}

export async function getAccessToken(): Promise<string | null> {
  const stored = await currentTokens();
  if (!stored.accessToken) return null;

  const expiry = stored.tokenExpiry ?? 0;
  const remaining = expiry - Date.now();
  if (remaining > REFRESH_THRESHOLD_MS) return stored.accessToken;

  if (!stored.refreshToken) return remaining > 0 ? stored.accessToken : null;

  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await tokenRequest({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: stored.refreshToken,
    });
    if (r.ok && r.accessToken) {
      await persistTokens({ ...r, refreshToken: r.refreshToken ?? stored.refreshToken });
      return r.accessToken;
    }
    if (r.failureReason === 'invalid_grant') {
      await storageRemove(StorageKey.REFRESH_TOKEN);
      return null;
    }
  }

  return remaining > 0 ? stored.accessToken : null;
}

export async function logout(): Promise<void> {
  await storageRemove(
    StorageKey.ACCESS_TOKEN,
    StorageKey.REFRESH_TOKEN,
    StorageKey.TOKEN_EXPIRY,
    StorageKey.OAUTH_STATE,
    StorageKey.CODE_VERIFIER,
    StorageKey.ACCOUNT_UUID,
  );
}

// ============================================================
// Internals
// ============================================================

interface TokenResult {
  ok: boolean;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  error?: string;
  failureReason?: 'invalid_grant' | 'server_error';
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResult> {
  try {
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(TOKEN_FETCH_TIMEOUT_MS),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      const failureReason: 'invalid_grant' | 'server_error' =
        resp.status === 400 && text.includes('invalid_grant') ? 'invalid_grant' : 'server_error';
      return { ok: false, error: `Token request failed: ${resp.status}`, failureReason };
    }

    const data = (await resp.json()) as {
      error?: string;
      error_description?: string;
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };

    if (data.error) {
      return {
        ok: false,
        error: data.error_description ?? data.error,
        failureReason: data.error === 'invalid_grant' ? 'invalid_grant' : 'server_error',
      };
    }

    return {
      ok: true,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function persistTokens(result: TokenResult): Promise<void> {
  if (!result.accessToken) return;
  await storageSet(StorageKey.ACCESS_TOKEN, result.accessToken);
  if (result.refreshToken) await storageSet(StorageKey.REFRESH_TOKEN, result.refreshToken);
  if (result.expiresAt) await storageSet(StorageKey.TOKEN_EXPIRY, result.expiresAt);
}

async function currentTokens(): Promise<{ accessToken?: string; refreshToken?: string; tokenExpiry?: number }> {
  return getMany([
    StorageKey.ACCESS_TOKEN,
    StorageKey.REFRESH_TOKEN,
    StorageKey.TOKEN_EXPIRY,
  ]);
}

async function fetchAccountUuid(): Promise<void> {
  const token = await storageGet<string>(StorageKey.ACCESS_TOKEN);
  if (!token) return;
  try {
    const resp = await fetch(ACCOUNT_URL, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return;
    const data = (await resp.json()) as { uuid?: string };
    if (data.uuid) await storageSet(StorageKey.ACCOUNT_UUID, data.uuid);
  } catch {}
}
