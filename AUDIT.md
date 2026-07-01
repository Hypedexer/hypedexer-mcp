# HypeDexer MCP Server — Independent Audit Report

*Scope: `@hypedexer/mcp-server` v0.1.0 (pre-release). Read-only Model Context Protocol server for Hyperliquid / HypeDexer data. TypeScript, ESM-only, 83 tools across 17 groups, dual stdio + Streamable-HTTP transport. Assessed against the MCP spec (2025-06-18), Anthropic "Writing tools for agents," and prevailing OSS MCP conventions (mid-2026).*

## 1. Executive summary

HypeDexer MCP is a clean, well-layered, type-strict server that is already better engineered than the median open-source MCP project: it has a disciplined error taxonomy with actionable recovery hints, a uniform pagination contract, a token-budget output shaper, honest read-only annotations, and a genuinely good tool-description style. The dominant weakness is the Streamable-HTTP transport, which the project itself documents as the shape of the intended hosted deployment (`mcp.hypedexer.com`) yet ships with no authentication, no Origin/Host validation, and no session lifecycle management. These are latent rather than active in the default configuration (transport defaults to stdio, bind defaults to loopback, every tool is read-only), so the practical blast radius is data exfiltration and abuse of the operator's upstream API key and quota, not state mutation or fund loss. The codebase is explicitly non-final, and most remaining issues are optimizations, dead code, test-coverage gaps, and packaging polish appropriate to a v0.1.0.

**Overall grade: 6.9 / 10** (solid, production-credible architecture held back by an unhardened HTTP transport and pre-release packaging gaps; none of the gaps are deep design flaws and all are fixable without restructuring).

## 2. Scorecard

| # | Dimension | Score | One-line verdict |
|---|-----------|:----:|------------------|
| 1 | MCP protocol & spec compliance | 7 / 10 | Spec-compliant core and correct text+structuredContent mirroring; missing outputSchema and HTTP-transport security controls the spec recommends. |
| 2 | Tool design vs Anthropic guidance | 8 / 10 | Strong descriptions, namespaced names, pagination and token budget; undercut by a dead `response_format` contract and no concise field-projection. |
| 3 | Security | 5 / 10 | Read-only surface and server-side key are good defaults; HTTP transport has no auth, no Origin/Host check, and a fragile 2-method RPC denylist. |
| 4 | Scalability & performance | 6 / 10 | Reasonable per-call timeouts; unbounded session map and no rate/concurrency caps make the hosted path a DoS amplifier. |
| 5 | Code quality, types & testing | 7.5 / 10 | Strict TS, clean unidirectional layering, helpful unit tests; behavioral handler coverage is thin (1 of 83) and the output shaper is untested. |
| 6 | Reliability & error handling | 7.5 / 10 | Best-in-class actionable error taxonomy; a few mis-steering edge cases (WS pre-open, non-standard 4xx, JSON-RPC codes). |
| 7 | Comparison vs popular OSS MCP servers | 7 / 10 | Tooling depth and DX exceed the reference set; lags on remote auth, npm publish, Docker, and registry metadata. |
| 8 | Packaging, distribution & DX | 7 / 10 | Good tsup/Biome/Vitest setup; honest-floor, publish-safety, CI, and WSL-onboarding gaps remain. |

## 3. Strengths (vs typical OSS MCP servers)

- **Error handling is a standout.** A full `HypedexerError` taxonomy converts every failure (including ZodError) into an `isError:true` result carrying a concrete "Next step" recovery hint, never a traceback. Most reference servers leak raw errors or opaque codes.
- **Honest, enforced-in-practice read-only posture.** `readOnlyHint`/`openWorldHint` are set on all tools, the keyed groups silently drop when no API key is present, and actual read-only enforcement lives in the clients (the RPC client refuses `eth_sendTransaction`/`eth_sendRawTransaction`; HTTP/public clients only read), not solely in advisory annotations.
- **Token-aware output by design.** `buildResult` enforces a configurable ~25k-token budget with halving truncation plus an explicit narrowing note that steers the agent to filter. Few OSS servers implement Anthropic's token-budget guidance at all.
- **Uniform pagination contract** (`{returned, has_more, next_cursor|next_offset|next_end_time, hint}`) across cursor, offset, and time-window strategies.
- **Strict, modern TypeScript and clean architecture.** `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`, unidirectional layering (core -> hypedexer/hyperliquid -> tools -> registry -> server -> transports), and injectable `fetch`/`WebSocket` for testability.
- **Spec-correct content mirroring.** The full serialized JSON is deliberately mirrored into both the text content block and `structuredContent`, exactly as the spec recommends for text-only clients.
- **Good tool-design hygiene:** namespaced tool names, unambiguous parameters, rich "onboarding a new hire" descriptions, and documented upstream quirks surfaced as `notes`.

