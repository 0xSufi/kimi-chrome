// Sidepanel chat ↔ cc-wasm host server.
//
// Two channels share one WebSocket, demultiplexed by the top-level
// field on each frame:
//
//   stream-json (agent ↔ user) — frames have `type`
//     ↓ assistant text deltas, results, control_request (permission)
//     ↑ user message, control_response (permission reply), interrupt
//
//   relay (host-side cc-wasm ↔ extension's chrome.debugger) — `kind`
//     ↓ { kind: 'tool_call', tool_use_id, tool, args }
//     ↑ { kind: 'tool_result', tool_use_id, content }
//
// Auth: WebSocket can't set headers in the browser, so we append
// ?token=<bearer> (matches HOST_AUTH_TOKEN on the server side).

import { invokeTool } from '../../tools/registry';

const STORAGE_KEY_HOST_URL = 'DYSPEL_HOST_URL';
const STORAGE_KEY_HOST_TOKEN = 'DYSPEL_HOST_TOKEN';

export interface HostClientConfig {
  hostUrl: string;
  authToken: string;
}

export async function readHostConfig(): Promise<HostClientConfig | null> {
  const stored = await chrome.storage.local.get([STORAGE_KEY_HOST_URL, STORAGE_KEY_HOST_TOKEN]);
  const hostUrl = stored[STORAGE_KEY_HOST_URL];
  const authToken = stored[STORAGE_KEY_HOST_TOKEN];
  if (typeof hostUrl !== 'string' || typeof authToken !== 'string' || !hostUrl || !authToken) return null;
  return { hostUrl, authToken };
}

export async function writeHostConfig(cfg: HostClientConfig): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE_KEY_HOST_URL]: cfg.hostUrl,
    [STORAGE_KEY_HOST_TOKEN]: cfg.authToken,
  });
}

// ============================================================
// Wire frames
// ============================================================

interface SdkAssistantMessage {
  type: 'assistant';
  message: {
    role: 'assistant';
    content: Array<
      | { type: 'text'; text: string }
      | { type: 'tool_use'; id: string; name: string; input: unknown }
      | { type: 'thinking'; thinking?: string }
    >;
  };
  session_id?: string;
}

interface SdkResultMessage { type: 'result'; result?: string; total_cost_usd?: number; session_id?: string }
interface SdkControlRequest { type: 'control_request'; request_id: string; request: { subtype: string; [k: string]: unknown } }
interface RelayToolCall { kind: 'tool_call'; tool_use_id: string; tool: string; args: Record<string, unknown> }
interface RelayHello { kind: 'hello'; session_id: string }

type IncomingFrame =
  | SdkAssistantMessage
  | SdkResultMessage
  | SdkControlRequest
  | RelayToolCall
  | RelayHello
  | { type: string; [k: string]: unknown };

export interface HostClientCallbacks {
  onTextDelta?: (text: string) => void;
  onToolUse?: (block: { id: string; name: string; input: unknown }) => void;
  onResult?: (msg: SdkResultMessage) => void;
  onPermissionRequest?: (req: SdkControlRequest) => void;
  onOpen?: () => void;
  onClose?: (reason?: string) => void;
  onError?: (err: Error) => void;
}

// ============================================================
// Client
// ============================================================

export class HostClient {
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private connectPromise: Promise<void> | null = null;
  private queue: string[] = [];

  constructor(private cfg: HostClientConfig, private cb: HostClientCallbacks = {}) {}

