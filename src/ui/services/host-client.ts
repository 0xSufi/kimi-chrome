// Sidepanel chat ↔ kimi-code kap-server (the daemon behind `kimi web`).
//
// REST (all under {hostUrl}/api/v1, bearer-authenticated, enveloped
// {code, msg, data} with code 0 = ok):
//   POST /sessions                          create the chat session
//   POST /sessions/{id}/prompts             submit a user prompt
//   POST /sessions/{id}:abort               interrupt the running turn
//   POST /sessions/{id}/approvals/{aid}     resolve a tool approval
//
// WS {hostUrl ws}/api/v1/ws?client_id=…  (protocol v2):
//   auth rides in the Sec-WebSocket-Protocol subprotocol as
//   "kimi-code.bearer.<token>" because browsers can't set headers on
//   new WebSocket().
//   server_hello → client_hello{client_id, subscriptions, cursors} → events.
//   Event frames: { type, seq, session_id, timestamp, volatile?, offset?,
//   payload } where type may arrive raw ("assistant.delta") or projected
//   ("event.approval.requested") — we normalize by stripping "event.".

const STORAGE_KEY_HOST_URL = 'KIMI_HOST_URL';
const STORAGE_KEY_HOST_TOKEN = 'KIMI_HOST_TOKEN';

const WS_BEARER_PROTOCOL_PREFIX = 'kimi-code.bearer.';
const REQUEST_TIMEOUT_MS = 30_000;

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
// Wire shapes (subset the sidepanel consumes)
// ============================================================

interface Envelope<T> {
  code: number;
  msg: string;
  data: T | null;
  request_id?: string;
}

export interface ApprovalRequest {
  approvalId: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  action: string;
  display?: unknown;
}

export type ApprovalDecision = 'approved' | 'rejected';

export interface HostClientCallbacks {
  onTextDelta?: (text: string) => void;
  onThinkingDelta?: (text: string) => void;
  onToolUse?: (block: { id: string; name: string; input: unknown }) => void;
  onResult?: (msg: { result?: string; reason?: string }) => void;
  onApprovalRequest?: (req: ApprovalRequest) => void;
  onApprovalResolved?: (approvalId: string) => void;
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
  private closed = false;
  private readonly clientId = `ext_${crypto.randomUUID()}`;
  private msgSeq = 0;
  /** Cumulative assistant/thinking text lengths for volatile-delta dedup. */
  private assistantLen = 0;
  private thinkingLen = 0;
  private helloWaiter: (() => void) | null = null;

  constructor(private cfg: HostClientConfig, private cb: HostClientCallbacks = {}) {}

  async sendUserMessage(text: string): Promise<void> {
    await this.ensureConnected();
    this.assistantLen = 0;
    this.thinkingLen = 0;
    await this.rest('POST', `/sessions/${encodeURIComponent(this.sessionId!)}/prompts`, {
      content: [{ type: 'text', text }],
    });
  }

  sendInterrupt(): void {
    if (!this.sessionId) return;
    void this.rest('POST', `/sessions/${encodeURIComponent(this.sessionId)}:abort`, {}).catch(() => {});
  }

  async resolveApproval(approvalId: string, decision: ApprovalDecision): Promise<void> {
    if (!this.sessionId) throw new Error('no session');
    await this.rest(
      'POST',
      `/sessions/${encodeURIComponent(this.sessionId)}/approvals/${encodeURIComponent(approvalId)}`,
      { decision },
    );
  }

  close(): void {
    this.closed = true;
    if (this.ws) {
      try { this.ws.close(1000, 'client closing'); } catch {}
      this.ws = null;
    }
    this.sessionId = null;
  }

  // ------------------------------------------------------------
  // REST
  // ------------------------------------------------------------

  private restUrl(path: string): string {
    const base = this.cfg.hostUrl.replace(/\/$/, '');
    return `${base}/api/v1${path.startsWith('/') ? path : `/${path}`}`;
  }

