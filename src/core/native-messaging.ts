// Native messaging transport.
//
// Tries each known host in order; the first one to respond to a ping wins.
// On disconnect we drop state — reconnect is driven externally
// (UI action or app event), not on a timer, since the v1 behaviour was
// to surface "host not installed" rather than retry forever.

import {
  NATIVE_HOSTS,
  StorageKey,
  type NativeIncoming,
  type NativeOutgoing,
  type ToolResult,
} from './protocol';
import { set as storageSet } from './storage';
import { handleInvocation, type Transport } from './router';
import { trackEvent } from './analytics';

const PING_TIMEOUT_MS = 10_000;

let port: chrome.runtime.Port | null = null;
let connectedHostName: string | null = null;
let connecting = false;
let mcpConnected = false;

type StatusListener = (status: { hostInstalled: boolean; mcpConnected: boolean }) => void;
const statusListeners = new Set<StatusListener>();

function emitStatus(): void {
  const status = { hostInstalled: port !== null, mcpConnected };
  for (const l of statusListeners) l(status);
}

export function onStatusChange(listener: StatusListener): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

export function getConnectedHostName(): string | null {
  return connectedHostName;
}

export function isMcpConnected(): boolean {
  return mcpConnected;
}

export function getStatus(): { hostInstalled: boolean; mcpConnected: boolean } {
  return { hostInstalled: port !== null, mcpConnected };
}

// ============================================================
// Transport interface
// ============================================================

export const nativeTransport: Transport = {
  name: 'native',
  isConnected: () => port !== null,
  connect,
  disconnect,
  sendNotification(method, params) {
    return send({ type: 'notification', jsonrpc: '2.0', method, params: params ?? {} });
  },
};

// ============================================================
// Connect / disconnect
// ============================================================

async function connect(): Promise<boolean> {
  if (port) return true;
  if (connecting) return false;
  if (typeof chrome.runtime.connectNative !== 'function') return false;

  connecting = true;
  try {
    for (const host of NATIVE_HOSTS) {
      const candidate = tryHost(host.name);
      if (await candidate) return true;
    }
    return false;
  } finally {
    connecting = false;
  }
}

function tryHost(hostName: string): Promise<boolean> {
  return new Promise((resolve) => {
    let p: chrome.runtime.Port;
    try {
      p = chrome.runtime.connectNative(hostName);
    } catch {
      resolve(false);
      return;
    }

    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (ok) {
        port = p;
        connectedHostName = hostName;
        attachPersistentListeners(p);
        // Probe for current MCP state.
        send({ type: 'get_status' });
        emitStatus();
        resolve(true);
      } else {
        try { p.disconnect(); } catch {}
        resolve(false);
      }
    };

    const onMsg = (msg: NativeIncoming) => {
      if (msg.type === 'pong') {
        p.onMessage.removeListener(onMsg);
        p.onDisconnect.removeListener(onClose);
        finish(true);
      }
    };
    const onClose = () => {
      void chrome.runtime.lastError;
      finish(false);
    };

    p.onMessage.addListener(onMsg);
    p.onDisconnect.addListener(onClose);

    try { p.postMessage({ type: 'ping' }); }
    catch { finish(false); return; }

    setTimeout(() => finish(false), PING_TIMEOUT_MS);
  });
}

function attachPersistentListeners(p: chrome.runtime.Port): void {
  p.onMessage.addListener((msg: NativeIncoming) => {
    void handleIncoming(msg);
  });
  p.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    port = null;
    connectedHostName = null;
    setMcp(false);
    emitStatus();
    trackEvent('dyspel.native.disconnected');
  });
}

function disconnect(): void {
  if (!port) return;
  try { port.disconnect(); } catch {}
  port = null;
  connectedHostName = null;
  setMcp(false);
  emitStatus();
}

// ============================================================
// Inbound dispatch
// ============================================================

async function handleIncoming(msg: NativeIncoming): Promise<void> {
  switch (msg.type) {
    case 'pong':
    case 'status_response':
      return;

    case 'mcp_connected':
      setMcp(true);
      emitStatus();
      return;

    case 'mcp_disconnected':
      setMcp(false);
      emitStatus();
      return;

    case 'tool_request':
      await handleToolRequest(msg);
      return;
  }
}

async function handleToolRequest(
  msg: Extract<NativeIncoming, { type: 'tool_request' }>,
): Promise<void> {
  const { tool, args, client_id, tabId, tabGroupId, session_scope } = msg.params;
  // The agent may put tabId either in params.tabId (cc-wasm older path)
  // or args.tabId (newer path that mirrors the bridge format). Honor
  // both so the hint reaches dispatch's resolveTab().
  const safeArgs = args ?? {};
  const argTabId = typeof safeArgs.tabId === 'number' ? safeArgs.tabId : undefined;
  await handleInvocation({
    tool,
    args: safeArgs,
    source: 'native',
    clientId: client_id,
    tabId: typeof tabId === 'number' ? tabId : argTabId,
    tabGroupId,
    sessionScope: session_scope,
    reply: (result) => sendToolResponse(result),
  });
}

// ============================================================
// Outbound
// ============================================================

function send(message: NativeOutgoing): boolean {
  if (!port) return false;
  try {
    port.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

function sendToolResponse(result: ToolResult): void {
  const { content, is_error } = result;
  if (!content) return;
  if (is_error) {
    send({ type: 'tool_response', error: { content } });
  } else {
    send({ type: 'tool_response', result: { content } });
  }
}

function setMcp(value: boolean): void {
  if (mcpConnected === value) return;
  mcpConnected = value;
  void storageSet(StorageKey.MCP_CONNECTED, value);
}
