# HypeDexer MCP Server — Design

> 2026-08-05: transports migrated to MCP spec 2026-07-28 / SDK v2 (stateless HTTP via `createMcpHandler`, no sessions; SDK packages `@modelcontextprotocol/server`/`node`/`client`, zod 4). Transport details below describe the original 1.x design; `src/transports/http.ts` is authoritative.
>
> Source: research+design workflow (wf_50bf6e52). Catalog grounded against ~/hypedexer-sdk/ENDPOINTS.md (100 entry points). MCP SDK specifics verified against installed @modelcontextprotocol/sdk@1.29.0.

## Summary

A single, buildable design for a production-grade HypeDexer MCP server in TypeScript (ESM, Node >=20, official @modelcontextprotocol/sdk + Zod). It vendors the already-proven SDK core (HttpClient + error taxonomy + 4-kind pagination + time/sentinel handling + 3 envelope families) into src/core/, adds a key-free Hyperliquid public-info client, and exposes 93 consolidated, agent-shaped read-only tools across 18 env-gated domain groups (including `streams` + `live` groups that snapshot the two WebSocket hubs, and an `rpc` group for the HyperEVM JSON-RPC product). It runs with no key (the 8 hl_public_* tools hit api.hyperliquid.xyz directly) and unlocks the paid HypeDexer surface when HYPEDEXER_API_KEY is set. Both stdio (Claude Desktop/Cursor) and streamable HTTP (hosted mcp.hypedexer.com) transports ship. Every documented server quirk (asc-cursor corruption, 1970 sentinels, total_count=page-size, not_yet_live, key-shift drops, ClickHouse 500 on /spot, IPv4 winner mislabel) is normalized in one quirks layer so agents never see raw noise. Tools return structuredContent + a concise text summary, uniform pagination handles (next_cursor/next_offset/next_end_time + a steering hint), recovery-guiding errors, and a 25k-token budget with truncate-with-steering.

## Architecture

Request flow: an MCP tool call -> Zod input parse (strict, recovery-steering errors) -> a domain handler that builds an HttpRequest -> the vendored HttpClient (api.hypedexer.com, X-API-Key) OR the HyperliquidPublicClient (POST api.hyperliquid.xyz/info, no auth) -> raw JSON -> envelope.ts normalizes the 3 families (APIResponse / bare / Hip4Envelope) into a uniform Page<T>/Single<T> with PageMeta -> quirks.ts strips/repairs documented defects -> output.ts shapes a concise|detailed view and enforces the token budget -> the tool returns { content:[{type:'text', text: summary}], structuredContent: { data, pagination, meta } }.

Layering is strict and one-directional: core/ (transport, errors, time, pagination, envelope types) knows nothing about MCP; hypedexer/ and hyperliquid/ are thin typed callers over core; tools/ is the only layer that imports the MCP SDK and Zod; transports/ only wires a built McpServer to a channel. This keeps the network/normalization code unit-testable against the saved sample JSON without touching the MCP machinery.

Tool philosophy follows Anthropic's writing-tools-for-agents guidance: we do NOT mirror all 94 REST endpoints. We consolidate the REST surface to 64 workflow tools using three moves: (1) fold list+detail into one tool with an id/ticker param that switches to single-record mode; (2) fold sibling endpoints behind a `view` enum (e.g. hip3 auctions live|current|history, evm stats current|daily); (3) fold recent/all and perp/spot scopes into one search tool with a scope flag. The /spot REST endpoints, broken upstream (500) at design time, shipped anyway folded into hd_fills_search as scope=spot; upstream fixed them on 2026-07-06 and they now return data (live-verified). hd_stream_fills_spot remains the low-latency push source. On top of the 64 Data-API REST tools, three groups extend coverage to the rest of the HypeDexer surface: `streams` (5 tools, the indexed multiplex WS channels), `live` (8 tools, the Live mirror WS channels: order books, mids, fills), and `rpc` (6 tools, the HyperEVM JSON-RPC product over HTTP + an eth_subscribe snapshot), and the permissionless HIP-4 attribution surface (`hd_hip4_providers`, `hd_hip4_deployers`, shipped 2026-08-29 the day the upgrade landed), and `elysium` (8 tools over the 22 Elysium testnet routes, added 2026-09-30). 93 tools total.

Tool groups are registered through a registry keyed by group name and filtered by the HYPEDEXER_MCP_TOOLS gate before McpServer.registerTool is ever called, so ungated groups cost zero definition tokens. The free `public` group is always registered (works keyless); key-gated groups self-skip with a one-line log if HYPEDEXER_API_KEY is absent, so a no-key install still boots and smoke-tests end-to-end.

> single package, not the monorepo; ships as @hypedexer/mcp with a bin.

## Transports

Two transports selected by MCP_TRANSPORT (or --transport CLI), both from the official SDK. (1) stdio (default): StdioServerTransport; the only thing written to stdout is JSON-RPC, all logs go to stderr via logger.ts. This is what Claude Desktop and Cursor spawn. (2) Streamable HTTP: StreamableHTTPServerTransport mounted on a node:http server (no express dependency) at POST/GET/DELETE /mcp, for hosted mcp.hypedexer.com. It runs in stateful mode with per-session ids (Mcp-Session-Id header) and a sessions map, supports SSE streaming for server->client notifications, and enables enableDnsRebindingProtection with an allowedHosts/allowedOrigins allowlist. A --stateless flag switches to a fresh-transport-per-request mode for horizontally-scaled deployments. Both modes build the identical McpServer from server.ts; transport choice never touches tool code. SIGINT/SIGTERM closes transports and the http server gracefully.

## Error model

All network/validation errors originate as the vendored HypedexerError subclasses (Auth/NotFound/RateLimit/Server/Network/Validation) from core/errors.ts; the public client reuses the same parseError. tools/shared/errors.ts::toToolError maps them to MCP tool results with isError:true and recovery-steering text (never a raw stack/code): ValidationError -> restate the expected format and give a correctly-formatted example for the offending field (uses ValidationError.field(name) + FastAPI loc to point at the exact param); NotFoundError (404 {detail}) -> say the id/address wasn't found and name the list tool to discover valid ones; RateLimitError (429) -> advise a short backoff and fewer/narrower calls; ServerError on the /spot endpoints (the ClickHouse 500 leak) -> a dedicated message steering the agent to hl_public_spot_meta and the WS fills_spot channel rather than retrying; AuthError (401) -> say HYPEDEXER_API_KEY is missing/invalid and that public tools still work without it. Input-side, Zod validation failures are converted the same way before any request is sent (enum guards for the many silent-fallback params: sort/by/order/action_type/event_type/interval), so the agent gets the valid enum set instead of a silently-wrong empty result. not_yet_live is NOT an error: hd_hip4_preview and any not_yet_live response returns a normal result with structuredContent.meta.status='not_yet_live' + the testnet_docs link, so the agent stops retrying. asc-cursor on liquidations is refused at input with a message telling the agent to use order=desc (the upstream asc cursor is corrupt). Every error result also includes which tool/param failed so multi-step agents can self-correct.

## Pagination model

One uniform handle on every list-returning tool, emitted by tools/shared/pagination.ts into structuredContent.pagination, regardless of the underlying kind (cursor | offset | timeWindow | none-list). Fields: { kind, has_more, next_cursor? (cursor kind), next_offset? (offset kind), next_end_time? (timeWindow kind), hint }. The agent never has to know the upstream scheme — it just passes back whatever non-null next_* field it got. hint is a one-line natural-language instruction modeling the correct next move, e.g. 'More results available — call again with offset=200' or 'Older rows available — call again with end_time=<next_end_time>' or, when a broad query is truncated, 'Narrow with coin= or a tighter time window instead of paging'. Quirk normalizations feed this layer: (a) spot fills' total_count==page-size is discarded and has_more is derived from whether the page filled to limit; (b) cursor kind sets has_more=false when next_cursor is null OR the page underfills; (c) liquidations asc order never produces a next_cursor (refused upstream); (d) time-window tools compute next_end_time = (oldest row time − 1) reusing core/pagination.ts timeOfRow logic; (e) none-list tools always return has_more=false and no next_*. total_count is only surfaced when upstream actually provides a trustworthy one (e.g. twap fills), otherwise omitted to avoid misleading the agent. The text summary always ends with the hint when has_more is true.

## Output formatting

Every tool returns BOTH a machine payload and a concise text summary: { content:[{type:'text', text}], structuredContent:{ data, pagination?, meta } } with an outputSchema (Zod) so structuredContent is contract-validated. response_format ('concise' default | 'detailed') controls verbosity per Anthropic's guidance: concise drops low-signal noise (raw uuids, all-zero hashes, mime/type-ish codes, the always-0 fields like total_priority_gas/asset_id/block_height, execution_time_ms when null) and emits semantic names the model reasons over (coin, user_address, names) — NOT cryptic ids; detailed re-adds the chaining ids (tid, hash, composite trade_id, cursor) the agent needs for a follow-up call. The text summary is a few high-signal lines (counts, top/extreme rows, the pagination hint) so a tool-picking agent gets the gist without parsing JSON. Quirk normalizers in quirks.ts run before shaping: 1970/empty-string timestamps -> null (via core/time.ts sentinels), shifted keys feeUsdc/typeTrade dropped, portfolio->leaderCommissionHistory, gossip address->node_ip and winner->winner_node_ip, hip4 pipe-description parsed into fields, settlement/gossip de-dup, hip3 auction_id coerced to string. Token budgeting: tools/shared/output.ts enforces HYPEDEXER_MAX_TOKENS (default 25k) by row-truncating large pages and replacing the tail with a steering note ('showing 120 rows; more exist — apply a coin/time filter or page with the handle above'), so a no-cap endpoint like /completed-trades can never blow the context window. Intermediate raw bodies never reach the model: normalization/aggregation happens in-process and only the shaped result is returned.