## 4. Findings by severity

Duplicate findings reported under multiple dimensions are merged; severity reflects the highest justified rating.

### CRITICAL
None. The most serious issues are real but constrained by read-only scope and non-default exposure, so they land at High rather than Critical.

### HIGH

**H1. HTTP transport requires no authentication (open proxy / confused deputy).**
*Why it matters:* The server holds a single operator `HYPEDEXER_API_KEY` server-side and builds a fresh keyed server per anonymous session. Any client that can reach the port and complete an `initialize` handshake gets full keyed-tool access spending the operator's credential, with no per-user consent or audience validation. The file's own docstring states this is the shape the hosted `mcp.hypedexer.com` deployment runs.
*Evidence:* `src/transports/http.ts:24-71` handles POST/GET/DELETE `/mcp` with only `mcp-session-id` and `isInitializeRequest` checks; the sole middleware is `express.json`. A grep for authorization/bearer/token across `src/transports` and `index.ts` returns nothing. Key wired at `src/server.ts:35-42` from `config.apiKey` (`src/config.ts:117`).
*Fix:* Require a bearer token / OAuth 2.1 per the MCP auth spec on `/mcp` and reject anonymous requests with 401 before `transport.handleRequest`. Even on localhost, gate the HTTP transport behind a required token compared in constant time; for the hosted target this is mandatory.

**H2. HTTP transport has no Origin/Host validation and DNS-rebinding protection is disabled.**
*Why it matters:* The MCP Streamable-HTTP spec MUST-validates `Origin` to defeat DNS rebinding (cf. rmcp advisory GHSA-89vp-x53w-74fx). With protection off, a browser page on any site can POST to the loopback endpoint and, via rebinding, drive every read-only tool. This is the exact control DESIGN.md promised (`enableDnsRebindingProtection` + `allowedHosts`/`allowedOrigins` + an `MCP_HTTP_ALLOWED_HOSTS` env) and the implementation dropped.
*Evidence:* `src/transports/http.ts:38-44` constructs `StreamableHTTPServerTransport` with only `sessionIdGenerator`/`onsessioninitialized`. The SDK (1.29) exposes `allowedHosts`/`allowedOrigins`/`enableDnsRebindingProtection` (default false) at `webStandardStreamableHttp.d.ts:84-96`; none are set. No Express middleware checks Origin or Host.
*Fix:* Pass `enableDnsRebindingProtection:true` with `allowedHosts`/`allowedOrigins` sourced from config (default `127.0.0.1`/`localhost`), and/or add Express middleware that 403s mismatched Origin/Host on POST, GET, and DELETE. Since the SDK marks those options `@deprecated`, the durable form is allowlisting middleware plus real auth (H1).

**H3. HTTP sessions accumulate unbounded (no idle TTL, max-session cap, or reaper).**
*Why it matters:* Combined with the unauthenticated `initialize` path (H1), a loop of `initialize` requests grows memory without bound on the hosted deployment, a trivial DoS amplifier. Each new session runs `createServer` (two API clients + registration of all 83 tools), a non-trivial per-session allocation.
*Evidence:* `src/transports/http.ts:18` holds the session `Map`, pruned only by `transport.onclose` (`http.ts:45-50`), which the SDK fires only on explicit DELETE/close. A POST-only client that never sends DELETE leaves its session resident forever. No idle timeout, max-session cap, sweep, or SIGTERM drain exists.
*Fix:* Track `lastSeen` per session and run a `setInterval` reaper that closes/deletes sessions idle past a TTL (5-10 min); enforce a hard max-session count (reject 503 or evict LRU); add a SIGTERM handler that drains and closes all transports.

### MEDIUM

