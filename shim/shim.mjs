#!/usr/bin/env node
/**
 * kimi-chrome-shim — local relay between kimi-code and the Kimi-in-Chrome
 * extension. One process, one port, two faces:
 *
 *   • Extension side: WebSocket server on ws://127.0.0.1:8765/chrome/…
 *     speaking the bridge wire protocol the extension's bridge-client
 *     already implements (connect/paired/ping/pong, tool_call/tool_result).
 *
 *   • kimi-code side: streamable-HTTP MCP endpoint at
 *     http://127.0.0.1:8765/mcp (sessionless, JSON responses). Register in
 *     ~/.kimi-code/mcp.json as:
 *
 *       { "mcpServers": { "chrome": { "url": "http://127.0.0.1:8765/mcp" } } }
 *
 *     kimi-code's config loader maps a bare `url` to the official SDK's
 *     StreamableHTTPClientTransport, which accepts application/json replies
 *     and tolerates 405 on its GET (server-push) probe.
 *
 * tools/call → { type: 'tool_call', tool, args, tool_use_id } over the WS →
 * the extension dispatches through its registry (CDP) and replies
 * { type: 'tool_result', tool_use_id, result | error } → MCP result.
 *
 * The extension's own per-domain permission gate still applies to every
 * call; keep the side panel open so permission prompts have a UI.
 *
 * Env:
 *   PORT=8765            listen port (extension default expects 8765)
 *   HOST=127.0.0.1       bind address (keep loopback)
 *   TOOL_TIMEOUT_MS=120000
 *   VERBOSE=1            log every relayed frame type
 */

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 8765;
const HOST = process.env.HOST || '127.0.0.1';
const TOOL_TIMEOUT_MS = Number(process.env.TOOL_TIMEOUT_MS) || 120_000;
const VERBOSE = process.env.VERBOSE === '1' || process.env.VERBOSE === 'true';

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a);
const vlog = (...a) => { if (VERBOSE) log(...a); };

// ── Tool surface ─────────────────────────────────────────────────────
// Mirrors the extension registry (src/tools/). Schemas are advisory —
// the extension validates args itself.
const TOOLS = [
  { name: 'tabs_context_mcp', description: 'List Chrome tabs in tab groups managed by the extension', inputSchema: { type: 'object', properties: { createIfEmpty: { type: 'boolean' } } } },
  { name: 'tabs_create_mcp', description: 'Open a new Chrome tab', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } },
  { name: 'navigate', description: 'Navigate the active Chrome tab to a URL', inputSchema: { type: 'object', properties: { url: { type: 'string' }, tabId: { type: 'number' } }, required: ['url'] } },
  { name: 'computer', description: 'Mouse/keyboard control of the active Chrome tab (screenshot, click, type, scroll…)', inputSchema: { type: 'object', properties: { action: { type: 'string' }, coordinate: { type: 'array', items: { type: 'number' } }, text: { type: 'string' }, tabId: { type: 'number' } }, required: ['action'] } },
  { name: 'javascript_tool', description: 'Execute JavaScript in the page context', inputSchema: { type: 'object', properties: { text: { type: 'string' }, tabId: { type: 'number' } }, required: ['text'] } },
  { name: 'read_page', description: 'Read the accessibility tree of the active Chrome page', inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, depth: { type: 'number' }, max_chars: { type: 'number' } } } },
  { name: 'find', description: 'Find an element on the page by natural-language query', inputSchema: { type: 'object', properties: { query: { type: 'string' }, tabId: { type: 'number' } }, required: ['query'] } },
  { name: 'form_input', description: 'Fill form fields by ref_id', inputSchema: { type: 'object', properties: { tabId: { type: 'number' } } } },
  { name: 'read_console_messages', description: 'Read Chrome DevTools console output for the active tab', inputSchema: { type: 'object', properties: { tabId: { type: 'number' } } } },
  { name: 'read_network_requests', description: 'Read Chrome DevTools network requests for the active tab', inputSchema: { type: 'object', properties: { tabId: { type: 'number' } } } },
  { name: 'resize_window', description: 'Resize the active Chrome window', inputSchema: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' } } } },
  { name: 'gif_creator', description: 'Record a sequence of browser frames as an animated GIF', inputSchema: { type: 'object' } },
  { name: 'update_plan', description: 'Update the task plan shown in the extension side panel', inputSchema: { type: 'object' } },
];

// ── Extension peer (bridge WS) ───────────────────────────────────────
let ext = null; // live extension socket, one at a time
const pending = new Map(); // tool_use_id → { resolve, timer }

function extSend(obj) {
  if (ext && ext.readyState === 1) ext.send(JSON.stringify(obj));
}

function failAllPending(reason) {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.resolve({ isError: true, content: [{ type: 'text', text: reason }] });
  }
  pending.clear();
}