## Env / config

| Env | Purpose | Default |
|---|---|---|
| `HYPEDEXER_API_KEY` | X-API-Key for api.hypedexer.com. If unset, key-gated groups are skipped (with a stderr notice) and only the public group loads, so the server still boots and smoke-tests. | (none) — keyless mode |
| `HYPEDEXER_BASE_URL` | override paid API base (staging/self-host) | https://api.hypedexer.com |
| `HYPEDEXER_PUBLIC_BASE_URL` | override Hyperliquid public info base | https://api.hyperliquid.xyz |
| `HYPEDEXER_MCP_TOOLS` | tool-group gate: a preset (all | core | public) or a CSV of group names (e.g. public,fills,traders,hip4). 'info' must be named explicitly. Invalid names error at boot with the valid list. | core |
| `MCP_TRANSPORT` | stdio | http | stdio |
| `MCP_HTTP_PORT` | port for http transport | 3000 |
| `MCP_HTTP_HOST` | bind host for http transport | 127.0.0.1 |
| `MCP_HTTP_ALLOWED_HOSTS` | CSV allowlist for DNS-rebinding protection on http transport | 127.0.0.1,localhost |
| `HYPEDEXER_TIMEOUT_MS` | per-request fetch timeout (AbortController) | 30000 |
| `HYPEDEXER_MAX_TOKENS` | per-tool-response token budget for truncate-with-steering | 25000 |
| `HYPEDEXER_USER_AGENT` | user-agent header sent to both APIs | hypedexer-mcp/<version> |
| `LOG_LEVEL` | error|warn|info|debug (stderr only) | info |

## Tool groups (env-gated)

| Group | Gate | #Tools |
|---|---|---|
| public | always on (keyless); part of presets all|core|public | 8 |
| fills | all|core | 2 |
| markets | all|core | 3 |
| analytics | all|core | 3 |
| traders | all|core | 6 |
| liquidations | all|core | 1 |
| funding | all|core | 3 |
| vaults | all|core | 4 |
| hip3 | all only | 11 |
| hip4 | all only (mostly live, two not_yet_live) | 8 |
| builders | all only | 3 |
| twaps | all only | 3 |
| evm | all only | 8 |
| info | opt-in only (never in a preset; must be named explicitly) | 1 |

## File layout

```
package.json                              @hypedexer/mcp, type:module, bin: hypedexer-mcp -> dist/index.js, exports, files:[dist], engines node>=20.18, deps @modelcontextprotocol/sdk + zod, devDeps tsup/vitest/biome/@types/node/@modelcontextprotocol/inspector
tsconfig.json                             extends repo tsconfig.base.json (NodeNext, strict, exactOptionalPropertyTypes, noUncheckedIndexedAccess), outDir dist
tsup.config.ts                            esm-only build (server is run, not imported), dts off for app build but on for core barrel, target es2022, shims for import.meta, banner #!/usr/bin/env node on index
vitest.config.ts                          node env, include test/**/*.test.ts, v8 coverage over src/**, setup file to load sample fixtures path
biome.json                                reuse repo lint/format config
README.md                                 install (npx @hypedexer/mcp), Claude Desktop + Cursor JSON snippets, env table, tool-group list, keyless-mode note
src/index.ts                              bin entrypoint: parse CLI/env via config.ts, build server via server.ts, pick transport (stdio default | http), wire SIGINT/SIGTERM graceful shutdown, top-level error guard
src/config.ts                             load+validate env (Zod): HYPEDEXER_API_KEY, HYPEDEXER_BASE_URL, HYPEDEXER_PUBLIC_BASE_URL, MCP_TRANSPORT, MCP_HTTP_PORT/HOST, HYPEDEXER_MCP_TOOLS gate (presets all|core|public or csv groups), HYPEDEXER_TIMEOUT_MS, HYPEDEXER_MAX_TOKENS, LOG_LEVEL; resolve enabled group set; expose typed AppConfig
src/server.ts                             construct McpServer({name,version}), instantiate HttpClient (if key) + HyperliquidPublicClient, build ToolContext, iterate tools/registry filtered by enabled groups and registerTool each; return McpServer
src/logger.ts                             tiny stderr-only structured logger (never stdout: would corrupt stdio transport), level-gated
src/core/index.ts                         barrel re-exporting vendored core (http-client, errors, time, pagination, types)
src/core/http-client.ts                   VENDORED verbatim from packages/sdk: HttpClient with AbortController timeout, X-API-Key header, parseError on !ok, JSON parse guard
src/core/errors.ts                        VENDORED: HypedexerError hierarchy (Auth/NotFound/RateLimit/Server/Network/Validation/WebSocket*) + parseError(status,ct,body) mapping 401/422/404/400/429/5xx
src/core/time.ts                          VENDORED: parseTimestamp (iso/epochMs/date/hip4Expiry with 1970 + empty-string -> null sentinels) + encodeTime (isoSnake/epochCamel/isoBare) + parseHip4Expiry
src/core/pagination.ts                    VENDORED: iterate() async-gen over cursor/offset/timeWindow/none; reused server-side only for tools that auto-aggregate (e.g. funding history time-window walk)
src/core/types.ts                         VENDORED: Address/Coin/Hex/Side/Wei, Page<T>/Single<T>/PageMeta, APIResponse<T>, Hip4Envelope<T>, EnvelopeFamily
src/hypedexer/client.ts                   HypedexerClient: thin typed wrapper over HttpClient.request; one get() that takes path+query+envelope family and returns normalized Page/Single via envelope.ts; central place for the /info dispatcher POST
src/hypedexer/envelope.ts                 normalize(raw, family): unwrap APIResponse{success,data,next_cursor,has_more,total_count,execution_time_ms} | bare array/object | Hip4Envelope{status,count,data}; produce Page<T>+PageMeta; the two /info wrap-mismatch types (currentFundingRates, vaultList) handled here
src/hypedexer/quirks.ts                   named normalizers applied per-resource: dropShiftedKeys(feeUsdc,typeTrade), nullify1970(last_activity,twap startTime), renamePortfolio->leaderCommissionHistory, renameGossipAddress->nodeIp / winner->winnerNodeIp (IPv4), fixHip3AuctionIdType (string vs int), correctTotalCount (spot fills total_count=page-size -> derive has_more), markNotYetLive, refuseAscCursor (liquidations asc corruption), dedupeSettlements(outcome_id,nonce), dedupeGossipHistory, parseHip4PipeDescription
src/hyperliquid/public-client.ts          HyperliquidPublicClient: POST {PUBLIC_BASE_URL}/info, body {type,...params}, no auth, reuses core errors+timeout; helper post(type, params)
src/hyperliquid/coin-format.ts            resolveCoin(): perp name passthrough, spot PURR/USDC vs @index lookup against spotMeta, HIP-3 dex-prefixed (e.g. xyz:XYZ100); used by l2_book + candles input docs/validation
src/transports/stdio.ts                   StdioServerTransport wiring; default transport
src/transports/http.ts                    StreamableHTTPServerTransport on node:http server; session-id management, DNS-rebinding/allowed-hosts protection, /mcp route, JSON 4xx for bad sessions; for hosted mcp.hypedexer.com
src/tools/registry.ts                     GroupName union + GROUPS map {group -> ToolDef[]}; ToolDef={name,group,title,description,inputSchema(Zod),outputSchema(Zod),annotations:{readOnlyHint:true},handler}; resolveEnabled(config) -> ToolDef[]; presets all/core/public
src/tools/context.ts                      ToolContext type: {hd?:HypedexerClient, hl:HyperliquidPublicClient, config, logger}; passed to every handler
src/tools/shared/schemas.ts               shared Zod fragments: zAddress (0x42), zCoin, zTimeWindow (start/end ISO or epoch), zPagination (limit,cursor?,offset?), zResponseFormat ('concise'|'detailed' default concise), zHours/zDays with documented caps
src/tools/shared/pagination.ts            buildPaginationHandle(page,kind): emit {kind,next_cursor?|next_offset?|next_end_time?,has_more,hint} into structuredContent; one-line text hint generator ('More: call again with offset=200')
src/tools/shared/output.ts                shape(rows,format): drop noise fields in concise, keep ids (tid/hash) only in detailed; enforceTokenBudget(rows,maxTokens): truncate-with-steering ('showing 120/?, narrow with coin= or a tighter time window'); toToolResult(structured) builds {content,structuredContent}
src/tools/shared/errors.ts                toToolError(e): map HypedexerError subclasses -> isError tool result with recovery text + example; Validation->expected format, NotFound->point at the list tool, RateLimit->backoff, Server(ClickHouse on spot)->steer to hl_public_spot_meta/WS, not_yet_live-> non-error structured status
src/tools/public.ts                       GROUP public: 8 hl_public_* tools over HyperliquidPublicClient (keyless)
src/tools/fills.ts                        GROUP fills: hd_fills_search, hd_fills_count
src/tools/markets.ts                      GROUP markets: hd_market_snapshot_24h, hd_market_daily_series, hd_user_coin_distribution
src/tools/analytics.ts                    GROUP analytics: hd_analytics_fills_stats, hd_analytics_priority_fees, hd_analytics_liquidations_stats
src/tools/traders.ts                      GROUP traders: hd_user_profile, hd_user_coins, hd_traders_leaderboard, hd_traders_active, hd_completed_trades_search, hd_completed_trade_fills
src/tools/liquidations.ts                 GROUP liquidations: hd_liquidations_search
src/tools/hip3.ts                         GROUP hip3: 11 tools (overview,dexs,assets,auctions,snapshots,ohlcv,oracle_stats,fills,traders,user,gossip)
src/tools/hip4.ts                         GROUP hip4: 8 tools (markets,questions,outcome_tokens,fills,fees,settlements,analytics,preview)
src/tools/builders.ts                     GROUP builders: hd_builders, hd_builder_stats, hd_builder_users
src/tools/twaps.ts                        GROUP twaps: hd_twaps_search, hd_twaps_stats, hd_twap_detail
src/tools/funding.ts                      GROUP funding: hd_funding_predicted, hd_funding_history, hd_user_funding
src/tools/vaults.ts                       GROUP vaults: hd_vaults_list, hd_vault_details, hd_vault_snapshots, hd_user_vault_equities
src/tools/evm.ts                          GROUP evm: 8 tools (stats,blocks,transactions,logs,transfers,bridge_events,user,hip3_backstop)
src/tools/info.ts                         GROUP info: hd_info_raw escape-hatch dispatcher (advanced, opt-in only)
test/fixtures.ts                          loader that reads exploration/samples/**/*.json (copied into test/fixtures at build of test or read via relative path) for mocked-fetch responses
test/envelope.test.ts                     unit: 3 families normalize to Page/Single correctly incl /info wrap-mismatch
test/quirks.test.ts                       unit: every quirk normalizer against the exact sample that exhibits it (asc-cursor refuse, 1970->null, total_count fix, hip3 auction_id type, settlements dedupe, gossip nodeIp rename, hip4 pipe parse, not_yet_live)
test/pagination.test.ts                   unit: buildPaginationHandle for cursor/offset/timeWindow + hint text + truncate-with-steering
test/errors.test.ts                       unit: toToolError mapping for 401/404/422/429/500-spot/not_yet_live
test/tools.client.test.ts                 in-memory MCP Client+Server over InMemoryTransport with fetch mocked to fixtures: list tools, call a representative tool per group, assert structuredContent matches outputSchema and text is concise
test/public.live.test.ts                  opt-in (skip unless RUN_LIVE=1) real-network smoke for the 3 zero-arg public tools allMids/predictedFundings/spotMeta
scripts/inspector-smoke.sh                npx @modelcontextprotocol/inspector --cli node dist/index.js --method tools/list and tools/call hl_public_all_mids for a CI stdio smoke
```

