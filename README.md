# @hypedexer/mcp-server

> [Model Context Protocol](https://modelcontextprotocol.io) server for the [HypeDexer](https://hypedexer.com) Hyperliquid indexer: 83 read-only tools over the full API surface (REST, both WebSocket hubs, HyperEVM JSON-RPC), plus keyless Hyperliquid public tools so it works with no API key at all.

[![tools](https://img.shields.io/badge/tools-83%20read--only-8A2BE2?labelColor=333)](#tool-catalog)
[![MCP SDK](https://img.shields.io/badge/MCP%20SDK-1.29-blue?labelColor=333)](https://github.com/modelcontextprotocol/typescript-sdk)
[![node >= 22](https://img.shields.io/badge/node-%3E%3D22-3c873a?labelColor=333)](https://nodejs.org)
[![tests](https://img.shields.io/badge/tests-71%20passing-brightgreen?labelColor=333)](#development)
[![license MIT](https://img.shields.io/badge/license-MIT-blue?labelColor=333)](./LICENSE)

```
your AI client  ──MCP──▶  hypedexer-mcp  ──▶  api.hypedexer.com   (keyed: hd_* tools)
                                          └─▶  api.hyperliquid.xyz (keyless: hl_public_* tools)
```

---

## Why this server

If you've wired an agent to `api.hypedexer.com` directly, you've hit them all:

- 3 different response envelopes depending on the endpoint, plus cursor, offset and time-window pagination on different routes.
- Sentinel timestamps (`1970-01-01`), page-size-as-total counts, an ascending liquidation cursor that corrupts to year 2245.
- WebSockets that push continuously while MCP tools are request/response, on two different hubs with two different message envelopes.
- Responses big enough to blow an agent's entire context on one call.

This server collapses all of that behind **one tool contract**: uniform pagination handles with a `hint` for the exact next call, a token budget that truncates with steering notes instead of flooding, errors that say how to recover, and quirks normalized once so agents never see the raw noise.

### At a glance

|                |                                                                                  |
| -------------- | -------------------------------------------------------------------------------- |
| **Coverage**   | 83 tools: ~88 REST endpoints + 13 WS channels (2 hubs) + HyperEVM JSON-RPC       |
| **Keyless**    | 8 `hl_public_*` tools hit the free Hyperliquid API: boots with no key            |
| **Groups**     | 17 env-gated groups, 3 presets (`public` / `core` / `all`)                       |
| **Transports** | stdio (default) + streamable HTTP (per-session)                                  |
| **Safety**     | Read-only by construction; state-mutating RPC methods are refused                |
| **Runtime**    | Node >= 22, native `WebSocket`, no `ws` dependency                               |
| **Tests**      | 71 unit tests (mocked fetch + in-memory MCP client) + gated live suite           |

> **AI coding agents:** contributing to this repo? Read [`AGENTS.md`](./AGENTS.md) first: verification loop, the tool-module pattern, hard-won MCP lessons, and the upstream quirks you must not "fix". Consuming the server through an MCP client? The contract is in [How results are shaped](#how-results-are-shaped-for-agents) and in each tool's description.

---

## Quick start (no API key)

Point your client at the server. With no key, the keyless `public` group is enabled.

**Claude Desktop**: add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "hypedexer": {
      "command": "npx",
      "args": ["-y", "@hypedexer/mcp-server"],
      "env": { "HYPEDEXER_MCP_TOOLS": "public" }
    }
  }
}
```

Restart Claude Desktop, then ask: *"Use HypeDexer to get the current BTC mid price"* (calls `hl_public_all_mids`).

## With a HypeDexer API key

Generate a key at [app.hypedexer.com](https://www.app.hypedexer.com/) and set `HYPEDEXER_API_KEY` to unlock the full `hd_*` surface:

```json
{
  "mcpServers": {
    "hypedexer": {
      "command": "npx",
      "args": ["-y", "@hypedexer/mcp-server"],
      "env": {
        "HYPEDEXER_API_KEY": "your_key_here",
        "HYPEDEXER_MCP_TOOLS": "all"
      }
    }
  }
}
```

**Cursor**: add to `~/.cursor/mcp.json` (same shape):

```json
{
  "mcpServers": {
    "hypedexer": {
      "command": "npx",
      "args": ["-y", "@hypedexer/mcp-server"],
      "env": { "HYPEDEXER_API_KEY": "your_key_here" }
    }
  }
}
```

## Hosted / HTTP transport

For a hosted deployment, run the streamable-HTTP transport:

```bash
HYPEDEXER_API_KEY=… HYPEDEXER_MCP_TRANSPORT=http hypedexer-mcp
# or: hypedexer-mcp --http
# POST/GET/DELETE http://127.0.0.1:3000/mcp   (per-session, mcp-session-id header)
# GET  http://127.0.0.1:3000/health
```

## Configuration

| Env | Purpose | Default |
|---|---|---|
| `HYPEDEXER_API_KEY` | Unlocks the `hd_*` tools. Absent: only keyless `public`. | _(none)_ |
| `HYPEDEXER_MCP_TOOLS` | Tool groups: a preset (`public`/`core`/`all`) or a comma list. | `all` |
| `HYPEDEXER_MCP_TRANSPORT` | `stdio` or `http`. | `stdio` |
| `HYPEDEXER_MCP_HTTP_PORT` / `_HOST` | HTTP transport bind. | `3000` / `127.0.0.1` |
| `HYPEDEXER_BASE_URL` | HypeDexer API base. | `https://api.hypedexer.com` |
| `HYPERLIQUID_BASE_URL` | Hyperliquid public API base. | `https://api.hyperliquid.xyz` |
| `HYPEDEXER_WS_URL` | WSS endpoint for the `streams`/`live` groups. Derived from `HYPEDEXER_BASE_URL` when unset. | _(derived)_ |
| `HYPEDEXER_RPC_URL` | HyperEVM JSON-RPC HTTP base for the `rpc` group. | `https://rpc.hypedexer.com` |
| `HYPEDEXER_RPC_WS_URL` | JSON-RPC WSS endpoint for `eth_subscribe`. Derived from `HYPEDEXER_RPC_URL` when unset. | _(derived)_ |
| `HYPEDEXER_REQUEST_TIMEOUT_MS` | Per-request timeout. | `30000` |
| `HYPEDEXER_MAX_RESPONSE_TOKENS` | Soft cap before truncate-with-steering. | `25000` |
| `HYPEDEXER_LOG_LEVEL` | `debug`/`info`/`warn`/`error`/`silent` (stderr). | `info` |
| `HYPEDEXER_ENV_FILE` | Explicit path to a `.env` file to load (overrides the default search). | _(none)_ |

### `.env` file (auto-loaded)

On startup the server loads a `.env` file into the environment, with no dependency and no flag. **Already-set variables always win**, so a client's `env` block (or a shell export) still takes precedence over the file. Search order, first hit wins:

1. `$HYPEDEXER_ENV_FILE`, if set.
2. `./.env` in the current working directory.
3. `.env` at the package root (next to `dist/`), robust even when the launcher sets an unrelated cwd.

Copy [`.env.example`](./.env.example) to `.env`, drop your key in, and your MCP client config can stay env-free:

```bash
cp .env.example .env   # then edit HYPEDEXER_API_KEY
```

Supports `KEY=value`, `export KEY=value`, `#` comments, `'single'`/`"double"` quotes (only double quotes expand `\n`), and trailing `# inline comments` on unquoted values. The file is git-ignored.

### Windows + WSL (Claude Desktop)

Claude Desktop runs on Windows, so it must spawn the server through `wsl.exe`. Two gotchas: an **nvm-installed `node` is not on the non-interactive PATH** (so `"args": ["node", …]` fails with `command not found`), and `env` variables don't cross into WSL cleanly. The bundled launcher [`scripts/launch.sh`](./scripts/launch.sh) solves both: it resolves `node` via nvm (quietly, stdout stays clean for the MCP stream) and execs the server. Put your key in `.env` at the repo root and the Desktop config becomes trivial:

```json
{
  "mcpServers": {
    "hypedexer": {
      "command": "wsl.exe",
      "args": ["bash", "/home/<you>/hypedexer-mcp/scripts/launch.sh"]
    }
  }
}
```

No `env`, no `WSLENV`, no key pasted into JSON. Restart Claude Desktop. (On macOS/Linux with `node` on PATH, just use `"command": "node", "args": ["/path/to/dist/index.js"]`, or `npx` as shown above, and the same `.env` is picked up.)

### Tool groups & presets

`public` (keyless) is always on. Keyed groups self-skip when no key is set.

- **Presets:** `public` (keyless only) · `core` (public + fills, markets, analytics, traders, liquidations, funding, vaults) · `all` (everything except the opt-in-only `info` and `rpc` groups).
- **Groups:** `public`, `fills`, `markets`, `analytics`, `traders`, `liquidations`, `funding`, `vaults`, `hip3`, `hip4`, `builders`, `twaps`, `evm`, `streams`, `live`, `rpc`, `info`.

Two groups are never in a preset and must be requested by name:
- `info`: the raw `/info` escape hatch (`HYPEDEXER_MCP_TOOLS=all,info`).
- `rpc`: its endpoint (`rpc.hypedexer.com`) is not deployed yet, so it is off by default; enable it with `HYPEDEXER_MCP_TOOLS=all,rpc` once the host is live or when pointing `HYPEDEXER_RPC_URL` at another node.

## Tool catalog

All tools are read-only. `hl_public_*` need no key; `hd_*` need `HYPEDEXER_API_KEY`.

| Group | Tools |
|---|---|
| `public` | `hl_public_all_mids`, `hl_public_perp_meta`, `hl_public_spot_meta`, `hl_public_l2_book`, `hl_public_candles`, `hl_public_funding_history`, `hl_public_predicted_fundings`, `hl_public_clearinghouse_state` |
| `fills` | `hd_fills_search`, `hd_fills_count` |
| `markets` | `hd_market_snapshot_24h`, `hd_market_daily_series`, `hd_user_coin_distribution` |
| `analytics` | `hd_analytics_fills_stats`, `hd_analytics_priority_fees`, `hd_analytics_liquidations_stats` |
| `traders` | `hd_user_profile`, `hd_user_coins`, `hd_traders_leaderboard`, `hd_traders_active`, `hd_completed_trades_search`, `hd_completed_trade_fills` |
| `liquidations` | `hd_liquidations_search` |
| `funding` | `hd_funding_predicted`, `hd_funding_history`, `hd_user_funding` |
| `vaults` | `hd_vaults_list`, `hd_vault_details`, `hd_vault_snapshots`, `hd_user_vault_equities` |
| `hip3` | `hd_hip3_overview`, `hd_hip3_dexs`, `hd_hip3_assets`, `hd_hip3_auctions`, `hd_hip3_snapshots`, `hd_hip3_ohlcv`, `hd_hip3_oracle_stats`, `hd_hip3_fills`, `hd_hip3_traders`, `hd_hip3_user`, `hd_hip3_gossip` |
| `hip4` | `hd_hip4_markets`, `hd_hip4_questions`, `hd_hip4_outcome_tokens`, `hd_hip4_fills`, `hd_hip4_fees`, `hd_hip4_settlements`, `hd_hip4_analytics`, `hd_hip4_preview` |
| `builders` | `hd_builders`, `hd_builder_stats`, `hd_builder_users` |
| `twaps` | `hd_twaps_search`, `hd_twaps_stats`, `hd_twap_detail` |
| `evm` | `hd_evm_stats`, `hd_evm_blocks`, `hd_evm_transactions`, `hd_evm_logs`, `hd_evm_transfers`, `hd_evm_bridge_events`, `hd_evm_user`, `hd_evm_hip3_backstop` |
| `streams` | `hd_stream_completed_trades`, `hd_stream_fills_spot`, `hd_stream_recent_activity`, `hd_stream_liquidations`, `hd_stream_hip4_events` |
| `live` | `hd_live_all_fills`, `hd_live_user_fills`, `hd_live_bbo`, `hd_live_l2_book`, `hd_live_l4_book`, `hd_live_l4_book_updates`, `hd_live_trades`, `hd_live_all_mids` |
| `rpc` | `hd_rpc_call`, `hd_rpc_block_number`, `hd_rpc_call_contract`, `hd_rpc_get_logs`, `hd_rpc_get_block`, `hd_rpc_subscribe` |
| `info` | `hd_info_raw` |

### WebSocket channels as snapshots (`streams` + `live` groups)

MCP tools are request/response; HypeDexer's WebSockets push continuously. The `hd_stream_*` and `hd_live_*` tools bridge the gap: each opens the socket, subscribes to one channel, collects pushed messages for a bounded window (`seconds`, 1-30, default 5, or until `max_items`), then closes and returns the batch: a **point-in-time snapshot, not a standing subscription**. Call again for a fresh window.

- **`streams`**: the indexed *multiplex* endpoint (`wss://.../ws`): `completed_trades` (optional `user` scope), `fills_spot` (the only working spot-fill source, since REST `/spot/*` is broken upstream), `recent_activity`, `liquidation`, `hip4_events`.
- **`live`**: the Live *mirror* endpoint (`wss://.../ws?mode=mirror`): order books (`l2Book`/`l4Book`/`l4BookUpdates`), `bbo`, `trades` (per `coin`), the `allFills` firehose, `userFills` (per `user`), and `allMids`. Book channels return the current snapshot in the first frame.

  Per-channel status (live-verified 2026-07-01, the upstream mirror hub is still maturing):

  | Channel | Status |
  | --- | --- |
  | `allMids`, `l2Book`, `allFills`, `userFills` | Working: deliver data reliably. |
  | `bbo` | Subscription accepted but no frames emitted upstream. Use `l2Book` (top level = best bid/offer). |
  | `trades` | Rejected upstream ("Unsupported subscription"). Use `hd_stream_completed_trades` or `l2Book`. |
  | `l4Book` | Deep snapshots can exceed the runtime WebSocket decompression limit and error. Use `l2Book`. |
  | `l4BookUpdates` | Accepted but sparse; may return nothing in a short window. |

  The mirror hub also rate-limits rapid reconnects (a back-to-back second connection may be refused), so space snapshot calls a few seconds apart.

### HyperEVM JSON-RPC (`rpc` group)

> **Not deployed yet (opt-in).** As of 2026-07-01 `rpc.hypedexer.com` returns DNS NXDOMAIN, so every `rpc` call network-errors. The group is therefore excluded from the `all` preset and off by default. Enable it explicitly with `HYPEDEXER_MCP_TOOLS=all,rpc` once HypeDexer deploys the endpoint, or point `HYPEDEXER_RPC_URL` at a reachable HyperEVM JSON-RPC node.

The `rpc` tools reach the separate HyperEVM JSON-RPC product (`https://rpc.hypedexer.com`, same `X-API-Key`). `hd_rpc_call` is a generic passthrough covering the entire read surface (`eth_*`, `net_*`, `web3_*`); typed convenience tools cover the headline reads (`hd_rpc_block_number`, `hd_rpc_call_contract`, `hd_rpc_get_logs`, `hd_rpc_get_block`). `hd_rpc_subscribe` snapshots an `eth_subscribe` stream (newHeads / logs / newPendingTransactions) over `wss://rpc.hypedexer.com`. State-mutating methods (`eth_sendRawTransaction`) are refused: the surface is read-only.

## How results are shaped (for agents)

These follow Anthropic's [tool-design guidance](https://www.anthropic.com/engineering/writing-tools-for-agents):

- **Structured + readable.** Every tool serializes the real data into the text content block (what every client shows the model) and mirrors it in `structuredContent` (`{ data, pagination?, meta?, notes? }`).
- **Uniform pagination.** List tools return a `pagination` handle with `has_more` and the relevant `next_cursor` / `next_offset` / `next_end_time`, plus a `hint` telling the agent the exact next call. No infinite loops.
- **Token budget with steering.** Oversized list results are truncated and the `notes` say how to narrow the query.
- **Recovery-steering errors.** Failures return a specific fix (e.g. "set `HYPEDEXER_API_KEY`", "use `order=desc`"), never an opaque code.
- **Quirks normalized once.** 1970 sentinels become `null`, page-size-as-total is dropped, ascending-cursor corruption is refused, `not_yet_live` surfaces are noted, IPv4 node addresses are renamed; agents never see the raw noise. See [`DESIGN.md`](./DESIGN.md).
- **`response_format`.** Pass `detailed` when you need ids to chain follow-up calls; `concise` (default) for high-signal fields.

## Known upstream quirks this server absorbs

Condensed reference; the full catalog with rationale lives in [`DESIGN.md`](./DESIGN.md).

| Upstream | Server posture |
|---|---|
| 3 response envelope families (`APIResponse`, bare, HIP-4) | Normalized into one `{ data, pagination, meta }` shape |
| Cursor / offset / time-window pagination per route | One `pagination` handle with a ready-to-use `hint` |
| `/liquidations/?order=asc` corrupt cursor (year 2245) | Ascending iteration refused with a steering error |
| Sentinel timestamps (`1970-01-01`) | Returned as `null` |
| `total_count` sometimes = page size | Dropped rather than passed through wrong |
| HIP-4 `not_yet_live` responses | Surfaced in `meta` with the upstream message, not faked as empty |
| Gossip leaderboard `address` is an IPv4 | Renamed to a node-IP field |
| Unbounded upstream response sizes | 25k-token budget, tail-truncation with steering notes |
| Mirror WS ack frame mimics the data envelope | Filtered out of snapshots |
| Dead / degraded channels (`rpc` host, `bbo`, `trades`, `l4Book`) | Gated or flagged in tool descriptions with an alternative |

## Development

```bash
pnpm install
pnpm build          # tsup -> dist/
pnpm typecheck      # strict tsc
pnpm test           # vitest (mocked fetch), 71 tests
pnpm test:live      # also runs live keyless tests against api.hyperliquid.xyz
pnpm smoke          # build + in-memory MCP client smoke (keyless)
pnpm inspect        # build + MCP Inspector
```

Architecture, the full tool catalog, and the applied tool-design principles live in [`DESIGN.md`](./DESIGN.md).

## Repository layout

```
hypedexer-mcp/
├── src/
│   ├── core/           vendored transport: HttpClient, errors, pagination, time, envelopes
│   ├── hypedexer/      keyed API client, quirks layer, WS + RPC clients
│   ├── hyperliquid/    keyless public API client
│   ├── tools/          17 tool groups + shared contracts (schemas, pagination, output, errors)
│   └── transports/     stdio + streamable HTTP
├── test/               71 unit tests + gated live suite
├── scripts/            launch.sh (Claude Desktop WSL) + smoke scripts
├── DESIGN.md           design doc: catalog, layering, tool-design guidance
├── AGENTS.md           contribution guide for AI coding agents
└── AUDIT.md            multi-agent audit report (2026-06-30)
```

## Contributing

A few non-negotiables (the full list is in [`AGENTS.md`](./AGENTS.md)):

- **All four checks must pass:** `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
- **ESM imports carry the `.js` extension** (`--moduleResolution NodeNext`).
- **Comments in English**, and only where the *why* is non-obvious.
- **No em-dash characters** anywhere: code, comments, docs, commit messages.
- **stdout belongs to the MCP stream**; log through `src/logger.ts` (stderr).

## License

MIT. This project mirrors and wraps publicly documented APIs; it is not affiliated with or endorsed by Hyperliquid.