  async sendUserMessage(text: string): Promise<void> {
    await this.ensureConnected();
    this.send(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: this.sessionId ?? '',
    }));
  }

  sendInterrupt(): void {
    this.send(JSON.stringify({
      type: 'control_request',
      request_id: crypto.randomUUID(),
      request: { subtype: 'interrupt' },
    }));
  }

  close(): void {
    if (this.ws) {
      try { this.ws.close(1000, 'client closing'); } catch {}
      this.ws = null;
      this.sessionId = null;
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.doConnect().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async doConnect(): Promise<void> {
    const httpUrl = this.cfg.hostUrl.replace(/\/$/, '');
    const sessionResp = await fetch(`${httpUrl}/sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.cfg.authToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/home/project' }),
    });
    if (!sessionResp.ok) {
      throw new Error(`POST /sessions returned ${sessionResp.status} ${sessionResp.statusText}`);
    }
    const session = (await sessionResp.json()) as { session_id: string; ws_url: string };
    this.sessionId = session.session_id;

    const wsUrl = session.ws_url + (session.ws_url.includes('?') ? '&' : '?')
      + 'token=' + encodeURIComponent(this.cfg.authToken);
    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.cb.onOpen?.();
      for (const frame of this.queue) ws.send(frame);
      this.queue = [];
    });
    ws.addEventListener('message', (ev) => this.handleFrame(ev));
    ws.addEventListener('close', (ev) => {
      if (this.ws === ws) {
        this.ws = null;
        this.sessionId = null;
      }
      this.cb.onClose?.(ev.reason || undefined);
    });
    ws.addEventListener('error', () => this.cb.onError?.(new Error('websocket error')));

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => { ws.removeEventListener('error', onErr); resolve(); };
      const onErr = () => { ws.removeEventListener('open', onOpen); reject(new Error('ws connect failed')); };
      ws.addEventListener('open', onOpen, { once: true });
      ws.addEventListener('error', onErr, { once: true });
    });
  }

  private send(frame: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(frame);
    } else {
      this.queue.push(frame);
    }
  }

  private handleFrame(event: MessageEvent): void {
    const data = typeof event.data === 'string' ? event.data : '';
    if (!data) return;
    let msg: IncomingFrame;
    try { msg = JSON.parse(data) as IncomingFrame; }
    catch { return; }

    if ('kind' in msg && (msg as { kind?: string }).kind === 'tool_call') {
      void this.handleToolCall(msg as RelayToolCall);
      return;
    }
    if ('kind' in msg) return; // hello, etc.

    if (msg.type === 'assistant') {
      const am = msg as SdkAssistantMessage;
      for (const block of am.message?.content ?? []) {
        if (block.type === 'text') this.cb.onTextDelta?.(block.text);
        else if (block.type === 'tool_use') {
          this.cb.onToolUse?.({ id: block.id, name: block.name, input: block.input });
        }
      }
      return;
    }

    if (msg.type === 'result') {
      this.cb.onResult?.(msg as SdkResultMessage);
      return;
    }

    if (msg.type === 'control_request') {
      const cr = msg as SdkControlRequest;
      if (cr.request?.subtype === 'can_use_tool') {
        if (this.cb.onPermissionRequest) {
          this.cb.onPermissionRequest(cr);
        } else {
          // No handler → auto-allow (parity with v1 default).
          this.send(JSON.stringify({
            type: 'control_response',
            response: {
              subtype: 'success',
              request_id: cr.request_id,
              response: { behavior: 'allow', updatedInput: {} },
            },
          }));
        }
      }
    }
  }

  private async handleToolCall(msg: RelayToolCall): Promise<void> {
    try {
      const result = await invokeTool({
        tool: msg.tool,
        args: msg.args ?? {},
        source: 'bridge',
        clientId: 'host-server-relay',
      });
      const content = Array.isArray(result.content)
        ? result.content
        : [{ type: 'text' as const, text: typeof result.content === 'string' ? result.content : JSON.stringify(result.content) }];
      this.send(JSON.stringify(
        result.is_error
          ? { kind: 'tool_result', tool_use_id: msg.tool_use_id, error: { content } }
          : { kind: 'tool_result', tool_use_id: msg.tool_use_id, content },
      ));
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      this.send(JSON.stringify({
        kind: 'tool_result',
        tool_use_id: msg.tool_use_id,
        error: { content: [{ type: 'text', text }] },
      }));
    }
  }
}