  private async rest<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const resp = await fetch(this.restUrl(path), {
      method,
      headers: {
        authorization: `Bearer ${this.cfg.authToken}`,
        ...(body !== undefined ? { 'content-type': 'application/json; charset=utf-8' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    let envelope: Envelope<T> | undefined;
    try { envelope = (await resp.json()) as Envelope<T>; } catch {}
    if (!resp.ok || !envelope || envelope.code !== 0) {
      const msg = envelope?.msg ?? `${resp.status} ${resp.statusText}`;
      throw new Error(`${method} ${path} failed: ${msg}`);
    }
    return envelope.data as T;
  }

  // ------------------------------------------------------------
  // Session + WS lifecycle
  // ------------------------------------------------------------

  private async ensureConnected(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN && this.sessionId) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.doConnect().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async doConnect(): Promise<void> {
    this.closed = false;

    // The daemon rejects a missing metadata object with 40001.
    const session = await this.rest<{ id: string }>('POST', '/sessions', { metadata: {} });
    this.sessionId = session.id;

    const wsUrl = new URL(this.restUrl('/ws'));
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl.searchParams.set('client_id', this.clientId);

    const ws = new WebSocket(wsUrl.toString(), [`${WS_BEARER_PROTOCOL_PREFIX}${this.cfg.authToken}`]);
    this.ws = ws;

    ws.addEventListener('message', (ev) => this.handleFrame(ev));
    ws.addEventListener('close', (ev) => {
      if (this.ws === ws) {
        this.ws = null;
        this.sessionId = null;
      }
      if (!this.closed) this.cb.onClose?.(ev.reason || undefined);
    });
    ws.addEventListener('error', () => this.cb.onError?.(new Error('websocket error')));

    // Connected = server_hello received and client_hello sent (see
    // handleFrame); surface open/fail to the caller here.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws handshake timeout')), 10_000);
      const onHello = () => { clearTimeout(timer); resolve(); };
      const onErr = () => { clearTimeout(timer); reject(new Error('ws connect failed')); };
      this.helloWaiter = onHello;
      ws.addEventListener('error', onErr, { once: true });
      ws.addEventListener('close', onErr, { once: true });
    });
    this.cb.onOpen?.();
  }

  private send(frame: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  private nextId(): string {
    this.msgSeq += 1;
    return `${this.clientId}_${this.msgSeq}`;
  }

  // ------------------------------------------------------------
  // Frame handling
  // ------------------------------------------------------------

  private handleFrame(event: MessageEvent): void {
    const data = typeof event.data === 'string' ? event.data : '';
    if (!data) return;
    let frame: Record<string, unknown>;
    try { frame = JSON.parse(data) as Record<string, unknown>; }
    catch { return; }

    const rawType = typeof frame.type === 'string' ? frame.type : '';
    const payload = (frame.payload ?? {}) as Record<string, unknown>;

    switch (rawType) {
      case 'server_hello': {
        if (this.sessionId) {
          this.send({
            type: 'client_hello',
            id: this.nextId(),
            payload: {
              client_id: this.clientId,
              subscriptions: [this.sessionId],
              cursors: { [this.sessionId]: { seq: 0 } },
            },
          });
        }
        this.helloWaiter?.();
        this.helloWaiter = null;
        return;
      }
      case 'ping':
        this.send({ type: 'pong', payload: { nonce: payload.nonce } });
        return;
      case 'ack':
      case 'resync_required':
        // Chat renders append-only from live deltas; a resync gap only
        // matters for clients that rebuild transcript state via REST.
        return;
    }

    // Event frames — type may be raw agent-core ("assistant.delta") or
    // projected protocol ("event.approval.requested").
    const type = rawType.startsWith('event.') ? rawType.slice('event.'.length) : rawType;

    switch (type) {
      case 'assistant.delta': {
        const delta = typeof payload.delta === 'string' ? payload.delta : '';
        if (!delta) return;
        const offset = typeof frame.offset === 'number' ? frame.offset : undefined;
        if (offset !== undefined && offset < this.assistantLen) return; // duplicate
        this.assistantLen = (offset ?? this.assistantLen) + delta.length;
        this.cb.onTextDelta?.(delta);
        return;
      }
      case 'thinking.delta': {
        const delta = typeof payload.delta === 'string' ? payload.delta : '';
        if (!delta) return;
        const offset = typeof frame.offset === 'number' ? frame.offset : undefined;
        if (offset !== undefined && offset < this.thinkingLen) return;
        this.thinkingLen = (offset ?? this.thinkingLen) + delta.length;
        this.cb.onThinkingDelta?.(delta);
        return;
      }
      case 'tool.call.started': {
        const id = String(payload.toolCallId ?? payload.tool_call_id ?? '');
        const name = String(payload.name ?? payload.tool_name ?? '');
        this.cb.onToolUse?.({ id, name, input: payload.args ?? payload.input ?? {} });
        return;
      }
      case 'turn.ended': {
        const reason = typeof payload.reason === 'string' ? payload.reason : undefined;
        this.cb.onResult?.({ reason });
        return;
      }
      case 'approval.requested': {
        // Projected payloads are snake_case; be lenient about both.
        const req: ApprovalRequest = {
          approvalId: String(payload.approval_id ?? payload.approvalId ?? ''),
          sessionId: String(payload.session_id ?? frame.session_id ?? ''),
          toolCallId: String(payload.tool_call_id ?? payload.toolCallId ?? ''),
          toolName: String(payload.tool_name ?? payload.toolName ?? ''),
          action: String(payload.action ?? ''),
          display: payload.tool_input_display ?? payload.display,
        };
        if (req.approvalId) this.cb.onApprovalRequest?.(req);
        return;
      }
      case 'approval.resolved':
      case 'approval.expired': {
        const id = String(payload.approval_id ?? payload.approvalId ?? '');
        if (id) this.cb.onApprovalResolved?.(id);
        return;
      }
      case 'error': {
        const msg = typeof payload.msg === 'string' ? payload.msg
          : typeof payload.message === 'string' ? payload.message
          : 'agent error';
        this.cb.onError?.(new Error(msg));
        return;
      }
    }
  }
}