**M1. Token-budget cap is bypassed for all object/raw responses (`rawResult` never truncates).**
*Why it matters:* `buildResult` truncates only arrays; `rawResult` (used by 33 tools, including the keyless public group and the `hd_info_raw` `/info` escape hatch) emits the full upstream payload verbatim with no size guard, so a large response (`metaAndAssetCtxs`, full meta, a deep `l2Book`, wide `eth_getLogs`/full block, or a month of 1m candles) silently bypasses the 25k budget and can blow the agent's context window. `hd_rpc_get_logs` already uses the budgeted `buildResult` while sibling `hd_rpc_get_block` does not, demonstrating the gap inside one file.
*Evidence:* `src/tools/shared/output.ts:38-50` (array-only truncation) vs `output.ts:67-72` (no guard). Confirmed unguarded at `public.ts:62`/`:191`, `rpc.ts:186`, `info.ts:56`.
*Fix:* Apply an `estimateTokens` check inside `rawResult`; when over budget, return a truncated/summarized form with a steering note ("response too large, narrow the query / use the typed tool"), mirroring `buildResult`.

**M2. No global rate limiting, concurrency cap, or backpressure on tool invocations.**
*Why it matters:* A session can issue unlimited concurrent tool calls, each fanning out to an upstream fetch or a 5-30s WS window, pinning many sockets/fetches simultaneously; the only ceiling is upstream timeouts. On the hosted multi-tenant path this is read-only resource exhaustion with no per-client fairness.
*Evidence:* `src/transports/http.ts` wires only `express.json({limit:'4mb'})` and the raw `/mcp` handlers; no rate-limit middleware, throttle, concurrency semaphore, or circuit breaker. `streams.ts:28` caps WS windows at 30s but nothing caps concurrent calls.
*Fix:* Add per-session/per-IP rate-limit middleware on `/mcp` and a concurrency semaphore (per session and global) around tool execution; consider a circuit breaker that fast-fails on upstream error spikes. Also bound expensive RPC queries (reject `eth_getLogs` ranges over N blocks unless a `block_hash` or address+topics filter is given). *(Mitigated today by the 4mb body cap, 30s per-request timeout, bounded WS windows, and upstream 429 handling; default stdio transport is unaffected.)*

**M3. `engines.node` floor (>=20.18.0) understates the real Node >=22 requirement.**
*Why it matters:* The default `all` preset enables the `streams`, `live`, and `rpc-subscribe` tools, which depend on the native global `WebSocket` that only ships in Node >=22. An npx user on Node 20 LTS gets 14 advertised, key-gated tools that reject at call time with "need Node >=22."
*Evidence:* `package.json:14-16` declares `>=20.18.0`; `src/hypedexer/ws-client.ts:157-164` and `rpc-client.ts:147-154` reject when `globalThis.WebSocket` is absent. Failure is graceful and self-describing; the other ~69 tools (including all 8 keyless `hl_public_*`) work on Node 20.
*Fix:* Bump `engines.node` to `>=22`, or, if REST-only Node-20 support is intentional, document the split and have the registry skip/annotate the WS-dependent groups when `typeof WebSocket !== 'function'` so they are not advertised on unsupported runtimes.

**M4. No `prepublishOnly`/`prepare` build hook while `dist` is gitignored — risk of publishing an empty package.**
*Why it matters:* From a clean checkout or CI, `npm publish` would run with no `dist` present and ship a tarball with only README/LICENSE; the bin target `./dist/index.js` would be missing.
*Evidence:* `package.json` scripts (lines 27-39) have no `prepublishOnly`/`prepare`; `.gitignore:2` lists `dist`; `files` whitelists `dist`.
*Fix:* Add `"prepublishOnly": "npm run build"` (or `"prepare": "tsup"`) and verify with `npm pack --dry-run`.

**M5. No CI pipeline.**
*Why it matters:* No automated typecheck/lint/test/build on push and no publish workflow, despite scripts existing for all of these. This also de-risks M4 by building in CI.
*Evidence:* No `.github/` (or other CI) directory; `typecheck`/`test`/`lint`/`build` exist as package scripts but run only manually.
*Fix:* Add a GitHub Actions workflow running typecheck, lint, test, and build on PRs, plus a tag-triggered `npm publish --provenance` job.

**M6. WSL launcher path requires a git clone, but distribution is via npx (disjoint install stories).**
*Why it matters:* This breaks the primary Windows/Claude-Desktop onboarding path against the shipped artifact.
*Evidence:* `README:110-125` points WSL users at `/home/<you>/hypedexer-mcp/scripts/launch.sh`, which exists only in a clone; `scripts/` is excluded from `files` (`package.json:13`), so npx users never get it. The npx config and the WSL config target non-overlapping layouts, and the README never instructs cloning.
*Fix:* Document that the WSL launcher requires cloning, and provide an npx-native WSL recipe (e.g. `wsl.exe bash -lc 'npx -y @hypedexer/mcp-server'`) so WSL users are not forced off the npx path.

