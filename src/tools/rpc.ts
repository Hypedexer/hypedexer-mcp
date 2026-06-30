import { RpcClient, collectEthSubscription } from '../hypedexer/rpc-client.js'
import type { ToolContext } from './context.js'
import { buildResult, rawResult } from './shared/output.js'
import { z } from './shared/schemas.js'
import { type ToolModule, defineTool } from './types.js'

/**
 * HyperEVM JSON-RPC (HypeDexer RPC product, https://rpc.hypedexer.com).
 *
 * Standard Ethereum JSON-RPC over HTTP, plus eth_subscribe over WebSocket. There
 * is no OpenAPI spec — the surface is the Ethereum JSON-RPC contract. The generic
 * `hd_rpc_call` reaches any read method; the typed tools cover the headline ones.
 * State-mutating methods (eth_sendRawTransaction) are refused — this surface is
 * read-only. Auth is the same `X-API-Key` as the rest of the server.
 */

const blockTagSchema = z
  .string()
  .trim()
  .default('latest')
  .describe(
    'Block number as hex (e.g. "0x1b4") or a tag: "latest", "earliest", "pending", "safe", "finalized".',
  )

function rpc(ctx: ToolContext): RpcClient {
  const apiKey = ctx.config.apiKey
  if (!apiKey) {
    throw new Error('This tool requires a HypeDexer API key. Set HYPEDEXER_API_KEY to enable it.')
  }
  return new RpcClient({
    baseUrl: ctx.config.rpcBaseUrl,
    apiKey,
    timeoutMs: ctx.config.requestTimeoutMs,
    userAgent: ctx.config.userAgent,
  })
}