function handleExtMessage(raw) {
  let msg;
  try { msg = JSON.parse(String(raw)); } catch { return; }
  vlog('ext →', msg.type);
  switch (msg.type) {
    case 'connect':
      // Bridge handshake — acknowledge as paired (single-user local relay,
      // no server-side pairing flow).
      extSend({ type: 'paired' });
      extSend({ type: 'peer_connected' });
      log(`extension connected (device ${msg.device_id ?? 'unknown'}, v${msg.extension_version ?? '?'})`);
      return;
    case 'ping':
      extSend({ type: 'pong' });
      return;
    case 'pong':
    case 'notification':
      return;
    case 'tool_result': {
      const p = pending.get(msg.tool_use_id);
      if (!p) return;
      pending.delete(msg.tool_use_id);
      clearTimeout(p.timer);
      if (msg.error) {
        p.resolve({ isError: true, content: toMcpContent(msg.error.content, 'tool error') });
      } else {
        p.resolve({ isError: false, content: toMcpContent(msg.result?.content ?? msg.content, '(empty result)') });
      }
      return;
    }
  }
}

/** Extension ToolContent (string | Anthropic-style blocks) → MCP content blocks. */
function toMcpContent(content, fallback) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [{ type: 'text', text: fallback }];
  const blocks = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') {
      blocks.push({ type: 'text', text: b.text });
    } else if (b.type === 'image' && b.source?.type === 'base64') {
      blocks.push({ type: 'image', data: b.source.data, mimeType: b.source.media_type });
    } else if (b.type === 'image' && typeof b.data === 'string') {
      blocks.push(b); // already MCP-shaped
    }
  }
  return blocks.length ? blocks : [{ type: 'text', text: fallback }];
}

function callExtensionTool(tool, args) {
  if (!ext || ext.readyState !== 1) {
    return Promise.resolve({
      isError: true,
      content: [{ type: 'text', text: 'Kimi-in-Chrome extension is not connected to the shim. Is Chrome running with the extension loaded?' }],
    });
  }
  return new Promise((resolve) => {
    const toolUseId = `tu_${Date.now()}_${randomBytes(4).toString('hex')}`;
    const timer = setTimeout(() => {
      pending.delete(toolUseId);
      resolve({ isError: true, content: [{ type: 'text', text: `tool call timed out after ${TOOL_TIMEOUT_MS}ms` }] });
    }, TOOL_TIMEOUT_MS);
    pending.set(toolUseId, { resolve, timer });
    extSend({ type: 'tool_call', tool, args: args ?? {}, tool_use_id: toolUseId, client_type: 'kimi-code' });
  });
}

// ── MCP endpoint (streamable HTTP, sessionless, JSON replies) ────────
async function handleMcpRequest(msg) {
  // Notifications / responses (no id) are accepted and dropped.
  if (msg.id === undefined || msg.id === null) return null;
  const id = msg.id;
  switch (msg.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: msg.params?.protocolVersion || '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'kimi-chrome', version: '0.1.0' },
        },
      };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    case 'tools/call': {
      const { name, arguments: args } = msg.params ?? {};
      vlog('mcp tools/call', name);
      const out = await callExtensionTool(name, args);
      return { jsonrpc: '2.0', id, result: out };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { buf += c; });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, extension_connected: !!ext && ext.readyState === 1, pending_calls: pending.size }));
    return;
  }

  if (url.pathname === '/mcp') {
    if (req.method === 'GET') {
      // No server-initiated stream; the SDK client treats 405 as "not supported".
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    if (req.method === 'DELETE') {
      res.writeHead(200).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      return;
    }
    const messages = Array.isArray(body) ? body : [body];
    const replies = (await Promise.all(messages.map(handleMcpRequest))).filter(Boolean);
    if (replies.length === 0) {
      res.writeHead(202).end(); // notification-only batch
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(Array.isArray(body) ? replies : replies[0]));
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

// ── WS upgrade (extension side) ──────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  if (!url.pathname.startsWith('/chrome')) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (ext && ext.readyState === 1) {
      log('new extension connection replaces the previous one');
      try { ext.close(1000, 'replaced'); } catch {}
    }
    ext = ws;
    ws.on('message', handleExtMessage);
    ws.on('close', () => {
      if (ext === ws) {
        ext = null;
        failAllPending('extension disconnected mid-call');
        log('extension disconnected');
      }
    });
    ws.on('error', (err) => log('extension socket error:', err.message));
    // The extension marks the bridge "paired" on this frame even before
    // its connect message arrives; sending it eagerly keeps the status
    // pill green from the first tick.
    extSend({ type: 'paired' });
  });
});

httpServer.listen(PORT, HOST, () => {
  log(`kimi-chrome-shim listening on ${HOST}:${PORT}`);
  log(`  extension bridge : ws://${HOST}:${PORT}/chrome/local`);
  log(`  kimi-code MCP    : http://${HOST}:${PORT}/mcp`);
  log(`  health           : http://${HOST}:${PORT}/health`);
});
