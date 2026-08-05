# Changelog

## 2.0.0 (2026-08-05)

Migration to the MCP 2026-07-28 protocol revision and the v2 SDK packages (closes #1). BREAKING at the protocol and deployment level; the 77-tool surface is unchanged (0 tools removed, 0 required inputs removed).

- MCP SDK v2: `@modelcontextprotocol/sdk` 1.x replaced by `@modelcontextprotocol/server` + `@modelcontextprotocol/node` (runtime) and `@modelcontextprotocol/client` (tests and smoke scripts only).
- Stateless HTTP transport: `/mcp` is now served by `createMcpHandler` with one fresh server instance per request (the v2 per-request-factory model, adapted to Express via `toNodeHandler`). No sessions, no `Mcp-Session-Id` header; replicas scale horizontally with no shared state. 2025-era clients (`initialize` handshake) are answered by the SDK's built-in stateless legacy fallback, verified over both stdio and HTTP.
- BREAKING (config): `HYPEDEXER_MCP_HTTP_SESSION_TTL_MS` and `HYPEDEXER_MCP_HTTP_MAX_SESSIONS` are removed along with the session map, idle reaper and 503 cap; `startHttp`'s handle drops `sessionCount()`. Bearer auth and Host/Origin allowlisting are unchanged.
- zod bumped from 3.x to 4.x (the v2 SDK floor is `zod >= 4.2.0`): tool input shapes are now wrapped with `z.object()` at registration and the two open `z.record(...)` params take the v4 two-argument form.
- `serverInfo.version` and the outbound `User-Agent` now read the real package version at build time (they were hardcoded to `0.1.0` and `1.0.0`).
- `scripts/smoke-keyed.mjs` reads the API key from this repo's `.env` instead of an unrelated project's env file.

## 1.1.0 (2026-07-13)

First npm publish of the package. Contract-preserving MINOR: the full 77-tool surface is unchanged (0 tools removed, 0 required inputs removed), the new work is HTTP-transport hardening and upstream fixes.

- HTTP transport hardening (AUDIT.md H1, H2, H3):
  - Bearer authentication on `/mcp` via `HYPEDEXER_MCP_HTTP_TOKEN` (constant-time comparison, 401 + `WWW-Authenticate` otherwise). Binding to a non-loopback host without a token now refuses to start; loopback without a token logs a warning.
  - Host and Origin allowlisting on `/mcp` (DNS-rebinding defense): loopback hosts allowed by default, extendable with `HYPEDEXER_MCP_HTTP_ALLOWED_HOSTS` and `HYPEDEXER_MCP_HTTP_ALLOWED_ORIGINS`; mismatches get 403.
  - Session lifecycle: idle sessions reaped after `HYPEDEXER_MCP_HTTP_SESSION_TTL_MS` (default 10 min), concurrent sessions capped at `HYPEDEXER_MCP_HTTP_MAX_SESSIONS` (default 100, 503 past it), SIGTERM/SIGINT drain all sessions and close the listener.
  - `startHttp` now returns a handle (`server`, `port`, `sessionCount()`, `close()`); 8 new tests cover the auth, rebinding and lifecycle paths.
- Upstream fixed the REST `/fills/spot/*` endpoints on 2026-07-06 (they returned 500 since design time). `hd_fills_search` with `scope=spot` already wired them and now returns real data, live-verified. Updated `hd_stream_fills_spot`'s description and the docs, which claimed the WebSocket channel was the only working spot-fill source.
- Added `AGENTS.md` (contribution guide for AI coding agents) and raised the README to the hypedexer-sdk documentation standard.

## 1.0.0 (2026-07-02)

First stable release. Packaging and robustness hardening on top of the 0.1.0 base, with every surface (REST, both WebSocket hubs, RPC) live-validated against the real API.

- Response budget now enforced on raw passthrough tools (`hl_public_*`, `hd_info_raw`, `hd_rpc_*`): oversized arrays are tail-truncated with a steering note and oversized objects are clipped with an explicit marker, so a single large upstream body can no longer blow the agent's context.
- `engines.node` raised to `>=22.0.0` to match the real requirement of the WebSocket and rpc-subscribe tools (native `WebSocket` with custom upgrade headers).
- `prepublishOnly` gate (lint, typecheck, test, build) so a publish can never ship without a freshly built `dist`.
- GitHub Actions CI (lint, typecheck, test, build on Node 22).
- Live validation against the real API surfaced two issues, both fixed:
  - `rpc` group is now opt-in only (excluded from the `all` preset) because `rpc.hypedexer.com` is not deployed yet (DNS NXDOMAIN); enable with `HYPEDEXER_MCP_TOOLS=all,rpc` once the endpoint is live. The default surface drops from all-groups to `all` minus `info`/`rpc`.
  - Mirror WebSocket collector now filters the `subscriptionResponse` ack frame, which shares the `{ channel, data }` envelope of real data and was being collected as a bogus item.
- All 8 Live mirror channels live-verified. `allMids`, `l2Book`, `allFills`, `userFills` deliver reliably. Documented the ones the upstream hub does not yet serve well: `bbo` (accepted but silent, steer to `l2Book`), `trades` ("Unsupported subscription" upstream, steer to `hd_stream_completed_trades`), `l4Book` (deep snapshots can exceed the runtime WebSocket decompression limit), `l4BookUpdates` (accepted but sparse). Each tool's description and the README carry the per-channel status.
- User-Agent header set to `hypedexer-mcp/1.0.0`.

## 0.1.0

Initial base: a large, usable foundation.

- 83 read-only MCP tools across 17 env-gated groups (8 keyless `hl_public_*` Hyperliquid tools + 75 `hd_*` HypeDexer tools), covering HypeDexer's full API surface: Data API REST, both WebSocket hubs, and the HyperEVM JSON-RPC product.
- `streams` group: the indexed multiplex WebSocket channels (`completed_trades`, `fills_spot`, `recent_activity`, `liquidation`, `hip4_events`) as bounded-window snapshot tools over the native global `WebSocket` (no `ws` dependency). `hd_stream_fills_spot` is the only working source of spot-fill data.
- `live` group: the Live (mirror) WebSocket channels on `?mode=mirror` (`allFills`, `userFills`, `bbo`, `l2Book`, `l4Book`, `l4BookUpdates`, `trades`, `allMids`) as bounded-window snapshots.
- `rpc` group: HyperEVM JSON-RPC (`https://rpc.hypedexer.com`): a generic `hd_rpc_call` passthrough over the whole read surface, typed convenience tools (block number, eth_call, getLogs, getBlock), and `hd_rpc_subscribe` snapshotting `eth_subscribe` (newHeads/logs/pending) over WS. Read-only: state-mutating methods are refused.
- stdio and streamable-HTTP (per-session) transports.
- Vendored, tested core: HTTP client, error taxonomy, 4-kind pagination, time/sentinel handling, 3 envelope families.
- Quirks normalized in one layer (1970 sentinels, page-size-as-total, asc-cursor corruption, not_yet_live, IPv4 node addresses).
- Uniform pagination handles + recovery-steering errors + token-budgeted, structured outputs.
- Boots and smoke-tests with no API key via the keyless public group.
- Dependency-free `.env` auto-loading (override → cwd → package root; existing env wins) with a `HYPEDEXER_ENV_FILE` override.
- `scripts/launch.sh` for Claude Desktop on Windows + WSL (resolves nvm `node`, keeps stdout clean for the MCP stream).
