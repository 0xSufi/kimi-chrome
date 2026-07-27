// Wire-format types and constants shared across transports.
//
// These shapes are part of the contract with cc-wasm and the bridge relay.
// Do not change a field name without updating both ends.

// ============================================================
// Tool result content (used by both native and bridge wire formats)
// ============================================================

export type ToolContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

export type ToolContent = string | ToolContentBlock[];

export interface ToolResult {
  content: ToolContent;
  is_error?: boolean;
}

// ============================================================
// Native messaging wire format (chrome.runtime.connectNative)
// ============================================================

export type NativeOutgoing =
  | { type: 'ping' }
  | { type: 'get_status' }
  | { type: 'tool_response'; result: { content: ToolContent } }
  | { type: 'tool_response'; error: { content: ToolContent } }
  | { type: 'notification'; jsonrpc: '2.0'; method: string; params: Record<string, unknown> };

export type NativeIncoming =
  | { type: 'pong'; timestamp?: number }
  | { type: 'status_response'; native_host_version?: string }
  | { type: 'mcp_connected' }
  | { type: 'mcp_disconnected' }
  | {
      type: 'tool_request';
      method: 'execute_tool';
      params: {
        tool: string;
        args: Record<string, unknown>;
        client_id?: string;
        tabGroupId?: number | string;
        tabId?: number | string;
        session_scope?: string;
      };
    };

// No Kimi-side native messaging host exists yet; this is the name a
// future host manifest must register under for the native transport
// to find it. The transport degrades gracefully when absent.
export const NATIVE_HOSTS = [
  { name: 'com.moonshot.kimi_code_browser_extension', label: 'Kimi CLI' },
] as const;

// ============================================================
// Bridge wire format (WebSocket)
// ============================================================

// Default bridge endpoint: the local tool shim (shim/ in this repo),
// which relays tool_call/tool_result frames between kimi-code (MCP)
// and this extension. Override via StorageKey.LOCAL_BRIDGE_URL.
export const BRIDGE_URL_DEFAULT = 'ws://127.0.0.1:8765';

export type BridgeOutgoing =
  | { type: 'connect'; client_type: 'chrome-extension'; device_id: string; os_platform: string; extension_version: string; display_name?: string }
  | { type: 'ping' }
  | { type: 'pong' }
  | { type: 'tool_result'; tool_use_id: string; result?: { content: ToolContent }; error?: { content: ToolContent } }
  | { type: 'pairing_response'; request_id: string; device_id: string; name: string }
  | { type: 'notification'; method: string; params: Record<string, unknown> };

export interface BridgeToolCall {
  type: 'tool_call';
  tool: string;
  args: Record<string, unknown>;
  tool_use_id: string;
  target_device_id?: string;
  client_type?: string;
  permission_mode?: string;
  allowed_domains?: string[];
  session_scope?: string;
}

export interface BridgePairingRequest {
  type: 'pairing_request';
  request_id: string;
  client_type?: string;
}

export type BridgeIncoming =
  | { type: 'paired' | 'waiting' }
  | { type: 'ping' }
  | { type: 'pong' }
  | { type: 'peer_connected' | 'peer_disconnected' }
  | BridgeToolCall
  | BridgePairingRequest
  | { type: 'permission_response'; request_id: string; allowed?: boolean }
  | { type: 'error'; message?: string };

// ============================================================
// Storage keys
// ============================================================

export enum StorageKey {
  // Bridge identity
  BRIDGE_DEVICE_ID = 'bridgeDeviceId',
  BRIDGE_DISPLAY_NAME = 'bridgeDisplayName',
  LOCAL_BRIDGE_URL = 'LOCAL_BRIDGE_URL',

  // Connection state mirror
  MCP_CONNECTED = 'MCP_CONNECTED',

  // Scheduled prompts (Phase E)
  SAVED_PROMPTS = 'savedPrompts',

  // Permissions (Phase E)
  PERMISSIONS = 'permissions',

  // Tab groups (Phase E)
  TAB_GROUPS = 'tabGroups',
  TARGET_TAB_ID = 'TARGET_TAB_ID',
}

// ============================================================
// Internal extension messages (chrome.runtime.sendMessage)
// ============================================================

export const enum InternalMessage {
  SW_KEEPALIVE = 'SW_KEEPALIVE',
  PAIRING_CONFIRMED = 'pairing_confirmed',
  PAIRING_DISMISSED = 'pairing_dismissed',
  PING = 'ping',
}
