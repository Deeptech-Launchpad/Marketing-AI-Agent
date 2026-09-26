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

// ── PUBLIC WEB SEARCH ─────────────────────────────────────────────────────
//
// A search returns REFERENCES, never facts.
//
// This is the whole reason it is a separate method rather than a `generate`
// with a clever prompt. `generate` returns what a model SAYS; this returns
// where a search engine POINTED. The distinction is load-bearing: the model's
// prose about a company is an answer that exists whether or not it is true,
// and nothing in this platform is allowed to treat it as evidence. The URL
// list is different — it is produced by the search index, carried in the
// response's grounding metadata rather than composed in the reply, and it is
// checkable, because the caller then fetches those pages itself and reads them
// with its own guarded transport.
//
// So implementations MUST populate `references` from provider metadata, and
// MUST NOT parse URLs out of the model's prose. A caller is expected to ignore
// `modelText` for anything factual; it is returned only so a run can be
// audited, and callers that record evidence must quote the fetched page.

export interface WebSearchReference {
  /** The URL the index pointed at. May be a provider redirect that resolves on fetch. */
  url: string
  /** The title the index carried for it. Never the model's paraphrase. */
  title: string | null
}

export interface WebSearchOptions {
  /** What to search for. Composed by the caller from facts it already holds. */
  query: string
  tenantId: string
  feature: string
  maxReferences?: number
  runId?: string | null
}

export interface WebSearchResult {
  /** False when no search capability is configured, or the provider refused. */
  ok: boolean
  provider: string
  /** The queries the provider actually ran, when it reports them. */
  queriesRun: string[]
  references: WebSearchReference[]
  /** The model's prose. NOT evidence. Kept for audit only. */
  modelText: string
  model: string | null
  costUsd: number
  /** Why there is nothing here, when there is nothing here. */
  reason: string | null
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
  /**
   * Searches the public web and returns where the index pointed.
   *
   * Required rather than optional so a driver cannot quietly lack it and leave
   * a caller guessing; a driver with no search capability returns
   * `ok: false` with a reason, the same way every unconfigured provider in
   * this platform reports itself.
   */
  searchWeb(opts: WebSearchOptions): Promise<WebSearchResult>
  health(): Promise<{ ok: boolean; detail?: string }>
}
