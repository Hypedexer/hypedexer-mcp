# AGENTS.md

Guidance for AI coding agents working on `hypedexer-mcp`. This file is scoped to **repository contribution**. For agents *consuming* the server through an MCP client, the contract is in the README section [How results are shaped](./README.md#how-results-are-shaped-for-agents) and in each tool's description; there is nothing extra to read here.

## Repository shape

Single published package (no monorepo). TypeScript ESM, strict mode, bundled with tsup.

```
src/core/         # vendored transport layer: HttpClient, error taxonomy, pagination, time, envelope types
src/hypedexer/    # keyed API client (X-API-Key), envelope normalization, quirks layer, WS + RPC clients
src/hyperliquid/  # keyless public API client + coin formatting
src/tools/        # one module per tool group + shared contracts (schemas, pagination, output, errors)
src/transports/   # stdio + streamable-HTTP
src/config.ts     # env parsing, tool-group presets and gating
src/env.ts        # dependency-free .env loader (existing env always wins)
scripts/          # launch.sh (Claude Desktop WSL launcher) + smoke scripts
test/             # vitest: mocked-fetch handler tests, in-memory MCP client, gated live tests
DESIGN.md         # canonical design doc: tool catalog, layering, applied tool-design guidance
AUDIT.md          # generated multi-agent audit report (2026-06-30), reference only
```

## Setup

Requires **Node >= 22** (native `WebSocket` with custom upgrade headers; no `ws` dependency) and **pnpm**. Do NOT `npm install` or `yarn install`; the lockfile is pnpm.

```bash
pnpm install --frozen-lockfile
```

## Verification loop

Run **all four** before proposing any change. `prepublishOnly` runs the same sequence.

```bash
pnpm lint           # biome check src test
pnpm typecheck      # tsc --noEmit, strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess
pnpm test           # vitest, 84 tests (3 live tests skip without HYPEDEXER_MCP_LIVE=1)
pnpm build          # tsup -> dist/index.js
```

Optional but decisive when touching tools or transports:

```bash
pnpm smoke          # build + in-memory MCP client smoke (keyless)
pnpm test:live      # runs the live keyless tests against api.hyperliquid.xyz
```

Do NOT skip tests. If a test needs updating, update it in the same commit as the source change.

## Commit conventions

| Rule | Details |
|---|---|
| **Style** | `type: subject` (no scope), types seen in history: `feat`, `fix`, `docs`, `chore`, `release`. Subject lowercase. |
| **No em-dash, anywhere** | The maintainer bans the em-dash character project-wide: commit messages, code, comments, docs, CHANGELOG. Use hyphens, colons, or restructure the sentence. Check your diff before committing. |
| **Direct commit to `master`** | No feature branches, no PRs. |
| **Comments in English only** | Regardless of the chat language. Includes JSDoc. |

## Codebase rules

- **ESM imports must include the `.js` extension.** TypeScript is `--moduleResolution NodeNext`. `import { x } from './foo.js'`, never `./foo`.
- **`any` is banned.** Use `unknown` and narrow. Biome enforces it.
- **stdout is sacred on stdio.** The MCP stream owns stdout. All logging goes through `src/logger.ts` (stderr). A stray `console.log` corrupts the protocol and breaks every client.
- **`biome` handles formatting.** If it auto-fixes something, the fix stays.
- **Do not write new comments unless the *why* is non-obvious.** Module-level JSDoc headers (endpoint mapping, quirk notes) are the exception and the convention; see any file in `src/tools/`.

## The tool module pattern

Every tool group is one file in `src/tools/` exporting a `ToolModule` (an array of `defineTool({...})`). Read a sibling module first (`liquidations.ts` is a compact reference; `fills.ts` is the original keyed template); every module follows the same chain:

```
zod params (shared/schemas.ts) -> query builder (shared/pagination.ts)
  -> client call (requireHd(ctx) or ctx.hl) -> quirks normalization (hypedexer/quirks.ts)
  -> buildResult (shared/output.ts): { data, pagination?, meta?, notes? } + text serialization
```

Adding or removing a tool touches **all** of these; missing one is the classic reviewable mistake:

1. The module file itself, and `src/tools/index.ts` (barrel) if the group is new.
2. `src/config.ts` if the group is new (and decide preset membership; `OPT_IN_ONLY` holds `info` and `rpc`).
3. **Tool counters** in `test/tools.client.test.ts` (93 total with `all,info,rpc`; 8 keyless) and `test/config.test.ts`.
4. `scripts/smoke-desktop.mjs` expectations.
5. README tool catalog, `DESIGN.md` counters, `CHANGELOG.md`.

## Hard-won MCP lessons (do not regress these)

- **Serialize real data into the text `content` block.** Claude Desktop (and other clients) ignore `structuredContent` when no `outputSchema` is declared. Results must be readable from the text block alone; `structuredContent` is a bonus. This was a production bug, fixed in `shared/output.ts`. Never return a text block that is only a summary header.
- **Token budget with steering.** Every result passes through the 25k-token budget (`HYPEDEXER_MAX_RESPONSE_TOKENS`); oversized arrays are tail-truncated with a note telling the agent how to narrow the query. Raw passthrough tools (`hl_public_*`, `hd_info_raw`, `hd_rpc_*`) go through `rawResult`, which enforces the same budget. Any new tool must go through one of the two.
- **Errors must steer recovery.** Failures return a specific next step ("set HYPEDEXER_API_KEY", "use order=desc"), never an opaque code. Reuse the branches in `shared/errors.ts`.
- **WebSocket tools are bounded snapshots.** MCP is request/response; a WS tool opens, subscribes, drains for `seconds` (1-30) or `max_items`, closes, returns the batch. Never hold a socket across calls.
- **Presets gate cost.** Keyed groups self-skip without a key; dead or raw surfaces (`rpc`, `info`) stay out of `all`. Do not silently widen the default surface.

## Known upstream quirks (live-verified 2026-07-01)

Check this table before "fixing" something that is actually an upstream limitation. Full detail in README and `DESIGN.md`.

| Upstream | Posture here |
|---|---|
| `rpc.hypedexer.com` does not resolve (NXDOMAIN) | `rpc` group is opt-in only, excluded from `all` |
| Mirror WS `bbo`: subscription accepted, zero frames | Tool descriptions steer to `l2Book` (top level = best bid/offer) |
| Mirror WS `trades`: rejected, "Unsupported subscription" | Steer to `hd_stream_completed_trades` |
| Mirror WS `l4Book`: snapshot can exceed the native WS decompression limit | Steer to `l2Book` |
| Mirror hub rate-limits rapid reconnects | Space live WS calls a few seconds apart, including in tests |
| Mirror ack frame `subscriptionResponse` shares the data envelope | Filtered in the collector; keep the filter |
| REST `/fills/spot/*` returned 500 (ClickHouse) at build time | **Fixed upstream 2026-07-06**, live-verified through `hd_fills_search scope=spot` (already wired, offset-paginated). Historical note only |

## Release process

Only apply this section when the user explicitly asks to release or publish.

1. Bump `package.json:version` and `CHANGELOG.md`. Update the User-Agent version claim is automatic (it reads `package.json`), but verify it lands in the built `dist`.
2. Commit as `release: X.Y.Z`, tag `vX.Y.Z` (annotated), push branch + tag.
3. `pnpm publish` runs the `prepublishOnly` gate (lint, typecheck, test, build). Never bypass it with `--no-verify` or `--ignore-scripts`.
4. Verify the tarball with `pnpm pack --dry-run`: `dist/index.js` must be present (`files` limits the tarball to `dist`, README, LICENSE).

## Boundaries: do not touch without approval

- **`.env`** contains the operator's real API key. Never commit it, never print its contents, never weaken `.gitignore`.
- **`scripts/launch.sh`** is referenced by the user's live Claude Desktop config (spawned via `wsl.exe`). Breaking it breaks a production client. stdout must stay clean.
- **`dist/`** is build output, git-ignored. Never commit it. Remember Claude Desktop runs the built `dist`, not `src`: after a fix, rebuild and tell the user to restart Desktop.
- **`AUDIT.md`** is a generated report. Do not edit it to "fix" a finding; fix the code.
- **`DESIGN.md`** is the design doc. Update it when changing a design decision; do not silently rewrite it.

## When in doubt

Read the sibling tool module. Every module in `src/tools/` follows the same pattern (zod params, query builder, client call, quirks, `buildResult`). Match it.
