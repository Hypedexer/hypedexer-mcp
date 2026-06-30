import { analyticsTools } from './analytics.js'
import { buildersTools } from './builders.js'
import { evmTools } from './evm.js'
import { fillsTools } from './fills.js'
import { fundingTools } from './funding.js'
import { hip3Tools } from './hip3.js'
import { hip4Tools } from './hip4.js'
import { infoTools } from './info.js'
import { liquidationsTools } from './liquidations.js'
import { liveTools } from './live.js'
import { marketsTools } from './markets.js'
import { publicTools } from './public.js'
import { rpcTools } from './rpc.js'
import { streamsTools } from './streams.js'
import { tradersTools } from './traders.js'
import { twapsTools } from './twaps.js'
import type { ToolModule } from './types.js'
import { vaultsTools } from './vaults.js'

/**
 * Aggregated tool modules. Each domain lives in its own file and exports a flat
 * `ToolModule` array; this barrel is the single place they are wired together.
 * The registry filters them by the enabled tool groups at registration time.
 */
export const allModules: ToolModule[] = [
  publicTools,
  fillsTools,
  marketsTools,
  analyticsTools,
  tradersTools,
  liquidationsTools,
  fundingTools,
  vaultsTools,
  hip3Tools,
  hip4Tools,
  buildersTools,
  twapsTools,
  evmTools,
  streamsTools,
  liveTools,
  rpcTools,
  infoTools,
]
