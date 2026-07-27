// WebSocket bridge transport.
//
// Connects to wss://bridge.claudeusercontent.com/chrome/{accessToken}
// in production. For local-relay dev, set chrome.storage.local
// LOCAL_BRIDGE_URL to a ws://localhost URL — the relay ignores the
// path token. See cc-wasm-bridge for the matching server.

import {
  BRIDGE_URL_PROD,
  StorageKey,
  type BridgeIncoming,
  type BridgeOutgoing,
  type BridgePairingRequest,
  type BridgeToolCall,
  type ToolResult,
} from './protocol';
import { get as storageGet, set as storageSet } from './storage';
import { handleInvocation, type Transport } from './router';
import { trackEvent } from './analytics';

const KEEPALIVE_MS = 20_000;
const KEEPALIVE_ALARM = 'dyspel-bridge-keepalive';
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 20_000;

let ws: WebSocket | null = null;
let connecting = false;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
let cachedDeviceId: string | null = null;
let lastPairingRequestId: string | undefined;
type BridgeStatus = 'disconnected' | 'connecting' | 'paired' | 'waiting';
let bridgeStatus: BridgeStatus = 'disconnected';

type StatusListener = (status: BridgeStatus) => void;
const statusListeners = new Set<StatusListener>();

export function onBridgeStatusChange(listener: StatusListener): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

export function getBridgeStatus(): BridgeStatus {
  return bridgeStatus;
}

function setStatus(next: BridgeStatus): void {
  if (bridgeStatus === next) return;
  bridgeStatus = next;
  for (const l of statusListeners) l(next);
}

// ============================================================
// Transport interface
// ============================================================

export const bridgeTransport: Transport = {
  name: 'bridge',
  isConnected: () => ws?.readyState === WebSocket.OPEN,
  connect,
  disconnect,
  sendNotification(method, params) {
    return send({ type: 'notification', method, params: params ?? {} });
  },
};

// ============================================================
// Lifecycle wiring (called from service worker)
// ============================================================

let initialized = false;

export function initialize(): void {
  if (initialized) return;
  initialized = true;

  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== KEEPALIVE_ALARM) return;
    if (!bridgeTransport.isConnected() && !connecting) void connect();
    else send({ type: 'ping' });
  });

  // Kick a reconnect the moment the OAuth callback lands an access
  // token so the user doesn't sit through the next reconnect tick.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[StorageKey.ACCESS_TOKEN] || changes[StorageKey.LOCAL_BRIDGE_URL]) {
      const newToken = changes[StorageKey.ACCESS_TOKEN]?.newValue;
      if (!newToken && !changes[StorageKey.LOCAL_BRIDGE_URL]) {
        // Token was cleared (logout) — drop the live socket.
        disconnect();
        return;
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      reconnectAttempt = 0;
      if (ws) {
        try { ws.close(); } catch {}
        ws = null;
      }
      void connect();
    }
  });
}

// ============================================================
// Connect / disconnect
// ============================================================

async function connect(): Promise<boolean> {
  if (ws?.readyState === WebSocket.OPEN || connecting) return false;
  connecting = true;
  setStatus('connecting');

  try {
    const url = await resolveUrl();
    if (!url) {
      connecting = false;
      setStatus('disconnected');
      scheduleReconnect();
      return false;
    }

    const next = new WebSocket(url);
    ws = next;

    next.onopen = async () => {
      if (ws !== next) return;
      const display_name = await storageGet<string>(StorageKey.BRIDGE_DISPLAY_NAME);
      const device_id = await getDeviceId();
      const message: BridgeOutgoing = {
        type: 'connect',
        client_type: 'chrome-extension',
        device_id,
        os_platform: getPlatform(),
        extension_version: chrome.runtime.getManifest().version,
        ...(display_name ? { display_name } : {}),
      };
      next.send(JSON.stringify(message));
    };

    next.onmessage = (event) => {
      if (ws !== next) return;
      try {
        const parsed = JSON.parse(event.data) as BridgeIncoming;
        void handleIncoming(parsed);
      } catch {}
    };

    next.onclose = (event) => {
      if (ws !== next) return;
      ws = null;
      connecting = false;
      stopKeepalive();
      setStatus('disconnected');
      trackEvent('dyspel.bridge.disconnected', { code: event.code });
      scheduleReconnect();
    };

    next.onerror = () => {
      if (ws === next) connecting = false;
    };

    return true;
  } catch {
    connecting = false;
    setStatus('disconnected');
    scheduleReconnect();
    return false;
  }
}

function disconnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempt = 0;
  connecting = false;
  stopKeepalive();
  if (ws) {
    ws.onclose = null;
    try { ws.close(); } catch {}
    ws = null;
  }
  setStatus('disconnected');
}