## Dependencies

- @modelcontextprotocol/sdk (^ latest 1.x) — runtime dep: McpServer + registerTool, StdioServerTransport, StreamableHTTPServerTransport, and the in-memory Client/InMemoryTransport pair used by tests. The whole MCP contract lives here.
- zod (^3.x, NOT 4) — runtime dep: input/output schemas per tool. Pin to v3 because the current MCP SDK's registerTool infers JSON Schema from Zod v3 shapes; v4 changed internals and is not yet what the SDK expects. zod is the only validation lib needed; it also drives recovery-steering error text.
- devDep typescript (5.7.x) — matches repo toolchain; strict NodeNext build.
- devDep tsup (8.3.x) — bundles src to dist ESM with a shebang banner for the bin; same config style already in the repo.
- devDep vitest (2.1.x) — unit + in-memory-client tests with global fetch mocking; same as repo.
- devDep @types/node (22.x) — node:http, process, AbortController types.
- devDep @biomejs/biome (1.9.x) — lint/format, reuse repo config.
- devDep @modelcontextprotocol/inspector (latest) — CLI smoke (npx --cli) in scripts/inspector-smoke.sh and CI; not a runtime dep.
- NO undici/node-fetch — Node >=20 has global fetch, which the vendored HttpClient already uses. NO express — node:http is enough for the streamable HTTP transport. NO `ws` — the 5 WebSocket channels ship via the **native global `WebSocket`** (Node >=22, which transmits the `X-API-Key` upgrade header) wrapped as bounded-window snapshot tools (`src/hypedexer/ws-client.ts` + the `streams` group), so MCP's request/response model is preserved without adding a dependency.

## Testing strategy