### LOW

- **L1. No tool declares an `outputSchema`** despite always emitting `structuredContent`. Fully spec-compliant (outputSchema is optional and the JSON is mirrored into text), but clients cannot SDK-validate the structured payload. Declare a shared envelope `{data, pagination?, meta?, notes?}` for the list-envelope tools; leave raw passthrough tools unschematized. If added, the SDK must skip output validation when `isError` is true (`errorResult` returns no `structuredContent`). *(`registry.ts:48-66`, `output.ts:62/70`.)*
- **L2. `response_format` is advertised to the agent but wired into zero tools (dead contract).** `responseFormatSchema` (concise/detailed) exists and `server.ts:58` instructs the model to pass `response_format="detailed"`, but Zod silently strips the unknown key, so the agent always gets full output and never an error. Either implement concise projection or delete the schema and the `server.ts:58` line.
- **L3. No concise field-projection; responses are full raw upstream JSON.** Known-garbage fields are documented in `notes` rather than dropped (e.g. `evm.ts:222-224` empty `tx_hash`/`from_addr`, `total_priority_gas=0`, `block_height=0`), against Anthropic's "suppress low-level noise" guidance. One tool already strips correctly (`traders.ts:307-310`). Add per-family concise projections, gated on L2's `response_format`.
- **L4. Token-budget under-count.** The budget measures only the data array (`output.ts:40`) and excludes pagination/meta/notes/summary, so the emitted field modestly exceeds `maxTokens`. Measure the actual emitted payload, or drop the duplicated text block once an outputSchema exists.
- **L5. `readOnlyHint` is overridable.** `registry.ts:55` spreads defaults first then `def.annotations` last, so a tool could set `readOnlyHint:false`. Currently benign (no def does this) and annotations are advisory metadata, not a security boundary, but hard-set `readOnlyHint:true` last or whitelist overridable keys.
- **L6. `httpHost` is operator-configurable to `0.0.0.0` with no guard or warning** (`config.ts:139`, bound directly at `http.ts:74`). Default is safe loopback; combined with H1/H2 this becomes network-wide unauthenticated access. Warn and refuse a non-loopback bind unless auth is configured.
- **L7. Read-only RPC enforcement is a 2-method denylist.** `RPC_WRITE_METHODS` blocks only `eth_sendTransaction`/`eth_sendRawTransaction`; `hd_rpc_call` forwards any method string, so `eth_sign*`/`personal_*`/`admin_*`/`debug_*`/`miner_*`/`txpool_*` pass through. Safe against the default hosted RPC (no unlocked accounts), risky only against a self-hosted node. Switch to an allowlist of read methods or expand the denylist.
- **L8. Raw upstream/on-chain content echoed into the model text block without an untrusted-data envelope** (prompt-injection class, the primary risk for a data server). The cited RPC paths return hex-encoded values and `JSON.stringify` already escapes control chars, so the cited vector is weak, but free-text attacker-controllable fields exist elsewhere (`hd_info_raw`, HIP-3 DEX/coin names). Wrap passthrough payloads in a labeled "data, not instructions" envelope and document it in tool descriptions.
- **L9. Pre-open WebSocket failures are uniformly attributed to auth.** Connect-timeout, error-before-open, and close-before-open all throw `WSAuthError` ("Likely 401/429"), so a bad base URL, DNS failure, TLS error, or outage steers the agent to fix the API key. Split the guidance to "verify the API key OR the base URL / connectivity."
- **L10. Non-standard 4xx responses fall through to `NetworkError`** (`errors.ts:132`), so 403/409/400-without-`{error}` get "Retry, check connectivity" guidance that is wrong for non-retryable client errors. Add a 403 branch and a default-4xx -> `ValidationError`.
- **L11. Every JSON-RPC error maps to `ValidationError` regardless of code** (`rpc-client.ts:83-89`), so a `-32603` internal error tells the agent to fix its parameters. Branch on `body.error.code`; route true internal/server faults to `ServerError`. (Note: on this read-only `eth_*` surface, `-32000..-32099` is often "execution reverted"/"range too wide," for which the parameter-correction hint is actually correct, so refine rather than blanket-remap.)
- **L12. Abnormal WS close codes after open collapse into a clean empty success** (`ws-client.ts:317-329`): a server error close (1008/1006) is indistinguishable from an idle end-of-window. Capture `ev.code`/`ev.reason`, push a warning for non-benign codes (whitelisting 1011, which this server emits even on graceful close), and/or add a `close_code` field.
- **L13. Mirror-protocol subscription error frames are collected as data** (`ws-client.ts:280-288`): `{channel:'error', data:'<msg>'}` is appended as an item instead of routed through `finishError` like the multiplex path. Special-case `f.channel === 'error'`.
- **L14. `RpcClient.call` and WS collect-windows ignore caller cancellation** (no `AbortSignal`). Latent and bounded by the 30s timeout; note the MCP `extra.signal` is not threaded anywhere (`registry.ts:58` drops `extra`), so wiring this is only useful alongside registry-level signal plumbing.
- **L15. Inconsistent enum-guard strategy for ranking/sort keys.** `hd_hip3_traders` uses `z.enum`, `hd_traders_leaderboard` relies on an upstream 422 round-trip, `hd_completed_trades_search` silently ignores bad sort values. Pick one convention across the family.
- **L16. Primary requested record placed under `meta`** in `hd_twap_detail` (`twaps.ts:177-178`): the order sits under `meta.detail` while fills occupy `data`. Disclosed in the tool description and still present in the payload, but a minor semantic mis-key.
- **L17. Test-coverage gaps.** The output shaper (`buildResult`/truncation/`rawResult`/`errorResult`) has zero tests; only 1 of 83 handlers has behavioral coverage (`hd_fills_search`); foundational modules (`time.ts` edge cases, `coin-format.ts`, `public-client.ts`, `http.ts` 400-on-missing-init and session isolation) are untested offline. Logic is currently correct, so this is regression risk, not an active bug. Add mocked-fetch handler tests for multi-branch tools and a unit test for the output shaper.
- **L18. Code hygiene:** dead `noExplicitAny` suppression (`types.ts:55`, redundant vs `biome.json:9`); unused error subclasses `WSSubprotocolError`/`WSProtocolError`, `ValidationError.field()`, and `Wei`/`Side` types; redundant `/` branch in `normalizeCoin` (`coin-format.ts:18`). Delete or wire in.
- **L19. Packaging polish:** not published to npm (the advertised `npx` install 404s today; documented from-source path works); package-name inconsistency (`package.json`/README say `@hypedexer/mcp-server`, DESIGN.md says `@hypedexer/mcp`); no Docker image or `server.json`/registry metadata; missing `repository`/`homepage`/`bugs`; empty library `main`/`types` with no `exports` map; v0.1.0 marked unreleased; dev smoke script hardcodes an absolute user path.