async function resolveUrl(): Promise<string | null> {
  const localOverride = await storageGet<string>(StorageKey.LOCAL_BRIDGE_URL);
  if (typeof localOverride === 'string' && localOverride) return localOverride;

  // Production token: oauth.ts writes it under StorageKey.ACCESS_TOKEN
  // in chrome.storage.local. Read from the same place — the v1's split
  // (oauth → local, bridge → sync) was a bug we carried over.
  const accessToken = await storageGet<string>(StorageKey.ACCESS_TOKEN);
  if (!accessToken) return null;
  return `${BRIDGE_URL_PROD}/chrome/${accessToken}`;
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectAttempt += 1;
  const delay = Math.min(RECONNECT_BASE_MS * 1.5 ** (reconnectAttempt - 1), RECONNECT_MAX_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}

// ============================================================
// Keepalive
// ============================================================

function startKeepalive(): void {
  stopKeepalive();
  keepaliveTimer = setInterval(() => send({ type: 'ping' }), KEEPALIVE_MS);
}

function stopKeepalive(): void {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}

// ============================================================
// Inbound dispatch
// ============================================================

async function handleIncoming(msg: BridgeIncoming): Promise<void> {
  switch (msg.type) {
    case 'paired':
    case 'waiting':
      reconnectAttempt = 0;
      connecting = false;
      startKeepalive();
      setStatus(msg.type);
      trackEvent('dyspel.bridge.connected', { status: msg.type });
      return;

    case 'ping':
      send({ type: 'pong' });
      return;

    case 'pong':
    case 'peer_connected':
    case 'peer_disconnected':
    case 'permission_response':
    case 'error':
      return;

    case 'tool_call':
      await handleToolCall(msg);
      return;

    case 'pairing_request':
      await handlePairingRequest(msg);
      return;
  }
}

async function handleToolCall(msg: BridgeToolCall): Promise<void> {
  const myDeviceId = await getDeviceId();
  if (msg.target_device_id && msg.target_device_id !== myDeviceId) return;
  if (!msg.tool_use_id || !msg.tool) return;

  const args = msg.args ?? {};
  await handleInvocation({
    tool: msg.tool,
    args,
    source: 'bridge',
    clientId: msg.client_type,
    tabId: typeof args.tabId === 'number' ? (args.tabId as number) : undefined,
    tabGroupId: typeof args.tabGroupId === 'number' || typeof args.tabGroupId === 'string'
      ? (args.tabGroupId as number | string)
      : undefined,
    sessionScope: msg.session_scope,
    permissionMode: msg.permission_mode,
    allowedDomains: msg.allowed_domains,
    toolUseId: msg.tool_use_id,
    reply: (result) => sendToolResult(msg.tool_use_id, result),
  });
}

async function handlePairingRequest(msg: BridgePairingRequest): Promise<void> {
  if (!msg.request_id || msg.request_id === lastPairingRequestId) return;
  lastPairingRequestId = msg.request_id;

  const clientType = msg.client_type ?? 'desktop';
  const currentName = await storageGet<string>(StorageKey.BRIDGE_DISPLAY_NAME);

  // Try sidepanel first.
  try {
    const reply = await chrome.runtime.sendMessage({
      type: 'show_pairing_prompt',
      request_id: msg.request_id,
      client_type: clientType,
      current_name: currentName,
    });
    if (reply?.handled) return;
  } catch {}

  const params = new URLSearchParams({
    request_id: msg.request_id,
    client_type: clientType,
    current_name: currentName ?? '',
  });
  void chrome.tabs.create({ url: chrome.runtime.getURL(`pairing.html?${params}`) });
}

export async function confirmPairing(requestId: string, name: string): Promise<void> {
  await storageSet(StorageKey.BRIDGE_DISPLAY_NAME, name);
  const device_id = await getDeviceId();
  send({ type: 'pairing_response', request_id: requestId, device_id, name });
}

// ============================================================
// Outbound
// ============================================================

function send(message: BridgeOutgoing): boolean {
  if (ws?.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

function sendToolResult(toolUseId: string, result: ToolResult): void {
  if (!result.content) return;
  if (result.is_error) {
    send({ type: 'tool_result', tool_use_id: toolUseId, error: { content: result.content } });
  } else {
    send({ type: 'tool_result', tool_use_id: toolUseId, result: { content: result.content } });
  }
}

// ============================================================
// Identity
// ============================================================

async function getDeviceId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId;
  const stored = await storageGet<string>(StorageKey.BRIDGE_DEVICE_ID);
  if (stored) {
    cachedDeviceId = stored;
    return stored;
  }
  const fresh = crypto.randomUUID();
  cachedDeviceId = fresh;
  await storageSet(StorageKey.BRIDGE_DEVICE_ID, fresh);
  return fresh;
}

function getPlatform(): string {
  try {
    return (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform
      ?? navigator.platform
      ?? 'Unknown';
  } catch {
    return 'Unknown';
  }
}