Four layers, all offline-by-default so CI needs no key and no network. (1) Unit — normalization core: vitest suites (envelope.test, quirks.test, pagination.test, errors.test, time) run the real envelope.ts/quirks.ts/output.ts/pagination.ts against the actual saved sample JSON in exploration/samples/** (loaded via test/fixtures.ts). Each documented quirk has a test pinned to the exact sample that exhibits it: liq-order-asc.json -> asc-cursor refusal, liq-baseline.json -> cursor handle, fills_spot total_count fix, hip3 auctions string/int id unification, settlements duplicates -> dedupe, gossip leaderboard address->node_ip, hip4 markets_limit_5.json pipe-description parse + not_yet_live samples (fee-scales/user-actions), funding-predicted.json bare-vs-/info-wrap, vault portfolio rename, 1970 sentinel -> null, completed-trade shifted-key drop. This locks the contract to ground-truth bytes. (2) Mocked-fetch tool handlers: inject a fake FetchLike into HttpClient/HyperliquidPublicClient that returns the matching fixture per path/body; assert each handler builds the right path+query (e.g. fills scope->correct endpoint, time encoding isoSnake vs epochCamel, URL-encoded composite trade_id) and that structuredContent validates against the tool's outputSchema and the pagination handle is correct. (3) In-memory MCP integration (tools.client.test): wire a real McpServer (from server.ts) to a real Client over InMemoryTransport with fetch mocked to fixtures; call tools/list (assert the gated group set + readOnlyHint on all) and tools/call a representative tool per group; assert no stdout pollution, isError mapping for a forced 404/422/spot-500, and concise-vs-detailed verbosity differs. (4) Live smoke (opt-in, RUN_LIVE=1, skipped in default CI): public.live.test hits real api.hyperliquid.xyz for the 3 zero-arg tools (allMids/predictedFundings/spotMeta); plus scripts/inspector-smoke.sh runs `npx @modelcontextprotocol/inspector --cli node dist/index.js --method tools/list` and a `tools/call hl_public_all_mids` against the built stdio binary as a release gate. Coverage thresholds enforced on src/hypedexer, src/hyperliquid, src/tools/shared (the normalization-critical code). Stretch (post-v1, per Anthropic's eval guidance): an agentic while-loop eval harness over multi-call tasks, capturing tool-call counts/tokens/errors, with transcripts fed back into Claude Code to tune tool descriptions against a held-out set.

## Packaging

Published as @hypedexer/mcp with bin { "hypedexer-mcp": "dist/index.js" } (tsup adds the #!/usr/bin/env node shebang; dist/index.js is chmod-exec). Primary UX is npx, no global install needed. Claude Desktop (claude_desktop_config.json): {"mcpServers":{"hypedexer":{"command":"npx","args":["-y","@hypedexer/mcp"],"env":{"HYPEDEXER_API_KEY":"hd_xxx","HYPEDEXER_MCP_TOOLS":"core"}}}}. Keyless smoke (public group only): same block with no env at all. Cursor (~/.cursor/mcp.json, identical schema): {"mcpServers":{"hypedexer":{"command":"npx","args":["-y","@hypedexer/mcp"],"env":{"HYPEDEXER_API_KEY":"hd_xxx"}}}}. Scoping example for a perps-only agent: "env":{"HYPEDEXER_MCP_TOOLS":"public,fills,traders,liquidations,funding"}. Hosted HTTP deployment: run `hypedexer-mcp` with MCP_TRANSPORT=http MCP_HTTP_HOST=0.0.0.0 MCP_HTTP_ALLOWED_HOSTS=mcp.hypedexer.com behind TLS; clients connect with the Streamable HTTP URL https://mcp.hypedexer.com/mcp. README documents all of the above plus the env table and the group list. engines.node>=20.18; files:["dist"]; type:module; provenance publish like the existing sdk package.

## Build plan

1. 1. Scaffold single package @hypedexer/mcp: package.json (bin, type:module, deps @modelcontextprotocol/sdk + zod, devDeps), tsconfig extending tsconfig.base.json, tsup.config.ts (esm + shebang banner), vitest.config.ts, biome.json. Confirm pnpm install + empty build.
2. 2. Vendor the proven SDK core verbatim into src/core/ (http-client.ts, errors.ts, time.ts, pagination.ts, types.ts, index.ts barrel) from packages/sdk/src. Port the existing core unit tests to validate the copy is intact.
3. 3. Build src/hypedexer/envelope.ts (3 families -> Page/Single + PageMeta, incl /info wrap-mismatch) and src/hypedexer/quirks.ts (all named normalizers). Build src/hyperliquid/public-client.ts + coin-format.ts. Cover every normalizer with quirks.test/envelope.test against exploration/samples fixtures (test/fixtures.ts).
4. 4. Build the shared tool plumbing: tools/shared/schemas.ts (zAddress/zCoin/zTimeWindow/zPagination/zResponseFormat), tools/shared/pagination.ts (uniform handle + hint), tools/shared/output.ts (concise/detailed shaping + token-budget truncate-with-steering + toToolResult), tools/shared/errors.ts (toToolError recovery mapping), tools/context.ts. Unit-test pagination/output/errors.
5. 5. Build config.ts (env Zod parse, group-gate preset/CSV resolution, keyless detection) and logger.ts (stderr-only). Build tools/registry.ts (GroupName, GROUPS map, resolveEnabled, presets all|core|public).
6. 6. Implement the public group (8 hl_public_* tools) end-to-end first — it needs no key and gives the earliest live smoke. Add the in-memory client test skeleton (tools.client.test) and the inspector-smoke.sh script; verify tools/list + a keyless tools/call works.
7. 7. Implement the core key-gated groups: fills, markets, analytics, traders, liquidations, funding, vaults. For each tool wire path/query building, envelope family, quirks, pagination handle, output schema, and a mocked-fetch handler test against the matching sample.
8. 8. Implement the deep groups: hip3 (11), hip4 (8), builders (3), twaps (3), evm (8), and the info escape hatch (1). Apply the per-tool quirks (auction_id unify, hip4 pipe parse + not_yet_live, evm enum guards + empty-string nulling, twap 1970 + error-prefixed status).
9. 9. Wire server.ts (build McpServer, instantiate clients, register gated groups with readOnlyHint:true) and transports/stdio.ts + transports/http.ts (node:http StreamableHTTP with session mgmt + DNS-rebinding allowlist + stateless flag). index.ts bin: parse config, pick transport, graceful shutdown.
10. 10. Full in-memory integration pass: tools/list per preset, one tools/call per group, forced-error mapping (404/422/spot-500/not_yet_live), no-stdout-pollution assertion, concise-vs-detailed diff. Wire the opt-in live public test.
11. 11. Token-budget + truncation hardening: prove /completed-trades (no server cap) and the 5000-cap time-window walkers stay under HYPEDEXER_MAX_TOKENS with correct steering hints.
12. 12. Build dist, run scripts/inspector-smoke.sh against the binary, write README (env table, group list, Claude Desktop + Cursor + hosted-HTTP snippets, keyless note). Final pnpm check (lint+typecheck+test+build) green; ready to publish @hypedexer/mcp 0.1.0.

## Open questions

- MCP TS SDK version was provided as null — pin the exact @modelcontextprotocol/sdk 1.x at build time and confirm registerTool's outputSchema/structuredContent support and the StreamableHTTPServerTransport API match this design (zod v3 assumed).
- Default gate preset: this spec defaults HYPEDEXER_MCP_TOOLS=core (public+fills+markets+analytics+traders+liquidations+funding+vaults ≈ 30 tools) to keep definition-token cost low; confirm product wants 'core' vs 'all' (64 tools) as the out-of-box default.
- RESOLVED: the 5 WebSocket channels now ship as the `streams` group (`hd_stream_*`), each a bounded-window snapshot (subscribe, drain for `seconds`/`max_items`, close) over the native global WebSocket — completed_trades (user-scopable), fills_spot, recent_activity, liquidation, hip4_events. A persistent/resource-based streaming surface remains a possible future addition.
- RESOLVED upstream 2026-07-06: the /spot REST endpoints (500 ClickHouse leak at design time) now return data, served through `hd_fills_search` scope=spot (offset-paginated); `hd_stream_fills_spot` remains the push source and `hl_public_spot_meta` the metadata source.
- userFunding and userVaultEquities returned empty for every tested user, so their row shapes are unverified — design returns them with meta.unverified=true. Confirm whether to ship them in v1 or hold until a non-empty sample exists.
- Hosted HTTP auth model: should mcp.hypedexer.com accept the end-user's HYPEDEXER_API_KEY per-session (forwarded as X-API-Key) or use a server-side key with its own tenant auth? This design assumes env-provided key per process; multi-tenant hosting needs a per-request key story.
- Whether to expose an opt-in code-execution/progressive-disclosure path later (search_tools) given 64 definitions — fine at this count, but worth revisiting if more groups/HIP versions are added.

---

## Tool catalog (93 tools)

### `hl_public_all_mids`  (public, read-only)

Live mid prices for every perp and spot coin on Hyperliquid. Zero-arg smoke test; works with no API key.

- **Backing:** POST api.hyperliquid.xyz/info {type:allMids}
- **Pagination:** none
- **Tier:** core
- **Inputs:**
  - `dex` — string: optional HIP-3 dex name to scope mids
- **Output:** map coin->mid as structuredContent; concise text lists top movers vs a few majors
- **Quirks to normalize:** keyless

### `hl_public_perp_meta`  (public, read-only)

Perpetuals universe (coins, szDecimals, maxLeverage, margin tables); set include_contexts to also get markPx/funding/openInterest/midPx/prevDayPx per asset.

- **Backing:** POST /info {type:meta|metaAndAssetCtxs}
- **Pagination:** none
- **Tier:** core
- **Inputs:**
  - `dex` — string: HIP-3 dex
  - `include_contexts` — boolean: true -> metaAndAssetCtxs
- **Output:** universe array (+ctx) structured; concise text = coin count + sample
- **Quirks to normalize:** keyless; consolidates meta + metaAndAssetCtxs

### `hl_public_spot_meta`  (public, read-only)

Spot tokens + pair universe needed to resolve @{index} coin ids; include_contexts adds markPx/midPx/dayNtlVlm/prevDayPx. Pairs with hd_fills_search scope=spot (REST, working upstream since 2026-07-06) to resolve the spot coin handles it returns.

- **Backing:** POST /info {type:spotMeta|spotMetaAndAssetCtxs}
- **Pagination:** none
- **Tier:** core
- **Inputs:**
  - `include_contexts` — boolean: true -> spotMetaAndAssetCtxs
- **Output:** tokens+universe structured; index<->name map in concise text
- **Quirks to normalize:** keyless; use to resolve spot coin ids for l2_book/candles

### `hl_public_l2_book`  (public, read-only)

Order-book snapshot up to 20 levels/side. coin format: perp=name (BTC), spot=PURR/USDC or @{index}, HIP-3=dex:TICKER.

- **Backing:** POST /info {type:l2Book}
- **Pagination:** none
- **Tier:** core
- **Inputs:**
  - `coin` (required) — string: see coin format note
  - `nSigFigs` — number: level aggregation
  - `mantissa` — number
- **Output:** bids/asks levels structured; concise text = best bid/ask + spread
- **Quirks to normalize:** keyless; coin-format helper validates

### `hl_public_candles`  (public, read-only)

OHLCV candles (max 5000). Params nest under req. Interval e.g. 1m/1h/1d. Paginate via last candle time as next startTime.

- **Backing:** POST /info {type:candleSnapshot, req:{...}}
- **Pagination:** time-window (5000 cap)
- **Tier:** core
- **Inputs:**
  - `coin` (required) — string
  - `interval` (required) — string: e.g. 1h
  - `start_time` (required) — number|string: epoch ms or ISO
  - `end_time` — number|string
- **Output:** OHLCV rows structured + next_start_time handle
- **Quirks to normalize:** keyless; params wrapped in req

### `hl_public_funding_history`  (public, read-only)

Historical funding rates for one coin from startTime; rate/premium are string-encoded.

- **Backing:** POST /info {type:fundingHistory}
- **Pagination:** time-window
- **Tier:** core
- **Inputs:**
  - `coin` (required) — string
  - `start_time` (required) — number|string
  - `end_time` — number|string
- **Output:** rows structured + next_start_time
- **Quirks to normalize:** keyless

### `hl_public_predicted_fundings`  (public, read-only)

Predicted funding per venue (HlPerp/Binance/Bybit). Zero-arg; great smoke test.

- **Backing:** POST /info {type:predictedFundings}
- **Pagination:** none
- **Tier:** core
- **Output:** per-coin per-venue structured; concise = biggest divergences
- **Quirks to normalize:** keyless; first perp dex only

### `hl_public_clearinghouse_state`  (public, read-only)

A public address's perp positions + margin summary. Any public 0x address works; do NOT pass an agent wallet (returns empty).

- **Backing:** POST /info {type:clearinghouseState}
- **Pagination:** none
- **Tier:** core
- **Inputs:**
  - `user_address` (required) — string: 0x 42-char
  - `dex` — string: HIP-3 dex
- **Output:** positions+margin structured; concise = net equity + open positions
- **Quirks to normalize:** keyless

### `hd_fills_search`  (fills, read-only)

Unified perp/spot fills feed. scope=recent (24h cached, fast) or all; optional user_address scopes to one account; optional coin + time window. Cursor format epoch_ms:tid.

- **Backing:** GET /fills/, /fills/recent, /fills/user/{addr}, /fills/spot/, /fills/spot/user/{addr}
- **Pagination:** perp=cursor, spot=offset (handled transparently)
- **Tier:** core
- **Inputs:**
  - `market` — enum perp|spot: default perp
  - `scope` — enum recent|all: default recent
  - `user_address` — string: scope to account
  - `coin` — string
  - `start_time` — string: ISO
  - `end_time` — string: ISO
  - `limit` — number: <=1000
  - `cursor` — string
  - `response_format` — enum
- **Output:** fills array + pagination handle
- **Quirks to normalize:** spot total_count=page-size corrected to has_more; tid up to 1e15

### `hd_fills_count`  (fills, read-only)

Aggregate fill count for the current window. data is an object (not array); execution_time_ms is null upstream.

- **Backing:** GET /fills/count
- **Pagination:** none
- **Tier:** core
- **Inputs:**
  - `coin` — string
- **Output:** count object structured
- **Quirks to normalize:** object data; null exec time dropped

### `hd_market_snapshot_24h`  (markets, read-only)

One-call market pulse: 24h total fees, trading volume, total fills, active traders, and top traders. Replaces 5 separate slow overview calls; results are cached server-side.

- **Backing:** GET /overview/total-fees-24h + trading-volume-24h + total-fills-24h + active-traders-24h + top-traders-24h
- **Pagination:** none
- **Tier:** core
- **Inputs:**
  - `top_traders_limit` — number: how many top traders (default 10)
  - `top_traders_sort` — enum volume|pnl|trades
  - `response_format` — enum
- **Output:** single snapshot object structured; concise text summary
- **Quirks to normalize:** upstream calls slow (2-8s) -> issued in parallel; sort=bogus silent-fallback guarded by enum

### `hd_market_daily_series`  (markets, read-only)

Last-10-day daily series of trading volume or PnL-by-coin. PnL series is global-only; volume accepts an optional user filter.

- **Backing:** GET /overview/daily-volume-10d | /overview/daily-pnl-10d
- **Pagination:** none-list
- **Tier:** core
- **Inputs:**
  - `series` (required) — enum volume|pnl
  - `user_address` — string: volume only
- **Output:** daily points structured
- **Quirks to normalize:** user ignored for pnl (rejected at input with steer)

### `hd_user_coin_distribution`  (markets, read-only)

A user's volume distribution across coins. Requires user_address; an unknown address returns an empty distribution (200, not an error).

- **Backing:** GET /overview/coin-distribution
- **Pagination:** none-list
- **Tier:** standard
- **Inputs:**
  - `user_address` (required) — string: 0x
- **Output:** per-coin distribution structured
- **Quirks to normalize:** empty-on-bad-addr noted in output meta

### `hd_analytics_fills_stats`  (analytics, read-only)

Fill statistics over a lookback in hours (max 168), optionally for one coin.

- **Backing:** GET /analytics/fills/stats
- **Pagination:** none
- **Tier:** standard
- **Inputs:**
  - `hours` — number: <=168
  - `coin` — string: echoed back
- **Output:** stats object structured
- **Quirks to normalize:** hours cap enforced pre-flight

### `hd_analytics_priority_fees`  (analytics, read-only)

Priority-fee analytics in one tool: view=stats (aggregate, hours<=168), chart (daily series, ~29d default), or leaderboard (gossip; address field is an IPv4 node IP, surfaced as node_ip).

- **Backing:** GET /analytics/priority-fees/stats | /chart/daily | /gossip/leaderboard
- **Pagination:** none / none-list
- **Tier:** standard
- **Inputs:**
  - `view` (required) — enum stats|chart|leaderboard
  - `hours` — number: stats only, <=168
  - `start_time` — string: chart, ISO
  - `end_time` — string: chart
  - `limit` — number: leaderboard <=200
- **Output:** shape per view structured
- **Quirks to normalize:** gossip address->node_ip rename

### `hd_analytics_liquidations_stats`  (analytics, read-only)

Liquidation statistics over a lookback in days (max 30), optional coin filter.

- **Backing:** GET /analytics/liquidations/stats
- **Pagination:** none
- **Tier:** standard
- **Inputs:**
  - `days` — number: <=30
  - `coin` — string
- **Output:** stats structured
- **Quirks to normalize:** top_token_liquidated ignores coin filter (documented in meta.warning)

### `hd_user_profile`  (traders, read-only)

A single account's profile. view=overview (positions/activity; last_activity 1970 sentinel -> null; total_priority_gas always 0 dropped) or performance (win rate, pnl; note avg_holding_time_s runs high upstream).

- **Backing:** GET /users/{user}/overview | /performance
- **Pagination:** none
- **Tier:** core
- **Inputs:**
  - `user_address` (required) — string: 0x
  - `view` — enum overview|performance: default overview
  - `start_time` — string: ISO
  - `end_time` — string
- **Output:** profile object structured
- **Quirks to normalize:** bad addr -> zeroed 200 flagged in meta; 1970 nullified; gas:0 dropped

### `hd_user_coins`  (traders, read-only)

Per-coin breakdown for one user over a time window.

- **Backing:** GET /users/{user}/coins
- **Pagination:** offset (100)
- **Tier:** standard
- **Inputs:**
  - `user_address` (required) — string
  - `start_time` — string
  - `end_time` — string
  - `limit` — number: <=100
  - `offset` — number
- **Output:** coin rows + pagination handle

### `hd_traders_leaderboard`  (traders, read-only)

Trader leaderboard ranked by a chosen metric. by is required and validated (bogus is a hard 422 upstream, so caught at input).

- **Backing:** GET /users/leaderboard
- **Pagination:** none-list
- **Tier:** core
- **Inputs:**
  - `by` (required) — enum volume|pnl|trades|priority_fees
  - `hours` — number: <=168
  - `limit` — number: <=100
- **Output:** ranked rows (shape varies by `by`) structured
- **Quirks to normalize:** polymorphic on by

### `hd_traders_active`  (traders, read-only)

Currently/recently active traders over a lookback.

- **Backing:** GET /users/active
- **Pagination:** offset (100)
- **Tier:** standard
- **Inputs:**
  - `hours` — number: <=168
  - `limit` — number: <=100
  - `offset` — number
- **Output:** rows + pagination handle

### `hd_completed_trades_search`  (traders, read-only)

Completed (round-trip) trades with optional user/coin/time filters; set summarize=true to get the aggregate summary instead of rows. SDK caps limit at 100 because the endpoint has NO server cap (a 70MB-response risk).

- **Backing:** GET /completed-trades/ | /completed-trades/summary
- **Pagination:** offset (SDK-capped 100)
- **Tier:** core
- **Inputs:**
  - `user_address` — string
  - `coin` — string
  - `direction` — enum long|short
  - `sort_by` — enum pnl|time|duration
  - `start_time` — string
  - `end_time` — string
  - `summarize` — boolean: return aggregate
  - `limit` — number: <=100 SDK cap
  - `offset` — number
- **Output:** rows + handle, or summary object
- **Quirks to normalize:** sort_by bogus guarded; avg_pnl_pct is % units; avg_duration_s inflated -> noted; null exec time dropped

### `hd_completed_trade_fills`  (traders, read-only)

The constituent fills of one completed trade. trade_id contains a colon and is URL-encoded for you. Unknown id returns empty (not 404).

- **Backing:** GET /completed-trades/{trade_id}/fills
- **Pagination:** none-list
- **Tier:** standard
- **Inputs:**
  - `trade_id` (required) — string: composite id incl colon
- **Output:** fills structured
- **Quirks to normalize:** shifted keys feeUsdc/typeTrade dropped

### `hd_liquidations_search`  (liquidations, read-only)

Liquidation events feed. scope=recent (24h cached) or all; filter by coin/user/time/amount. Order desc only: asc cursors are corrupt upstream so asc pagination is refused with a clear message.

- **Backing:** GET /liquidations/ | /liquidations/recent
- **Pagination:** cursor (100)
- **Tier:** core
- **Inputs:**
  - `scope` — enum recent|all: default recent
  - `coin` — string
  - `user_address` — string
  - `min_notional` — number
  - `start_time` — string
  - `end_time` — string
  - `limit` — number: <=100
  - `cursor` — string
- **Output:** events + cursor handle
- **Quirks to normalize:** asc cursor refused; bogus cursor->first-page guarded

### `hd_hip3_overview`  (hip3, read-only)

HIP-3 ecosystem overview (bare envelope). auction_end_at is Z-suffixed (normalized to UTC).

- **Backing:** GET /hip3/overview
- **Pagination:** none
- **Tier:** standard
- **Output:** overview object structured
- **Quirks to normalize:** Z-suffix normalized

### `hd_hip3_dexs`  (hip3, read-only)

List HIP-3 dexes, or one dex's detail when dex_id is given.

- **Backing:** GET /hip3/dexs | /hip3/dexs/{dex_id}
- **Pagination:** offset (500)
- **Tier:** standard
- **Inputs:**
  - `dex_id` — string: detail mode
  - `limit` — number: <=500
  - `offset` — number
- **Output:** list+handle or single
- **Quirks to normalize:** 404 detail string -> NotFound

### `hd_hip3_assets`  (hip3, read-only)

List HIP-3 assets, or one asset by ticker (dex-prefixed). Note asset_id is always 0 upstream, so don't filter by it.

- **Backing:** GET /hip3/assets | /hip3/assets/{ticker}
- **Pagination:** offset (1000)
- **Tier:** standard
- **Inputs:**
  - `ticker` — string: detail mode, dex-prefixed
  - `limit` — number: <=1000
  - `offset` — number
- **Output:** list+handle or single
- **Quirks to normalize:** asset_id always 0 (dropped)

### `hd_hip3_auctions`  (hip3, read-only)

HIP-3 auctions: view=live (open), current (the single active one), or history. Note auction_id is an int on live but a string on history (normalized to string everywhere); expired history rows have empty strings.

- **Backing:** GET /hip3/auctions | /auctions/current | /auctions/history
- **Pagination:** offset (current=none)
- **Tier:** standard
- **Inputs:**
  - `view` — enum live|current|history: default live
  - `limit` — number: live<=200, history<=500
  - `offset` — number
- **Output:** per-view structured + handle
- **Quirks to normalize:** auction_id type unified to string; empty-string fields nullified

### `hd_hip3_snapshots`  (hip3, read-only)

HIP-3 market snapshots; view=all or top_movers (same shape, capped 100).

- **Backing:** GET /hip3/snapshots | /hip3/top-movers
- **Pagination:** none-list
- **Tier:** standard
- **Inputs:**
  - `view` — enum all|top_movers: default all
  - `limit` — number: top_movers<=100
- **Output:** snapshot rows structured

### `hd_hip3_ohlcv`  (hip3, read-only)

HIP-3 OHLCV for one coin (default ~168 rows, max 2000). Accepts ISO or epoch times. volume and fees are always 0 upstream (dropped to avoid misleading the agent).

- **Backing:** GET /hip3/ohlcv
- **Pagination:** offset (2000)
- **Tier:** standard
- **Inputs:**
  - `coin` (required) — string
  - `start` — string: ISO or epoch
  - `end` — string
  - `limit` — number: <=2000
  - `offset` — number
- **Output:** OHLC rows + handle
- **Quirks to normalize:** volume/fees=0 dropped

### `hd_hip3_oracle_stats`  (hip3, read-only)

Oracle price stats for a HIP-3 dex (required dex_id). asset_id filter is useless (always 0) so it is not exposed.

- **Backing:** GET /hip3/oracle/stats
- **Pagination:** offset (10000)
- **Tier:** advanced
- **Inputs:**
  - `dex_id` (required) — string
  - `start` — string
  - `end` — string
  - `limit` — number: <=10000
  - `offset` — number
- **Output:** oracle rows + handle

### `hd_hip3_fills`  (hip3, read-only)

HIP-3 fills feed. tid here is a plain int (no epoch:tid cursor format).

- **Backing:** GET /hip3/fills
- **Pagination:** offset
- **Tier:** standard
- **Inputs:**
  - `coin` — string
  - `start` — string
  - `end` — string
  - `limit` — number
  - `offset` — number
- **Output:** fills + handle
- **Quirks to normalize:** plain-int tid

### `hd_hip3_traders`  (hip3, read-only)

HIP-3 trader stats; view=stats (paged) or leaderboard (ranked by `by`, bogus silently falls back so by is enum-guarded).

- **Backing:** GET /hip3/stats/traders | /hip3/leaderboard
- **Pagination:** offset / none-list
- **Tier:** standard
- **Inputs:**
  - `view` — enum stats|leaderboard: default stats
  - `by` — enum volume|pnl|trades: leaderboard
  - `limit` — number: stats<=500, leaderboard<=200
  - `offset` — number
- **Output:** rows + handle
- **Quirks to normalize:** by enum-guarded

### `hd_hip3_user`  (hip3, read-only)

One address inside HIP-3: view=overview, fills, or coins.

- **Backing:** GET /hip3/users/{address}/overview | /fills | /coins
- **Pagination:** offset (fills), none/none-list
- **Tier:** standard
- **Inputs:**
  - `address` (required) — string: 0x
  - `view` — enum overview|fills|coins: default overview
  - `start` — string: fills
  - `end` — string
  - `limit` — number: coins<=100
  - `offset` — number
- **Output:** per-view structured

### `hd_hip3_gossip`  (hip3, read-only)

HIP-3 priority-fee gossip; view=status (live; winner is an IPv4 surfaced as winner_node_ip) or history (slots 0-4 only; duplicate snapshot rows are de-duplicated).

- **Backing:** GET /hip3/priority-fees/gossip/status | /history
- **Pagination:** none / offset
- **Tier:** advanced
- **Inputs:**
  - `view` — enum status|history: default status
  - `start_time` — string: history
  - `end_time` — string
  - `limit` — number
  - `offset` — number
- **Output:** status object or deduped history + handle
- **Quirks to normalize:** winner->winner_node_ip; history deduped; slot>4 rejected

### `hd_hip4_markets`  (hip4, read-only)

HIP-4 prediction markets/outcomes (the two endpoints are aliases). Filter by underlying/class/outcome_id. The coin= filter is silently ignored upstream so it is not exposed; use outcome_id.

- **Backing:** GET /hip4/markets (== /hip4/outcomes)
- **Pagination:** offset (1000)
- **Tier:** standard
- **Inputs:**
  - `underlying` — string: e.g. BTC
  - `class` — string: e.g. priceBinary
  - `outcome_id` — number
  - `limit` — number: <=1000
  - `offset` — number
- **Output:** markets + handle; pipe-delimited description parsed into fields; per-market attribution (`venue`, `deployer`, `deployer_fee_scale`)
- **Quirks to normalize:** Hip4 envelope; coin filter omitted; oracle-run rows carry an empty venue/deployer

### `hd_hip4_providers`  (hip4, read-only)

Per-provider HIP-4 trading stats: one row per venue with volume_usdc, fills, unique_users, markets_traded, fees, last_trade. Permissionless venues appear as soon as they trade; oracle-run markets are aggregated under the provider "oracle", so totals span the whole history.

- **Backing:** GET /hip4/providers
- **Pagination:** offset (1000)
- **Tier:** standard
- **Inputs:**
  - `venue` - string: venue name or "oracle"
  - `start_time` - string: ISO or epoch-ms, sent as full ISO
  - `end_time` - string
  - `limit` - number: <=1000
  - `offset` - number
- **Output:** provider stats + handle
- **Quirks to normalize:** Hip4 envelope; a time window recomputes the aggregates over that window only

### `hd_hip4_deployers`  (hip4, read-only)

The permissionless deployer registry: deployer address, venue, fee_scale and the delegation list (who may register questions/outcomes or settle per venue).

- **Backing:** GET /hip4/deployers
- **Pagination:** offset (1000)
- **Tier:** standard
- **Inputs:**
  - `venue` - string
  - `limit` - number: <=1000
  - `offset` - number
- **Output:** registry rows + decoded `delegations` + handle
- **Quirks to normalize:** `sub_deployers` arrives as a JSON string, decoded into `delegations` (raw string preserved)

### `hd_hip4_questions`  (hip4, read-only)

HIP-4 questions. The description field is pipe-delimited and is parsed into structured key/values for you.

- **Backing:** GET /hip4/questions
- **Pagination:** offset (1000)
- **Tier:** standard
- **Inputs:**
  - `question_id` — number
  - `limit` — number: <=1000
  - `offset` — number
- **Output:** questions + parsed description + handle
- **Quirks to normalize:** pipe parser

### `hd_hip4_outcome_tokens`  (hip4, read-only)

HIP-4 outcome tokens; coin=@N filter works here.

- **Backing:** GET /hip4/outcome-tokens
- **Pagination:** offset (1000)
- **Tier:** standard
- **Inputs:**
  - `outcome_id` — number
  - `coin` — string: @index
  - `limit` — number: <=1000
  - `offset` — number
- **Output:** tokens + handle

### `hd_hip4_fills`  (hip4, read-only)

HIP-4 fills; time params ISO (incl trailing Z), time_ms is epoch. feeToken is 'USDH' or a '+NNN' token code.

- **Backing:** GET /hip4/fills
- **Pagination:** offset (1000)
- **Tier:** standard
- **Inputs:**
  - `outcome_id` - number
  - `user` - string: trader address
  - `coin` - string: e.g. #12100
  - `start` - string: ISO
  - `end` - string
  - `limit` - number: <=1000
  - `offset` - number
- **Output:** fills + handle; each row attributed with `market_name`, `market_description`, `venue`, `deployer`

### `hd_hip4_fees`  (hip4, read-only)

HIP-4 daily fees; date is YYYY-MM-DD.

- **Backing:** GET /hip4/fees
- **Pagination:** offset (1000)
- **Tier:** standard
- **Inputs:**
  - `start` — string
  - `end` — string
  - `limit` — number: <=1000
  - `offset` — number
- **Output:** fee rows + handle

### `hd_hip4_settlements`  (hip4, read-only)

HIP-4 settlements; duplicate rows (same outcome_id+nonce) are de-duplicated for you.

- **Backing:** GET /hip4/settlements
- **Pagination:** offset (1000)
- **Tier:** standard
- **Inputs:**
  - `outcome_id` — number
  - `start` — string
  - `end` — string
  - `limit` — number: <=1000
  - `offset` — number
- **Output:** deduped settlements + handle
- **Quirks to normalize:** dedupe(outcome_id,nonce)

### `hd_hip4_analytics`  (hip4, read-only)

HIP-4 analytics over outcomes/time; coin accepts an int CSV (e.g. 290,291) normalized for you.

- **Backing:** GET /hip4/analytics
- **Pagination:** offset (2000)
- **Tier:** standard
- **Inputs:**
  - `coin` — string: int CSV
  - `outcome_id` — number
  - `interval` — enum 1h|4h|1d
  - `start` — string
  - `end` — string
  - `limit` — number: <=2000
  - `offset` — number
- **Output:** analytics rows + handle
- **Quirks to normalize:** interval bogus guarded

### `hd_hip4_preview`  (hip4, read-only)

Not-yet-live HIP-4 surfaces: resource=fee_scales or user_actions. Both currently return status not_yet_live; this is surfaced as a structured status (not an error) so the agent stops retrying.

- **Backing:** GET /hip4/fee-scales | /hip4/user-actions
- **Pagination:** none-list / offset
- **Tier:** advanced
- **Inputs:**
  - `resource` (required) — enum fee_scales|user_actions
  - `limit` — number
  - `offset` — number
- **Output:** status:not_yet_live + testnet_docs link
- **Quirks to normalize:** not_yet_live surfaced; validation bypassed upstream

### `hd_builders`  (builders, read-only)

Builder codes directory; view=top (ranked, sort guarded) or list (full ~640 builders in one call).

- **Backing:** GET /builders/top | /builders/list
- **Pagination:** offset (top) / none-list
- **Tier:** standard
- **Inputs:**
  - `view` — enum top|list: default top
  - `sort` — enum volume|fees|users: top only
  - `limit` — number: top<=100
  - `offset` — number
- **Output:** rows (+handle for top)
- **Quirks to normalize:** sort bogus guarded

### `hd_builder_stats`  (builders, read-only)

Builder stats: global (optionally all timeframes) or for one builder address. Unknown address returns 200 with builderName null.

- **Backing:** GET /builders/stats | /stats/all-timeframes | /builders/{addr}/stats
- **Pagination:** none
- **Tier:** standard
- **Inputs:**
  - `address` — string: per-builder mode
  - `all_timeframes` — boolean: global only
- **Output:** stats object structured
- **Quirks to normalize:** variations.*Pct may be null (kept)

### `hd_builder_users`  (builders, read-only)

Users attributed to a builder address.

- **Backing:** GET /builders/{addr}/users
- **Pagination:** offset
- **Tier:** standard
- **Inputs:**
  - `address` (required) — string
  - `limit` — number
  - `offset` — number
- **Output:** users + handle

### `hd_twaps_search`  (twaps, read-only)

TWAP orders, optionally scoped to one user. startTime can be a 1970 sentinel (nulled); status enum is incomplete upstream and may carry an 'error:' prefix (surfaced verbatim in raw_status).

- **Backing:** GET /twaps/ | /twaps/user/{addr}
- **Pagination:** offset
- **Tier:** standard
- **Inputs:**
  - `user_address` — string: scope to user
  - `coin` — string
  - `limit` — number: <=500 (user<=200)
  - `offset` — number
- **Output:** twaps + handle; user view adds executionPct
- **Quirks to normalize:** 1970 nulled; error-prefixed status preserved as raw_status

### `hd_twaps_stats`  (twaps, read-only)

Aggregate TWAP stats. byStatus may expose the same error-prefixed status strings.

- **Backing:** GET /twaps/stats
- **Pagination:** none
- **Tier:** standard
- **Inputs:**
  - `hours` — number
- **Output:** stats structured
- **Quirks to normalize:** error-prefix statuses noted

### `hd_twap_detail`  (twaps, read-only)

One TWAP by id (composite shape); set include_fills to also return its fills. Unknown id -> 404.

- **Backing:** GET /twaps/{id} (+ /{id}/fills)
- **Pagination:** offset (fills)
- **Tier:** standard
- **Inputs:**
  - `twap_id` (required) — string
  - `include_fills` — boolean
  - `limit` — number: fills<=1000
  - `offset` — number
- **Output:** twap object (+fills+handle)
- **Quirks to normalize:** 404 detail string; fills hash all-zero kept

### `hd_funding_predicted`  (funding, read-only)

Predicted funding rates across ~230 coins (bare array; rate/premium are string-encoded; ~47 are zero-rate).

- **Backing:** GET /funding/predictedFundings
- **Pagination:** none-list
- **Tier:** standard
- **Output:** rows structured; concise = extremes
- **Quirks to normalize:** bare here, but /info wraps it (handled)

### `hd_funding_history`  (funding, read-only)

Funding-rate history for one coin (time-window paginated, 5000 cap). Times are epoch-ms (startTime/endTime).

- **Backing:** GET /funding/fundingHistory
- **Pagination:** time-window (5000)
- **Tier:** standard
- **Inputs:**
  - `coin` (required) — string
  - `start_time` — string: ISO or epoch
  - `end_time` — string
  - `limit` — number: <=5000
- **Output:** rows + next_end_time handle
- **Quirks to normalize:** string-encoded rates

### `hd_user_funding`  (funding, read-only)

A user's funding payments (time-window, epoch-ms). Empty for every tested user upstream; shape is best-effort and meta flags it as unverified.

- **Backing:** GET /funding/userFunding
- **Pagination:** time-window (5000)
- **Tier:** standard
- **Inputs:**
  - `user_address` (required) — string
  - `start_time` — string
  - `end_time` — string
- **Output:** rows + handle
- **Quirks to normalize:** often empty; meta.unverified=true

### `hd_vaults_list`  (vaults, read-only)

Vault summaries, default sorted by followerCount desc; include_closed adds wound-down vaults.

- **Backing:** GET /vaults/vaultSummaries
- **Pagination:** offset (5000)
- **Tier:** standard
- **Inputs:**
  - `include_closed` — boolean
  - `limit` — number: <=5000
  - `offset` — number
- **Output:** vaults + handle
- **Quirks to normalize:** bare here, /info wraps as vaultList (handled)

### `hd_vault_details`  (vaults, read-only)

One vault's details (requires vaultAddress; zero-address -> 404). The portfolio[] field is renamed leaderCommissionHistory for clarity.

- **Backing:** GET /vaults/vaultDetails
- **Pagination:** none
- **Tier:** standard
- **Inputs:**
  - `vault_address` (required) — string: 0x
- **Output:** vault object structured
- **Quirks to normalize:** portfolio->leaderCommissionHistory

### `hd_vault_snapshots`  (vaults, read-only)

Time-series for one vault: granularity=daily (adds day field), equity (higher-frequency), or ledger (deposits/withdrawals; SDK synthesizes kind=deposit|withdraw). All time-window paginated.

- **Backing:** GET /vaults/dailySnapshots | /equitySnapshots | /vaultLedger
- **Pagination:** time-window (5000)
- **Tier:** standard
- **Inputs:**
  - `vault_address` (required) — string
  - `granularity` — enum daily|equity|ledger: default daily
  - `start_time` — string
  - `end_time` — string
- **Output:** series + next_end_time handle
- **Quirks to normalize:** ledger kind synthesized

### `hd_user_vault_equities`  (vaults, read-only)

A user's equity across vaults (time-window). Empty for tested users; meta flags unverified shape.

- **Backing:** GET /vaults/userVaultEquities
- **Pagination:** time-window
- **Tier:** standard
- **Inputs:**
  - `user_address` (required) — string
  - `start_time` — string
  - `end_time` — string
- **Output:** rows + handle
- **Quirks to normalize:** often empty; meta.unverified

### `hd_evm_stats`  (evm, read-only)

HyperEVM chain stats; view=current (instant) or daily (series, max 365 days).

- **Backing:** GET /evm/stats | /evm/stats/daily
- **Pagination:** none / none-list
- **Tier:** standard
- **Inputs:**
  - `view` — enum current|daily: default current
  - `days` — number: daily, <=365
- **Output:** stats / series structured

### `hd_evm_blocks`  (evm, read-only)

HyperEVM blocks: a range (start_block/end_block inclusive, or time window), one block by number, or include_transactions for that block's txs.

- **Backing:** GET /evm/blocks | /evm/blocks/{n} | /evm/blocks/{n}/transactions
- **Pagination:** offset (1000)
- **Tier:** standard
- **Inputs:**
  - `block_number` — number: detail mode
  - `include_transactions` — boolean: with block_number
  - `start_block` — number
  - `end_block` — number
  - `start_time` — string
  - `end_time` — string
  - `limit` — number: <=1000
  - `offset` — number
- **Output:** blocks/txs + handle or single
- **Quirks to normalize:** 404 detail string on unknown block

### `hd_evm_transactions`  (evm, read-only)

HyperEVM transactions with optional address/time filters (ISO times only; epoch-ms is silently ignored upstream so input coerces to ISO). Empty tx_hash/from_addr fields are nulled.

- **Backing:** GET /evm/transactions
- **Pagination:** offset (1000)
- **Tier:** standard
- **Inputs:**
  - `address` — string
  - `start_time` — string: ISO
  - `end_time` — string
  - `limit` — number: <=1000
  - `offset` — number
- **Output:** txs + handle
- **Quirks to normalize:** epoch coerced to ISO; empty strings nulled

### `hd_evm_logs`  (evm, read-only)

HyperEVM event logs by address/topic/time. Absent topics come back as empty strings (nulled).

- **Backing:** GET /evm/logs
- **Pagination:** offset (1000)
- **Tier:** advanced
- **Inputs:**
  - `address` — string
  - `topic` — string
  - `start_time` — string
  - `end_time` — string
  - `limit` — number: <=1000
  - `offset` — number
- **Output:** logs + handle
- **Quirks to normalize:** empty topics nulled

### `hd_evm_transfers`  (evm, read-only)

HyperEVM ledger transfers. action_type is enum-guarded (bogus returns silent-empty upstream); block_height is always 0 (dropped).

- **Backing:** GET /evm/ledger/transfers
- **Pagination:** offset (1000)
- **Tier:** standard
- **Inputs:**
  - `action_type` — enum (validated set)
  - `address` — string
  - `start_time` — string
  - `end_time` — string
  - `limit` — number: <=1000
  - `offset` — number
- **Output:** transfers + handle
- **Quirks to normalize:** action_type guarded; block_height:0 dropped

### `hd_evm_bridge_events`  (evm, read-only)

HyperEVM bridge events. event_type enum-guarded (bogus -> silent empty); nonce can exceed int53 (kept as string).

- **Backing:** GET /evm/bridge/events
- **Pagination:** offset (1000)
- **Tier:** standard
- **Inputs:**
  - `event_type` — enum (validated set)
  - `start_time` — string
  - `end_time` — string
  - `limit` — number: <=1000
  - `offset` — number
- **Output:** events + handle
- **Quirks to normalize:** nonce as string for int53-safety

### `hd_evm_user`  (evm, read-only)

One EVM address: view=ledger_events (strict event_type enum, multi-value supported) or ledger_summary.

- **Backing:** GET /evm/user/{address}/ledger-events | /ledger-summary
- **Pagination:** offset (1000) / none-list
- **Tier:** standard
- **Inputs:**
  - `address` (required) — string
  - `view` — enum ledger_events|ledger_summary: default ledger_events
  - `event_type` — string|string[]: events view, enum-enforced
  - `start_time` — string
  - `end_time` — string
  - `limit` — number: <=1000
  - `offset` — number
- **Output:** events+handle or summary
- **Quirks to normalize:** strict enum

### `hd_evm_hip3_backstop`  (evm, read-only)

HIP-3 backstop on HyperEVM: view=transfers, transfers_summary, health (6 active dexes), dex_health (one dex; 404 on unknown), or dex_fills (unknown dex -> empty, not 404). Most transfer data is currently empty.

- **Backing:** GET /evm/hip3/backstop/transfers|transfers-summary|health|{dex}/health|{dex}/fills
- **Pagination:** offset / none-list / none
- **Tier:** advanced
- **Inputs:**
  - `view` — enum transfers|transfers_summary|health|dex_health|dex_fills: default health
  - `dex` — string: required for dex_health/dex_fills
  - `start_time` — string
  - `end_time` — string
  - `limit` — number: <=1000
  - `offset` — number
- **Output:** per-view structured + handle
- **Quirks to normalize:** dex_fills empty-on-unknown noted; transfers often empty

### `hd_info_raw`  (info, read-only)

Escape hatch: call the HypeDexer POST /info discriminated dispatcher directly with a type + params, for any /info type not covered by a dedicated tool. Returns the same envelope as the backing REST handler (currentFundingRates and vaultList are auto-unwrapped). Prefer the dedicated tools; this is for advanced/forward-compat use.

- **Backing:** POST /info
- **Pagination:** varies
- **Tier:** advanced
- **Inputs:**
  - `type` (required) — string: info discriminator, e.g. allMids
  - `params` — object: type-specific params
- **Output:** normalized envelope structured
- **Quirks to normalize:** 400 {error} and 422 {detail} mapped; two wrap-mismatch types unwrapped


---

## Tool-design principles (Anthropic guidance, applied)

- Build for agent affordances, not API parity. The most common failure is tools that merely wrap an existing API endpoint regardless of whether it suits an agent. Instead build a few thoughtful, high-impact tools that target specific workflows and let an agent subdivide a task the way a human would with the same underlying resources. (anthropic.com/engineering/writing-tools-for-agents)
- Consolidate over sprawl. Replace many low-level primitives with workflow tools that handle multiple operations under the hood: a single schedule_event that finds availability AND books beats separate list_users + list_events + create_event; a search_logs that returns only relevant lines + surrounding context beats a raw read_logs. 'More tools don't always lead to better outcomes' and overlapping tools distract the agent from efficient strategies. (writing-tools-for-agents)
- Return high-signal context, not raw dumps. 'Optimizing the quality of context is important. But so is optimizing the quantity.' Tools should prioritize contextual relevance over flexibility and strip low-value technical noise (uuid, 256px_image_url, mime_type) the agent will never act on. (writing-tools-for-agents)
- Use natural-language identifiers, not cryptic ones. 'Agents grapple with natural language names, terms, or identifiers significantly more successfully than cryptic identifiers.' Prefer name/image_url/file_type over uuid/mime_type. When a downstream call genuinely needs an opaque ID (search_user(name) -> send_message(id)), surface it via a detailed mode rather than always.
- Tools are a new contract: deterministic systems consumed by non-deterministic agents. Account for the agent hallucinating, misreading purpose, or calling wrong. Enforce expectations with strict data models and clear input/output schemas rather than assuming correct usage. (writing-tools-for-agents)
- Keep intermediate data out of the model entirely when possible. With code-execution/MCP, intermediate results stay in the execution environment by default; the agent only sees what you explicitly log or return. A 150,000-token Drive->Salesforce transcript workflow dropped to ~2,000 tokens (98.7% reduction) this way, and sensitive data (emails, phones, names) can flow tool-to-tool without ever passing through the model context. (anthropic.com/engineering/code-execution-with-mcp)
- Make implicit knowledge explicit. Write the tool as if onboarding a new hire: spell out specialized query formats, niche terminology, and relationships between underlying resources that you would otherwise bring implicitly. (writing-tools-for-agents)

**Naming:** "Names are load-bearing context, not cosmetics: every word in a tool's name, description, and params shapes how the agent picks and uses it. Use clear, distinct names so the agent never has to disambiguate between near-duplicates. Namespace related tools under common prefixes (or suffixes) to delineate boundaries when there are many: asana_search, jira_search, and finer-grained asana_projects_search / asana_users_search. Anthropic found that choosing prefix- vs suffix-based namespacing has 'non-trivial effects on tool-use evaluations,' so pick the scheme empirically via your own evals rather than by taste. Parameter names must be unambiguous: prefer user_id over user, file_type over mime_type. (writing-tools-for-agents). On the MCP spec side, treat handles/IDs you hand back as opaque names, not capabilities: validate the caller's authorization against the handle on every call, and prefer opaque handles that don't invite the model to parse or guess internal structure. (modelcontextprotocol.io/specification/draft/server/tools)"

**Descriptions:** "Prompt-engineering the description and parameter docs is one of the single highest-leverage levers because the spec is loaded directly into the agent's context and collectively steers tool-calling behavior. Even small refinements 'yield dramatic improvements' (Anthropic cites precise description refinements on SWE-bench that sharply cut error rates and raised completion). Write to a new-hire standard: define niche terms, give the exact expected query format, show an example of a correctly formatted input, and state relationships between resources. Enforce the contract with strict schemas so ambiguity is impossible. With FastMCP/SDK frameworks, tools are plain typed functions with clear docstrings and the framework infers the JSON Schema + description, so the docstring quality directly becomes the agent-facing contract. (writing-tools-for-agents; modelcontextprotocol.info/docs/best-practices)"

**Response format:** "There is no one-size-fits-all: 'Even your tool response structure - XML, JSON, or Markdown - can have an impact on evaluation performance.' Test it per tool rather than standardizing blindly. Give the agent control over verbosity via a response_format enum (e.g. 'concise' | 'detailed'): in Anthropic's example a detailed response was 206 tokens vs 72 concise (~1/3), where concise omits IDs and detailed includes the identifiers needed to chain a follow-up call. Return only high-signal fields; drop uuid/mime_type-style noise. When a workflow would otherwise route a large blob through the model just to hand it to the next tool, prefer returning a handle/reference (or doing the join in code execution) over the full blob, and let only the filtered/aggregated result surface (e.g. 5 pending rows logged out of a 10,000-row sheet). Use semantic identifiers in the payload so the model reasons over names, not cryptic codes. (writing-tools-for-agents; code-execution-with-mcp)"

**Pagination:** "Any response that could blow up context should ship with sensible defaults for SOME combination of pagination, range selection, filtering, and truncation. The key anti-loop technique is to truncate WITH steering: a truncated response must tell the agent what to do next - e.g. instruct it to make many small, targeted searches instead of one broad search, or to apply a filter/narrower query - so it converges rather than re-issuing the same broad call. Claude Code caps tool responses at 25,000 tokens by default. Expose filtering as first-class parameters (so the agent narrows server-side instead of paging endlessly), and have error/truncation messages model the correct next move. For very high-fanout cases, push filtering/aggregation into a code-execution step so a 10,000-row result is reduced to the handful of relevant rows before anything reaches the model. (writing-tools-for-agents; code-execution-with-mcp)"

**Token efficiency:** "Two axes: quantity of definitions loaded, and quantity returned. (1) Returned tokens: return only high-signal fields, offer concise/detailed response_format modes, default to pagination/truncation with 25k-token-style caps, and encourage many small targeted searches over one broad search. (2) Definition tokens: loading every tool definition upfront is the dominant hidden cost - 'in cases where agents are connected to thousands of tools, they'll need to process hundreds of thousands of tokens before reading a request.' The fix is progressive disclosure: present tools as code files on a filesystem the model reads on demand (a definition on disk 'takes up no tokens at all'), or add a search_tools function returning definitions by name at varying detail (name only / name+description / full schema). Combined with keeping intermediate results in the execution environment, Anthropic reports a 150,000 -> ~2,000 token (98.7%) reduction on a real Drive->Salesforce workflow. (code-execution-with-mcp; simonwillison.net/2025/Nov/4/code-execution-with-mcp)"

**Error messaging:** "Prompt-engineer error responses to communicate specific, actionable fixes rather than opaque codes or tracebacks. 'Exception: Invalid parameters' is the anti-pattern; the recovery-steering version states the expected format and gives a concrete example of a correctly formatted input, or points the agent toward a more token-efficient behavior (apply this filter, use pagination, narrow the query). Treat errors as another steering surface in context: a good error both fixes the immediate mistake and nudges the agent toward the efficient strategy you want next time. (writing-tools-for-agents)"

**Tool count:** "'More tools don't always lead to better outcomes' - too many or overlapping tools distract the agent and bloat context. Anthropic doesn't publish a hard number, but the guidance is to consolidate down to a few high-impact workflow tools rather than mirror every endpoint. Beyond a few dozen tools, the loaded-definitions cost dominates (thousands of tools = hundreds of thousands of tokens before the first request). The scaling answer is not 'cram more definitions in' but tool filtering / progressive disclosure: load tool definitions on demand from a filesystem, or expose a search_tools / code-execution layer so the agent discovers and wires only the tools a given task needs. This 'code execution with MCP' direction lets agents handle far more tools while using fewer tokens and avoids routing intermediate results through the model. On the server side, keep each MCP server to one clear, well-defined purpose. (writing-tools-for-agents; code-execution-with-mcp; modelcontextprotocol.info/docs/best-practices)"

**Evals:** "Evals are the engine of tool quality - naming, description wording, and response format should all be chosen empirically, not by intuition. Build many evaluation tasks grounded in real-world use; strong tasks may require multiple (potentially dozens of) tool calls and should avoid simplistic sandbox setups. Run them as simple agentic while-loops (alternating LLM call + tool call), one loop per task. Collect more than accuracy: total runtime per call and per task, total number of tool calls, total token consumption, and tool errors - tool-call counts reveal the workflows agents actually pursue. Read the agents' chain-of-thought and raw transcripts (calls + responses) to find rough edges and unspecced behavior. Then close the loop: concatenate the eval transcripts and paste them into Claude Code to let the agent analyze results and optimize the tools itself (Anthropic's Claude-optimized Slack/Asana servers beat the human-written ones on held-out test sets). Use held-out test sets to avoid overfitting your descriptions to the training evals. (writing-tools-for-agents)"