### INFO
- `express` dependency contradicts DESIGN.md's stated `node:http` choice (harmless drift; reconcile the doc or drop the dep).
- 83 tools in the default `all` preset is high vs the focused-tool convention; key-gating means a no-key session registers only 8 public tools, so context cost is bounded. Consider defaulting to `core` (~30) and a progressive-disclosure entry point as HIP groups grow.
- `buildResult` re-serializes arrays during truncation measurement and uses pretty-print for the budget check (geometric ~2x a single stringify; bounded, sub-millisecond).
- No built-in retry/backoff or circuit breaker; resilience is delegated to agent prose hints. Acceptable for a read-only MCP server; consider bounded retry-with-jitter for idempotent reads on 429/5xx.
- `CHANGELOG.md` excluded from the published tarball (`files` array).

## 5. Comparison vs popular OSS MCP servers

Reference baseline: the canonical `modelcontextprotocol/servers` set (fetch, filesystem, git, memory, time, everything) plus the converged remote pattern (Cloudflare Workers + Agents SDK + OAuth used by Stripe/Linear/Atlassian/Sentry). The official reference servers are explicitly "educational, not production-ready."

| Capability | HypeDexer MCP | Typical OSS MCP server | Verdict |
|---|---|---|---|
| Dual stdio + Streamable-HTTP from one codebase | Yes | Often stdio-only | **Leads** |
| Zod-validated inputs | Yes, strict | Common | Par |
| `outputSchema` declared | No | Increasingly yes (FastMCP/templates) | **Lags** |
| `structuredContent` + text mirroring | Yes, spec-correct | Mixed | **Leads** |
| `isError` semantics + actionable error text | Yes, full taxonomy | Often raw/opaque | **Leads** |
| Token budget / pagination / truncation | Yes (arrays); raw bypasses it | Rarely implemented | **Leads** (with M1 caveat) |
| Honest annotations | Yes | Mixed | **Leads** |
| Remote auth (OAuth 2.1 / bearer) | None | Mandatory bar for remote | **Lags badly** |
| Origin/Host validation, DNS-rebinding defense | None | Spec MUST; SDK-provided | **Lags** |
| Session lifecycle (TTL/cap/reaper) | None | Expected for hosted | **Lags** |
| npx distribution | Configured, not published | Published is the norm | **Lags (pre-release)** |
| Docker image + `server.json` + registry entry | None | Increasingly expected | **Lags** |
| CI + Inspector-in-CI | None | Common | **Lags** |
| Test coverage of handlers | Thin (1/83) | Varies | Par/below |
| Tool depth & domain modeling | 83 tools, rich descriptions, quirk notes | Usually narrower | **Leads** |

