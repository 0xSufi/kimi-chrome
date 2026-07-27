#!/usr/bin/env node
// End-to-end shim smoke test, no Chrome or kimi-code needed:
//   1. starts the shim on an ephemeral port
//   2. connects a fake extension over the bridge WS and answers tool_call
//   3. drives the MCP endpoint like kimi-code would (initialize →
//      notifications/initialized → tools/list → tools/call)
// Exits 0 with "SMOKE OK" only if every step round-trips.

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

const PORT = 18765;
const BASE = `http://127.0.0.1:${PORT}`;

function fail(msg) {
  console.error(`SMOKE FAIL: ${msg}`);
  process.exit(1);
}

const shim = spawn(process.execPath, [new URL('../shim.mjs', import.meta.url).pathname], {
  env: { ...process.env, PORT: String(PORT), VERBOSE: '1' },
  stdio: ['ignore', 'inherit', 'inherit'],
});
process.on('exit', () => shim.kill());

// Wait for /health
let up = false;
for (let i = 0; i < 40; i++) {
  await sleep(150);
  try {
    const r = await fetch(`${BASE}/health`);
    if (r.ok) { up = true; break; }
  } catch {}
}
if (!up) fail('shim did not come up');

// ── Fake extension ───────────────────────────────────────────────────
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/chrome/local`);
let paired = false;
ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw));
  if (msg.type === 'paired') paired = true;
  if (msg.type === 'tool_call') {
    // Echo back a text + image result like the real registry would.
    ws.send(JSON.stringify({
      type: 'tool_result',
      tool_use_id: msg.tool_use_id,
      result: {
        content: [
          { type: 'text', text: `ran ${msg.tool} with ${JSON.stringify(msg.args)}` },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } },
        ],
      },
    }));
  }
});
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
ws.send(JSON.stringify({ type: 'connect', client_type: 'chrome-extension', device_id: 'smoke', os_platform: 'linux', extension_version: '0.1.0' }));
await sleep(300);
if (!paired) fail('extension never received paired');

const health = await (await fetch(`${BASE}/health`)).json();
if (!health.extension_connected) fail('health does not show extension connected');

// ── Fake kimi-code MCP client ────────────────────────────────────────
async function mcp(body) {
  const r = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });
  if (r.status === 202) return null;
  if (!r.ok) fail(`MCP POST ${body.method} → ${r.status}`);
  return r.json();
}

const init = await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } });
if (init?.result?.serverInfo?.name !== 'kimi-chrome') fail('bad initialize result');

const note = await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' });
if (note !== null) fail('notification should get 202');

const list = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
if (!Array.isArray(list?.result?.tools) || list.result.tools.length !== 13) fail(`expected 13 tools, got ${list?.result?.tools?.length}`);

const call = await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'navigate', arguments: { url: 'https://example.com' } } });
const content = call?.result?.content;
if (call?.result?.isError) fail(`tools/call errored: ${JSON.stringify(content)}`);
if (content?.[0]?.type !== 'text' || !content[0].text.includes('ran navigate')) fail('tool_call did not round-trip through the fake extension');
if (content?.[1]?.type !== 'image' || content[1].mimeType !== 'image/png' || content[1].data !== 'aGk=') fail('image block was not converted to MCP shape');

// Unknown method → JSON-RPC error
const unknown = await mcp({ jsonrpc: '2.0', id: 4, method: 'bogus/method' });
if (unknown?.error?.code !== -32601) fail('unknown method should yield -32601');

// Extension-less call → isError result (not a hang)
ws.close();
await sleep(300);
const orphan = await mcp({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'navigate', arguments: {} } });
if (!orphan?.result?.isError) fail('call without extension should return isError');

console.log('SMOKE OK');
process.exit(0);
