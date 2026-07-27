# Kimi in Chrome

A Manifest V3 Chrome extension that exposes the browser as a tool surface to
**kimi-code** (Moonshot's Kimi Code CLI) and embeds a sidepanel chat backed by
kimi-code's local daemon (`kap-server`). Ported from
[`dyspel-chrome-plugin`](../dyspel-chrome-plugin) — the Claude-flavored
original — per [`FEASIBILITY.md`](FEASIBILITY.md).

```
                 ┌────────────────────────── Chrome ──────────────────────────┐
                 │  Kimi-in-Chrome extension                                  │
   kimi web      │   sidepanel chat ◄──REST /sessions /prompts /approvals──┐  │
  (kap-server) ◄─┼──────────────────────────────────────────────────────── │  │
  127.0.0.1:58627│   ◄──WS /api/v1/ws  assistant.delta / approval events──┘  │
       ▲         │                                                            │
       │ MCP     │   tool registry (13 CDP tools) ◄──ws bridge protocol──┐    │
       ▼         │                                                        │   │
  shim/shim.mjs ─┴────────────────────────────────────────────────────────┘   │
  127.0.0.1:8765  /mcp (streamable HTTP) ↔ /chrome/* (extension WebSocket)    │
                 └────────────────────────────────────────────────────────────┘
```

## Components

- **`src/`** — the extension. CDP-backed tools (navigate, computer, read_page,
  find, form_input, javascript_tool, tabs, console/network readers,
  resize_window, gif_creator, update_plan), per-domain permission gate,
  scheduled prompts, sidepanel chat, options page.
- **`shim/`** — one small local process bridging both worlds: serves the 13
  browser tools to kimi-code as a streamable-HTTP MCP server (`/mcp`) and
  relays each `tools/call` to the extension over the bridge WebSocket
  (`/chrome/*`), which the extension dials out to.

## Setup

1. **Build + load the extension**

   ```bash
   npm install
   npm run build        # tsc --noEmit && vite build → dist/
   ```

   Load `dist/` as an unpacked extension at `chrome://extensions`.

2. **Start the daemon** (kimi-code ≥ the pinned commit, Node ≥ 24.15)

   ```bash
   kimi web --no-open   # kap-server on 127.0.0.1:58627, prints #token=…
   ```

3. **Configure the extension** (options page → Connection)

   - Kimi server URL: `http://127.0.0.1:58627`
   - Auth token: from `~/.kimi-code/server.token` or the printed `#token=` fragment
   - Working directory: an existing absolute path on this machine (the daemon
     requires `metadata.cwd` and does not expand `~`)
   - Model id: leave empty — auto-picked when the daemon has exactly one model
     (e.g. env-injected or managed login)

4. **CORS**: allow the extension origin on the daemon:

   ```bash
   KIMI_CODE_CORS_ORIGINS=chrome-extension://<your-extension-id> kimi web --no-open
   ```

   (Loopback pages are auto-allowed; a `chrome-extension://` origin is not.)

5. **Browser tools for the agent** — start the shim and register it:

   ```bash
   cd shim && npm install && npm start        # 127.0.0.1:8765
   ```

   `~/.kimi-code/mcp.json`:

   ```json
   { "mcpServers": { "chrome": { "url": "http://127.0.0.1:8765/mcp" } } }
   ```

   The extension's bridge transport dials `ws://127.0.0.1:8765/chrome/local`
   automatically (override via `chrome.storage.local.LOCAL_BRIDGE_URL`). Tools
   appear to the agent as `mcp__chrome__navigate` etc. The extension's own
   per-domain permission prompts still gate every call — keep the side panel
   open so they have a UI.

## Verified

See `IMPLEMENTATION.md` for the integration test transcript: real kap-server
(kimi-code `66f611aae`) + shim + simulated extension client — session create,
WS handshake, streamed `assistant.delta`, MCP `chrome` server connected with
13 tools, and the full approval round-trip (`approval.requested` → REST
approve → tool runs → turn completes).

## What changed vs. the Dyspel original

- claude.ai OAuth deleted — auth is one pasted bearer token; Kimi login
  (device-code OAuth) lives entirely in the daemon.
- Sidepanel speaks kap-server REST + WS protocol v2 instead of the cc-wasm
  stream-json host protocol; real char-offset streaming deltas.
- Tool approvals render inline in chat (kap approvals replace `can_use_tool`).
- Bridge transport defaults to the local shim; Anthropic's hosted bridge and
  the claude.ai domain-category service are gone (managed blocklist remains).
- Native-messaging transport is dormant (no Kimi native host exists yet);
  host name reserved: `com.moonshot.kimi_code_browser_extension`.
