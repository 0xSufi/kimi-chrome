#!/usr/bin/env node
// Simulates src/ui/services/host-client.ts against a live kap-server,
// mirroring the extension's final logic frame-for-frame:
//   models auto-pick → create session (metadata.cwd) → WS handshake with
//   bearer subprotocol → client_hello subscribe → prompt (model on prompt)
//   → assistant deltas → turn.ended
// Phase 2: "run:<cmd>" prompt → shell tool approval → approve via REST →
// turn completes. Validates the approval path the sidepanel UI uses.

import fs from 'node:fs';

const HOME = process.env.KIMI_CODE_HOME;
const BASE = process.env.KAP_URL || 'http://127.0.0.1:58700';
const CWD = process.env.SIM_CWD;
const TOKEN = fs.readFileSync(`${HOME}/server.token`, 'utf8').trim();

const fail = (m) => { console.error('SIM FAIL:', m); process.exit(1); };

async function rest(method, path, body) {
  const resp = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body !== undefined ? { 'content-type': 'application/json; charset=utf-8' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const env = await resp.json().catch(() => undefined);
  if (!resp.ok || !env || env.code !== 0) {
    fail(`${method} ${path} → HTTP ${resp.status} envelope ${JSON.stringify(env)?.slice(0, 300)}`);
  }
  return env.data;
}

// MCP registration sanity
const mcpServers = await rest('GET', '/mcp/servers');
const chromeSrv = mcpServers.servers?.find((s) => s.id === 'chrome');
console.log('mcp chrome server:', JSON.stringify(chromeSrv));
if (chromeSrv?.status !== 'connected' || chromeSrv?.tool_count !== 13) fail('shim MCP not connected with 13 tools');

// Model auto-pick (extension logic: single model → use it)
const models = await rest('GET', '/models');
const modelId = models.items?.length === 1 ? models.items[0].model : undefined;
console.log('model:', modelId);

// Session
const session = await rest('POST', '/sessions', { metadata: { cwd: CWD } });
console.log('session created:', session.id);

// WS
const wsUrl = new URL(`${BASE}/api/v1/ws`);
wsUrl.protocol = 'ws:';
wsUrl.searchParams.set('client_id', 'ext_sim');
const ws = new WebSocket(wsUrl, [`kimi-code.bearer.${TOKEN}`]);

let assistantText = '';
let assistantLen = 0;
const approvals = [];
const events = [];
let turnResolve = null;
const nextTurn = () => new Promise((r) => { turnResolve = r; });

ws.addEventListener('message', (ev) => {
  const frame = JSON.parse(String(ev.data));
  const rawType = frame.type ?? '';
  if (rawType === 'server_hello') {
    ws.send(JSON.stringify({
      type: 'client_hello',
      id: 'hello_1',
      payload: { client_id: 'ext_sim', subscriptions: [session.id], cursors: { [session.id]: { seq: 0 } } },
    }));
    return;
  }
  if (rawType === 'ping') {
    ws.send(JSON.stringify({ type: 'pong', payload: { nonce: frame.payload?.nonce } }));
    return;
  }
  if (rawType === 'ack') return;
  const type = rawType.startsWith('event.') ? rawType.slice(6) : rawType;
  events.push(type + (frame.volatile ? '*' : ''));
  if (type === 'assistant.delta') {
    const delta = frame.payload?.delta ?? '';
    const offset = typeof frame.offset === 'number' ? frame.offset : undefined;
    if (offset !== undefined && offset < assistantLen) return;
    assistantLen = (offset ?? assistantLen) + delta.length;
    assistantText += delta;
  }
  if (type === 'approval.requested') {
    approvals.push(frame.payload);
    console.log('approval requested:', JSON.stringify(frame.payload).slice(0, 220));
  }
  if (type === 'turn.ended') turnResolve?.(frame.payload);
});

await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', () => rej(fail('ws connect failed')), { once: true });
});
await new Promise((r) => setTimeout(r, 400));

async function prompt(text) {
  assistantText = '';
  assistantLen = 0;
  const turnDone = nextTurn();
  await rest('POST', `/sessions/${session.id}/prompts`, {
    content: [{ type: 'text', text }],
    ...(modelId ? { model: modelId } : {}),
  });
  return Promise.race([
    turnDone,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout waiting for turn.ended (${text})`)), 30000)),
  ]).catch((e) => fail(e.message));
}

// ── Phase 1: plain text turn ────────────────────────────────────────
const t1 = await prompt('hello from the chrome extension port');
if (t1.reason !== 'completed') fail(`turn 1 reason ${t1.reason}: ${JSON.stringify(t1.error)}`);
if (!assistantText.trim()) fail('no assistant text streamed');
console.log('turn 1 completed, streamed text:', JSON.stringify(assistantText.slice(0, 80)));

// ── Phase 2: shell tool call → approval → approve → complete ────────
const approvalWatcher = (async () => {
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (approvals.length > 0) {
      const a = approvals.shift();
      const aid = a.approval_id ?? a.approvalId;
      console.log(`approving ${aid} (tool ${a.tool_name ?? a.toolName})`);
      await rest('POST', `/sessions/${session.id}/approvals/${aid}`, { decision: 'approved' });
      return true;
    }
  }
  return false;
})();

const t2 = await prompt('run:ls -la');
const approved = await approvalWatcher;
console.log('turn 2:', JSON.stringify(t2), '| approval exercised:', approved);
if (t2.reason !== 'completed') fail(`turn 2 reason ${t2.reason}: ${JSON.stringify(t2.error)}`);

console.log('event trace tail:', events.slice(-25).join(' '));
ws.close();
console.log('SIM OK');
process.exit(0);
