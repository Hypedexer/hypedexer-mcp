# Changelog

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
