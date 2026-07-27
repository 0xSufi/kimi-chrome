# Implementation status — Kimi-in-Chrome port

**Date:** 2026-07-27. Port executed per `FEASIBILITY.md` Option A
(extension → kap-server; browser tools via MCP shim).

## Done & verified

| Piece | Status | Evidence |
|---|---|---|
| Baseline scaffold from dyspel-chrome-plugin | ✅ | `git log` — baseline commit builds clean |
| Claude coupling stripped (OAuth, domain API, Anthropic bridge, SDK dep) | ✅ | `npm run build` green; no `claude.ai`/`anthropic` references outside comments |
| Sidepanel kap-server client (`src/ui/services/host-client.ts`) | ✅ | protocol-equivalent sim passed against real daemon (below) |
| Approval UI in chat (store + ChatView + MessageBubble) | ✅ | approval event → REST resolve round-trip verified via sim |
| MCP tool shim (`shim/shim.mjs`) | ✅ | `shim/test/smoke.mjs` (fake ext + MCP client) AND real kimi-code connected it |
| Extension build | ✅ | `tsc --noEmit && vite build` → `dist/` |

## Integration test (all real components except Chrome itself)

Stack: kimi-code monorepo bundle `apps/kimi-code/dist/main.mjs` (commit
`66f611aae`, Node v24.15.0) running `kimi web --port 58700`; mock
OpenAI-compatible LLM (from `kimi-wasm/src/mockLlmSource.js`) injected via
`KIMI_MODEL_*` env; shim on :8765; `ext-client-sim.mjs` replicating
`host-client.ts` frame-for-frame.

Results:

- `GET /api/v1/mcp/servers` → `{"id":"chrome","transport":"http","status":"connected","tool_count":13}` —
  the daemon loaded `mcp.json`, spoke streamable-HTTP MCP to the shim, and
  listed all 13 browser tools.
- Session create → WS `server_hello`/`client_hello` (bearer subprotocol) →
  subscribe ack → prompt → volatile `assistant.delta` frames streamed
  (`"Hello from the in-container mock endpoint! KIMI-WASM-E2E-OK"`) →
  `turn.ended reason=completed`.
- `run:ls -la` prompt → `event.approval.requested` (snake_case payload,
  `approval_id`/`tool_name` — parsed by the client) → `POST
  /approvals/{id} {"decision":"approved"}` → `approval.resolved` →
  `tool.call.started`/`tool.result` → `turn.ended reason=completed`.
- Shim smoke test additionally covers: image block conversion
  (Anthropic-style `source.base64` → MCP `{data, mimeType}`), 202 for
  notifications, −32601 for unknown methods, and isError result when the
  extension is disconnected.

## Findings baked into the client (differ from kimi-web's assumptions)

1. `POST /sessions` requires `metadata.cwd` as an **existing absolute path**
   (40001/40409 otherwise; `~` is not expanded). Surfaced as a settings field
   with a targeted error message.
2. Session-level `agent_config.model` is **not** honored by this daemon build;
   the **prompt-level `model` field is**. The client resolves a model at
   connect time (config override → sole entry of `GET /models`) and sends it
   on every prompt.
3. `GET /api/v1/fs::home` is not mounted in this build — don't rely on it for
   a cwd default.
4. Event frames arrive with mixed casing: projected `event.*` payloads are
   snake_case, raw agent-core payloads camelCase. The client accepts both.
5. `turn.ended reason=failed` carries `payload.error.{code,message}` — shown
   as a chat error.

## Not done / next

- **Load into real Chrome** and drive a page end-to-end (this environment has
  no display into the target Chrome profile; everything up to the
  `chrome.debugger` boundary is verified).
- **CORS**: `kimi web` must run with
  `KIMI_CODE_CORS_ORIGINS=chrome-extension://<id>`; consider pinning the
  extension id with a manifest `key` so the value is stable.
- Native-messaging host for Kimi (optional — bridge/WS covers all flows).
- Thinking deltas are received but not yet rendered in the sidepanel.
- kap-server is v0.1.0/private — re-run `shim/test/ext-client-sim.mjs`
  (needs `KIMI_CODE_HOME` + `SIM_CWD` env, see header) when bumping kimi-code.

## Test commands

```bash
npm run build                       # extension
cd shim && node test/smoke.mjs      # shim protocol round-trip, no Chrome/kimi needed
```