export const rpcTools: ToolModule = [
  defineTool({
    name: 'hd_rpc_call',
    group: 'rpc',
    title: 'Call any HyperEVM JSON-RPC read method',
    description:
      'Generic HyperEVM JSON-RPC passthrough (POST https://rpc.hypedexer.com). Supply any standard ' +
      'Ethereum read method and its positional params; the tool sends ' +
      '{"jsonrpc":"2.0","method":<method>,"params":<params>} and returns the `result`. Covers the whole ' +
      'read surface (eth_*, net_*, web3_*) — e.g. eth_chainId, eth_gasPrice, eth_getBalance, ' +
      'eth_getTransactionReceipt, eth_getCode, eth_feeHistory. State-mutating methods ' +
      '(eth_sendRawTransaction) are refused. For the common reads, the typed tools (hd_rpc_block_number, ' +
      'hd_rpc_call_contract, hd_rpc_get_logs, hd_rpc_get_block) are more ergonomic.',
    inputSchema: {
      method: z
        .string()
        .trim()
        .min(1)
        .describe('JSON-RPC method name, e.g. "eth_getBalance", "eth_chainId", "net_version".'),
      params: z
        .array(z.unknown())
        .default([])
        .describe(
          'Positional params array for the method (default []). Pass exactly what the method expects.',
        ),
    },
    async handler(args, ctx) {
      const result = await rpc(ctx).call(args.method, args.params)
      return rawResult(result, `JSON-RPC ${args.method} result.`)
    },
  }),

  defineTool({
    name: 'hd_rpc_block_number',
    group: 'rpc',
    title: 'Get the latest HyperEVM block number',
    description:
      'eth_blockNumber: the current HyperEVM head block number (hex string). The one-line health check ' +
      'for the RPC endpoint. No params.',
    inputSchema: {},
    async handler(_args, ctx) {
      const result = await rpc(ctx).call('eth_blockNumber', [])
      return rawResult({ block_number: result }, 'Latest HyperEVM block number (hex).')
    },
  }),

  defineTool({
    name: 'hd_rpc_call_contract',
    group: 'rpc',
    title: 'Read contract state (eth_call)',
    description:
      'eth_call: execute a read-only contract call against HyperEVM without sending a transaction. ' +
      'Provide the target `to` address and ABI-encoded `data`; returns the raw hex return value. Use a ' +
      'library (viem/ethers) to encode `data` and decode the result.',
    inputSchema: {
      to: z
        .string()
        .trim()
        .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 40-hex contract address')
        .describe('Target contract address (0x + 40 hex). Required.'),
      data: z
        .string()
        .trim()
        .regex(/^0x[0-9a-fA-F]*$/, 'must be 0x-prefixed hex calldata')
        .describe('ABI-encoded calldata (0x-prefixed hex). Required.'),
      from: z
        .string()
        .trim()
        .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 40-hex address')
        .optional()
        .describe('Optional caller address to simulate from.'),
      block: blockTagSchema,
    },
    async handler(args, ctx) {
      const callObj: Record<string, unknown> = { to: args.to, data: args.data }
      if (args.from) callObj.from = args.from
      const result = await rpc(ctx).call('eth_call', [callObj, args.block])
      return rawResult({ result }, `eth_call to ${args.to} at ${args.block}.`)
    },
  }),

  defineTool({
    name: 'hd_rpc_get_logs',
    group: 'rpc',
    title: 'Query event logs (eth_getLogs)',
    description:
      'eth_getLogs: query HyperEVM event logs by address, topics, and block range. Bound the range to ' +
      'keep the call fast (wide ranges are heavy). Returns the matching log array. Pass either a ' +
      'from/to block range or a single block_hash.',
    inputSchema: {
      address: z
        .union([z.string().trim(), z.array(z.string().trim())])
        .optional()
        .describe('Contract address or array of addresses to filter by (0x...).'),
      topics: z
        .array(z.union([z.string().trim(), z.null(), z.array(z.string().trim())]))
        .optional()
        .describe(
          'Topic filter array (each entry a 0x topic, null wildcard, or an array of OR-topics).',
        ),
      from_block: blockTagSchema.describe('Start block (hex or tag). Default "latest".'),
      to_block: blockTagSchema.describe('End block (hex or tag). Default "latest".'),
      block_hash: z
        .string()
        .trim()
        .optional()
        .describe('Restrict to a single block by hash (mutually exclusive with from/to block).'),
    },
    async handler(args, ctx) {
      const filter: Record<string, unknown> = {}
      if (args.block_hash) {
        filter.blockHash = args.block_hash
      } else {
        filter.fromBlock = args.from_block
        filter.toBlock = args.to_block
      }
      if (args.address !== undefined) filter.address = args.address
      if (args.topics !== undefined) filter.topics = args.topics
      const result = await rpc(ctx).call('eth_getLogs', [filter])
      const data = Array.isArray(result) ? result : [result]
      return buildResult(
        { data, meta: { method: 'eth_getLogs' } },
        {
          summary: `eth_getLogs returned ${data.length} log(s).`,
          maxTokens: ctx.config.maxResponseTokens,
        },
      )
    },
  }),

  defineTool({
    name: 'hd_rpc_get_block',
    group: 'rpc',
    title: 'Fetch a block (eth_getBlockByNumber)',
    description:
      'eth_getBlockByNumber: fetch a HyperEVM block by number or tag. Set `full=true` to include full ' +
      'transaction objects, or false (default) for just the transaction hashes. Returns the block object.',
    inputSchema: {
      block: blockTagSchema.describe(
        'Block number (hex) or tag ("latest", "earliest", "pending"). Default "latest".',
      ),
      full: z
        .boolean()
        .default(false)
        .describe('Include full transaction objects (true) or only their hashes (false, default).'),
    },
    async handler(args, ctx) {
      const result = await rpc(ctx).call('eth_getBlockByNumber', [args.block, args.full])
      return rawResult(result, `Block ${args.block}.`)
    },
  }),

  defineTool({
    name: 'hd_rpc_subscribe',
    group: 'rpc',
    title: 'Snapshot an eth_subscribe stream (RPC WS)',
    description:
      'eth_subscribe over the JSON-RPC WebSocket (wss://rpc.hypedexer.com): subscribe to newHeads, logs, ' +
      'or newPendingTransactions, collect the pushed notifications for a bounded window, then ' +
      'unsubscribe and close. Point-in-time snapshot, not a standing subscription — call again for a ' +
      'fresh window. For "logs", pass a `filter` object (address/topics) to bound the volume.',
    inputSchema: {
      subscription_type: z
        .enum(['newHeads', 'logs', 'newPendingTransactions'])
        .describe(
          'What to subscribe to: newHeads (block headers), logs (events), or newPendingTransactions.',
        ),
      filter: z
        .record(z.unknown())
        .optional()
        .describe(
          'Filter object for the "logs" subscription (e.g. {"address":"0x...","topics":[...]}). Ignored otherwise.',
        ),
      seconds: z
        .number()
        .int()
        .min(1)
        .max(30)
        .default(5)
        .describe('How long to listen before returning, in seconds (1-30, default 5).'),
      max_items: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .default(200)
        .describe(
          'Stop early once this many notifications have been collected (1-2000, default 200).',
        ),
    },
    async handler(args, ctx) {
      const apiKey = ctx.config.apiKey
      if (!apiKey) {
        throw new Error(
          'This tool requires a HypeDexer API key. Set HYPEDEXER_API_KEY to enable it.',
        )
      }
      const result = await collectEthSubscription({
        wsUrl: ctx.config.rpcWsUrl,
        apiKey,
        subscriptionType: args.subscription_type,
        ...(args.subscription_type === 'logs' && args.filter ? { filter: args.filter } : {}),
        durationMs: args.seconds * 1000,
        maxItems: args.max_items,
        connectTimeoutMs: ctx.config.requestTimeoutMs,
      })
      const notes = [
        'Point-in-time eth_subscribe snapshot over the RPC WebSocket: subscribed, drained for the ' +
          'window, then closed. Call again for a fresh window.',
        ...result.warnings,
      ]
      if (result.item_count === 0) {
        notes.push(
          'No notifications arrived in the window. newPendingTransactions and logs can be sparse; retry with a longer `seconds` window or a broader filter.',
        )
      }
      return buildResult(
        {
          data: result.items,
          meta: {
            subscription_type: result.subscription_type,
            message_count: result.message_count,
            item_count: result.item_count,
            window_seconds: args.seconds,
            elapsed_ms: result.elapsed_ms,
            stopped_by: result.stopped_by,
          },
          notes,
        },
        {
          summary: `Collected ${result.item_count} ${args.subscription_type} notification(s) over ${result.elapsed_ms}ms.`,
          maxTokens: ctx.config.maxResponseTokens,
        },
      )
    },
  }),
]
