# Feasibility: porting the Dyspel Chrome plugin to Kimi

**Date:** 2026-07-27
**Question:** Can `dyspel-chrome-plugin` (the from-scratch rewrite of Claude-in-Chrome that pairs with cc-wasm / Claude Code) be ported to use Kimi (Moonshot's Kimi Code) as the backing agent?

## Verdict

**Yes — highly feasible, and less work than the original rewrite was.** Roughly 80% of the
extension (all CDP tool machinery, permissions, scheduling, UI shell) is model-agnostic and
carries over unchanged. The Claude-specific 20% has a direct, in many cases *better*,
counterpart on the Kimi side: kimi-code ships a first-party local daemon (`kap-server`) that
already plays the role of the cc-wasm host server, already proxies Kimi OAuth so the
extension never touches auth, and already has a framework-free browser WS client to crib
from. Estimated effort: **1–2 weeks** for a working port (Option A below).

---

## 1. What the extension is today

`/data4/ex-cc/dyspel-chrome-plugin` — MV3 extension, ~6.5k LOC TypeScript, mature
(~50 commits, all phases landed). Three ways an agent reaches it:

1. **Native messaging** — host `com.anthropic.claude_code_browser_extension`
   (`src/core/native-messaging.ts`).
2. **WebSocket bridge** — `wss://bridge.claudeusercontent.com/chrome/{oauth-token}` in prod;
   `LOCAL_BRIDGE_URL` override already supported, and `/data4/ex-cc/cc-wasm-bridge/bridge.js`
   (226 LOC) is a working auth-free localhost replacement (`src/core/bridge-client.ts`).
3. **Sidepanel chat** — `src/ui/services/host-client.ts` (252 LOC) speaks the Claude Code
   stream-json envelope + a `kind`-tagged tool-relay channel to the cc-wasm host server
   (`/data4/ex-cc/cc-wasm/server/hostServer.ts`, spec in `server/HOST.md`).

All three transports funnel into one model-agnostic tool registry
(`src/tools/registry.ts`) driving 13 CDP-backed tools (navigate, computer, read_page, find,
form_input, javascript_tool, tabs_*, read_console/network, resize_window, gif_creator,
update_plan).

### Complete inventory of Claude coupling

| File | Coupling | Port action |
|---|---|---|
| `src/ui/services/host-client.ts` | cc-wasm host-server protocol (pure JSON frames, no SDK) | **Replace** with kap-server client (~300–500 LOC) |
| `src/core/oauth.ts` (240 LOC) | claude.ai PKCE; only feeds the hosted bridge + domain checker | **Delete** — kap-server proxies Kimi OAuth |
| `src/core/bridge-client.ts` | Prod URL is Anthropic infra | Keep transport, repoint at local relay/shim, or drop |
| `src/core/native-messaging.ts`, `protocol.ts:50-53` | `com.anthropic.*` host names | Rename constants; write a Kimi native host *if* that transport is kept |
| `src/core/domain-checker.ts` | claude.ai `domain_info` category API; **fails open** without a token | Stub out (managed blocklist keeps working) or point at own service |
| `src/manifest.json` CSP `connect-src` | Anthropic/claude.ai origins | Swap for `http(s)/ws(s)://127.0.0.1:*` + Kimi origins |
| `package.json` `@anthropic-ai/sdk` devDep | **Unused** — nothing imports it | Delete |

Nothing else in the extension knows what model is on the other end.

---

## 2. What exists on the Kimi side

### `/data4/ex-cc/kimi-code` — official Moonshot monorepo (clone of `MoonshotAI/kimi-code`, HEAD `66f611aae`)

The decisive asset. Relevant pieces:

- **`packages/kap-server`** — Fastify + `ws` local daemon ("Kimi Agent Protocol"), default
  `127.0.0.1:58627`, launched by `kimi web`. This **is** the host server the extension needs:
  - WS `/api/v1/ws`, protocol v2 (`src/protocol/ws-control.ts`): `server_hello`/`client_hello`
    handshake, per-session subscribe with `{seq, epoch}` cursors, durable journal replay, and
    real char-offset `assistant.delta` / `thinking.delta` frames — *better* streaming than the
    current cc-wasm path, which only delivers whole content blocks.
  - **Browser-friendly WS auth**: bearer rides in `Sec-WebSocket-Protocol` as
    `kimi-code.bearer.<token>` (`src/transport/ws/bearerProtocol.ts`) — solves the
    no-headers-on-`new WebSocket()` problem the current code works around with `?token=`.
  - REST `/api/v1/*`: sessions (create/fork/compact/abort/undo), `POST /sessions/{id}/prompts`
    (text + image parts), **approvals** (`/sessions/{id}/approvals`) — a ready-made replacement
    for the `can_use_tool` permission round-trip — plus models, providers, mcp servers, fs.
  - **OAuth proxied by the daemon**: `POST/GET/DELETE /api/v1/oauth/login` drives Kimi's
    device-code flow (`packages/oauth`, `auth.kimi.com`). The extension needs **zero** OAuth
    code — the 240-LOC PKCE module is simply deleted, not ported.
  - Instance discovery for free: `<KIMI_CODE_HOME>/server/instances/*.json`.
- **`apps/kimi-web`** — Vue SPA client of that daemon. `src/api/daemon/ws.ts`
  (`DaemonEventSocket`) is framework-free (handshake, subscribe, reconnect/backoff, resync)
  and can be ported into the sidepanel nearly verbatim; `serverAuth.ts` shows the token
  handoff pattern.
- **MCP support** (stdio/SSE/streamable-HTTP, `packages/agent-core-v2/src/agent/mcp/`),
  config at `~/.kimi-code/mcp.json` / `<cwd>/.kimi-code/mcp.json`. This is the **only**
  dynamic way to add tools — there is no wire-level tool registration.
- **CLI print mode**: `kimi -p --output-format stream-json` exists but is one-shot and uses
  Kimi's own event vocabulary, not Claude's `{type:'assistant'}` envelope.
- **No native-messaging host, no Chrome-extension code anywhere.** Moonshot's own
  "Kimi WebBridge" (browser extension + daemon) is a closed, hosted product — prior art to
  check for collisions, nothing to reuse.

### `/data4/ex-cc/kimi-wasm` — kimi-code inside a StackBlitz WebContainer

Proof (verified 2026-07-24, headless Chrome) that the stock `dist/main.mjs` runs fully
in-browser: TUI in xterm, streamed SSE, tool call → permission → in-container execution.
Credential pattern via `KIMI_MODEL_BASE_URL` → server-side key-swapping proxy. Only relevant
if the "Dyspel-in-browser" architecture (agent in a WebContainer tab, direct
`externally_connectable` messaging to the extension — see `cc-wasm-bridge/README.md`) is
wanted; the desktop port does not need it.

### `/data4/ex-cc/kimi-v` — not relevant (Python distillation pipeline; no agent loop, no server).

---

## 3. Port architectures

### Option A (recommended): extension → kap-server

```
sidepanel chat ──REST /sessions, /prompts, /approvals──►  kap-server (kimi web)
              ◄──WS /api/v1/ws  assistant.delta ──────    127.0.0.1:58627
                                                              │ spawns agent-core
browser tools ◄──ws── local MCP shim (~200–400 LOC) ◄──MCP(streamable-HTTP/stdio)──┘
  (existing bridge transport + registry, unchanged)
```

Work items:
1. **New `host-client`**: port `DaemonEventSocket` + a thin REST wrapper; map
   `assistant.delta`/`thinking.delta` → chat UI, approvals endpoint → the existing permission
   prompt UI. Replaces 252 LOC with ~400–500.
2. **Tool shim**: a small local process exposing the 13 browser tools as an MCP server
   (streamable-HTTP or stdio), registered in `~/.kimi-code/mcp.json`; it relays `tools/call`
   to the extension over the **existing bridge wire protocol** (`tool_call`/`tool_result`
   frames), so `core/bridge-client.ts` and the registry work unchanged. The relay half
   already exists (`cc-wasm-bridge/bridge.js`); the MCP half can crib tool schemas from
   `cc-wasm/server/relayStub.cjs`.
3. **Config/manifest**: CSP `connect-src` → loopback origins; options page gets
   host-URL/token fields (already exist for the host server) — token can be pasted or read
   from the `kimi web` URL fragment flow.
4. **Server-side one-liner**: add `chrome-extension://<id>` to `KIMI_CODE_CORS_ORIGINS`
   (same `isOriginAllowed` predicate gates REST *and* the WS upgrade —
   `kap-server/src/middleware/origin.ts`). No fork needed if the extension ID is stable.
5. **Deletions**: `oauth.ts`, claude.ai bits of `domain-checker.ts`, Anthropic bridge prod
   URL, `@anthropic-ai/sdk` devDep, `com.anthropic.*` host names.

### Option B: keep the extension untouched, adapt the server side

Reuse `cc-wasm/server/hostServer.ts` (559 LOC, zero Anthropic imports — the spawned command
is configurable via `CC_WASM_COMMAND`) and write an adapter process that wraps Kimi via
`@moonshot-ai/kimi-code-sdk` (`KimiHarness`) or `kimi acp` (stdio ACP), translating to/from
the Claude stream-json envelope the sidepanel already speaks (only 4 frame types consumed:
`assistant`, `result`, `control_request:can_use_tool`, plus `user`/`control_response`/
`interrupt` upstream). ~500–1000 LOC adapter, extension diff ≈ 0. Viable, but you own a
translation layer forever and forgo kap-server's superior streaming/resume; `kimi -p` alone
is not enough (one-shot, different vocabulary), so the SDK/ACP wrapper is mandatory.

### Option C: in-browser (WebContainer) variant

kimi-wasm + the direct `externally_connectable` path (extension already allowlists
`localhost` and `*.dyspel.{io,ai,xyz}`; `onMessageExternal` routing already exists in
`service-worker.ts`). Feasible per the kimi-wasm verification, but OAuth/managed login is
untested in-container (env-injected API key / proxy is the supported path). Treat as a
follow-on, not the first port.

---

## 4. Risks & open questions

- **kap-server API stability**: `"private": true`, v0.1.0, routes described as "the subset v2
  can serve today". Pin the kimi-code commit; expect churn.
- **Kimi WebBridge overlap**: Moonshot ships its own extension+daemon product. Check for
  protocol/port/name collisions and whether it obviates parts of this port (closed source,
  couldn't inspect).
- **Native-messaging transport has no Kimi counterpart** — would need a bespoke host
  (cc-wasm's `utils/claudeInChrome/setup.ts` + `chromeNativeHost.ts` are a complete
  reference). Recommend dropping it initially; the WS paths cover all use cases.
- **CORS/origin gating** is strict (no wildcards) — unpacked-extension IDs change per
  machine unless the manifest pins a `key`; pin one.
- **Domain-safety regression**: the claude.ai category service disappears; only the managed
  blocklist remains. Acceptable for personal use; note it.
- **Feature deltas**: scheduled prompts, GIF recording, permissions UI all keep working
  (they sit above the registry); `update_plan` tool semantics should be checked against
  Kimi's TodoList/plan events.

## 5. What carries over unchanged

`core/cdp*.ts`, all 13 `tools/*`, `tools/registry.ts`, `core/permissions.ts` +
`permission-bridge.ts`, `core/tab-groups.ts`, `core/scheduled-*.ts`, both content scripts,
offscreen/GIF machinery, options/sidepanel UI shells, `core/storage.ts`, `core/router.ts`,
and (frame-for-frame) the bridge wire protocol used by the tool shim. That is the bulk of
the codebase — the port is a transport/auth swap, not a rewrite.