**Where it leads:** breadth and quality of the tool surface, error ergonomics, token-aware output, dual-transport-from-one-codebase, and overall code discipline all exceed the reference set and most community servers. As a *local stdio* server it is already above the bar.

**Where it lags:** everything that the 2026 *remote* bar requires. The reference convergence point for hosted MCP is OAuth 2.1, session isolation with lifecycle management, and Origin validation; HypeDexer ships none of these on the very transport it documents as the hosted shape. It also trails on distribution maturity (unpublished, no Docker, no `server.json`, no CI), though these are expected gaps for a self-described non-final v0.1.0.

## 6. Prioritized remediation roadmap

### Now (before any hosted/`0.0.0.0` exposure; blocks the documented deployment)
1. **H1** — Require auth (bearer token min, OAuth 2.1 target) on `/mcp`; reject anonymous with 401 before `handleRequest`.
2. **H2** — Enable Origin/Host allowlisting (`enableDnsRebindingProtection` or middleware, 403 on mismatch), defaulting to `127.0.0.1`/`localhost`.
3. **H3** — Add session idle-TTL reaper, hard max-session cap, and SIGTERM drain.
4. **L6** — Warn/refuse non-loopback bind unless auth is configured.
5. **M4** — Add `prepublishOnly: npm run build` so a publish cannot ship an empty package.

### Next (correctness, robustness, release readiness)
6. **M1** — Gate `rawResult` through the token budget with a steering note.
7. **M2** — Per-session/IP rate limit + concurrency semaphore on `/mcp`; bound `eth_getLogs` ranges.
8. **M3** — Bump `engines.node` to `>=22` (or gate/annotate WS groups at runtime).
9. **M5** — GitHub Actions: typecheck/lint/test/build on PR + tag-triggered publish with provenance.
10. **M6** — Reconcile the npx vs WSL install stories; publish to npm and fix the package-name divergence (**L19**).
11. **L2** — Implement or delete `response_format` (remove the misleading `server.ts:58` instruction either way).
12. **L7** — Convert the RPC denylist to a read-method allowlist.
13. **L9 / L10 / L11 / L12 / L13** — Fix the five error-steering edge cases.
14. **L17** — Add output-shaper unit tests and mocked-fetch handler tests for the multi-branch tools.

### Later (polish, optimization, distribution completeness)
15. **L1 / L4** — Declare a shared `outputSchema` envelope and stop double-counting/duplicating the payload.
16. **L3** — Add concise field-projections; drop known-garbage fields.
17. **L8** — Untrusted-data envelope for passthrough content.
18. **L18** — Remove dead code and redundant branches.
19. **L19 (remainder)** — Dockerfile, `server.json` + registry entry, `repository`/`homepage`/`bugs`, `exports` map, ship `CHANGELOG.md`, portable smoke script.
20. **INFO** — Reconcile `express` vs `node:http` in DESIGN.md; consider defaulting the preset to `core` with progressive disclosure; optional retry-with-jitter for idempotent reads.

*Bottom line: a strong, honestly-built read-only data server whose architecture and tool design already beat most OSS MCP projects. Closing the five "Now" items converts the documented hosted deployment from an open, unauthenticated proxy into a defensible remote MCP service; the rest is incremental hardening and pre-release packaging appropriate to v0.1.0.*