import type { infer as ZodInfer, ZodRawShape, ZodTypeAny } from 'zod'
import type { ToolGroup } from '../config.js'
import type { ToolContext } from './context.js'

/**
 * Minimal shape of an MCP `tools/call` result. We model it locally (rather than
 * importing the SDK's heavy generic) so tool handlers stay independent of the
 * MCP machinery and can be unit-tested in isolation.
 */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
  [key: string]: unknown
}

export interface ToolAnnotations {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

/**
 * A self-contained tool definition. The registry turns each one into a
 * `server.registerTool` call; the handler can also be invoked directly in tests.
 */
export interface ToolDef<Shape extends ZodRawShape = ZodRawShape> {
  name: string
  group: ToolGroup
  title: string
  description: string
  /** Zod raw shape — passed straight to the SDK as `inputSchema`. */
  inputSchema: Shape
  annotations?: ToolAnnotations
  handler: (args: InferShape<Shape>, ctx: ToolContext) => Promise<ToolResult>
}

export type InferShape<Shape extends ZodRawShape> = {
  [K in keyof Shape]: Shape[K] extends ZodTypeAny ? ZodInfer<Shape[K]> : never
}

/** Helper that preserves the precise input-shape type through definition. */
export function defineTool<Shape extends ZodRawShape>(def: ToolDef<Shape>): AnyToolDef {
  return def as unknown as AnyToolDef
}

/**
 * Shape-erased tool definition. Specific `ToolDef<Shape>` values are not mutually
 * assignable (handler params are contravariant), so collections use this erased
 * form. `defineTool` keeps full type-checking inside each definition, then erases
 * the shape at the boundary.
 */
// biome-ignore lint/suspicious/noExplicitAny: intentional shape erasure at the collection boundary
export type AnyToolDef = ToolDef<any>

/** A domain module exports its tools as a flat array of definitions. */
export type ToolModule = AnyToolDef[]
