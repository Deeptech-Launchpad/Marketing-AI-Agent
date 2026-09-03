import type { z } from 'zod'

// Provider-agnostic LLM contract. Every model call in the platform goes through
// an implementation of this — the key never leaves the server, and there is no
// second call site to forget about.
//
// This deliberately replaces NXT Sales' browser-side pattern, where the Gemini
// key lives in localStorage and the call is made from the tab. An agent run
// outlives the tab, needs server-side budget control, and must not put a
// long-lived credential anywhere a script can read it.

export interface LlmUsage {
  promptTokens: number
  outputTokens: number
  totalTokens: number
  /**
   * False when the provider answered successfully but returned no token counts
   * at all. The request still counts; the tokens stay zero. Nothing here is
   * ever estimated or back-calculated.
   */
  hasUsageData: boolean
}

export interface LlmResult<T> {
  data: T
  text: string
  usage: LlmUsage
  model: string
  modelRequested: string
  fellBack: boolean
  costUsd: number
  priced: boolean
  latencyMs: number
}

export interface GenerateOptions<T> {
  /** Prompt identity — resolved from the DB, recorded on every LlmCall. */
  promptKey: string
  variables: Record<string, unknown>
  /** When present, the response is forced to this shape and validated against it. */
  schema?: z.ZodType<T>
  model?: string
  temperature?: number
  feature: string
  tenantId: string
  runId?: string | null
  stepId?: string | null
}

export interface EmbedOptions {
  texts: string[]
  tenantId: string
  runId?: string | null
}

export interface EmbedResult {
  vectors: number[][]
  model: string
  usage: LlmUsage
}

export interface LlmPort {
  readonly name: string
  generate<T = string>(opts: GenerateOptions<T>): Promise<LlmResult<T>>
  embed(opts: EmbedOptions): Promise<EmbedResult>
  health(): Promise<{ ok: boolean; detail?: string }>
}
