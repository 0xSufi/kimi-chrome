// Transport-agnostic dispatch.
//
// Each transport (native messaging, bridge) parses its own wire format,
// produces a normalized ToolInvocation, and hands it to dispatch().
// The reply callback closes the loop in whatever shape the transport needs.
//
// Phase B: dispatch is a stub that returns "not implemented".
// Phase C: tool registry replaces the stub via setDispatch().

import type { ToolResult } from './protocol';

export interface ToolInvocation {
  tool: string;
  args: Record<string, unknown>;
  source: 'native' | 'bridge';

  // Targeting hints — transports pass through whatever they got.
  tabId?: number;
  tabGroupId?: number | string;
  clientId?: string;
  sessionScope?: string;

  // Bridge-only hints.
  permissionMode?: string;
  allowedDomains?: string[];
  toolUseId?: string;

  // Reply: transport closes the loop in its own wire format.
  reply: (result: ToolResult) => void;
}

export interface Transport {
  readonly name: 'native' | 'bridge';
  isConnected(): boolean;
  connect(): Promise<boolean>;
  disconnect(): void;
  sendNotification(method: string, params?: Record<string, unknown>): boolean;
}

type Dispatch = (inv: ToolInvocation) => Promise<void>;

let dispatch: Dispatch = async (inv) => {
  inv.reply({
    content: `Tool '${inv.tool}' is not implemented in this build`,
    is_error: true,
  });
};

export function setDispatch(fn: Dispatch): void {
  dispatch = fn;
}

export async function handleInvocation(inv: ToolInvocation): Promise<void> {
  try {
    await dispatch(inv);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    inv.reply({ content: message, is_error: true });
  }
}

// ============================================================
// Notification fan-out
// ============================================================

const transports = new Set<Transport>();

export function registerTransport(t: Transport): void {
  transports.add(t);
}

export function broadcastNotification(method: string, params?: Record<string, unknown>): void {
  for (const t of transports) {
    if (t.isConnected()) t.sendNotification(method, params);
  }
}
