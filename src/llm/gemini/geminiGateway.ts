import pLimit from 'p-limit'
import type { z } from 'zod'
import { env } from '../../config/env.js'
import { UpstreamError } from '../../platform/errors.js'
import { logger } from '../../platform/logger.js'
import { estimateCost } from '../costEstimator.js'
import type {
  EmbedOptions,
  EmbedResult,
  GenerateOptions,
  LlmPort,
  LlmResult,
  LlmUsage,
} from '../llmPort.js'
import { resolvePrompt } from '../promptStore.js'
import { recordLlmCall } from '../tokenLedger.js'
import {
  GEMINI_MODEL_PRIORITY,
  GEMINI_REASONING_PRIORITY,
  buildCandidates,
  canTryNextModel,
} from './modelFallback.js'
import { extractJson, toGeminiSchema } from './structuredOutput.js'

// The single server-side Gemini call site.
//
// Transport is plain fetch against the REST API rather than an SDK. The wire
// shape is already proven by NXT Sales' own client-side helper, and it keeps
// the fallback and timeout behaviour under this file's control instead of an
// SDK's.

const limit = pLimit(env.GEMINI_MAX_CONCURRENCY)

interface GeminiUsageMetadata {
  promptTokenCount?: number
  candidatesTokenCount?: number
  totalTokenCount?: number
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
  usageMetadata?: GeminiUsageMetadata
  modelVersion?: string
  error?: { message?: string }
}

/**
 * Only what the provider actually reported. hasUsageData is false when Gemini
 * answered but returned no counts — the request still counts, the tokens stay
 * zero, and nothing is back-calculated to fill the gap.
 */
function readUsage(meta: GeminiUsageMetadata | undefined): LlmUsage {
  if (!meta) return { promptTokens: 0, outputTokens: 0, totalTokens: 0, hasUsageData: false }
  const promptTokens = meta.promptTokenCount ?? 0
  const outputTokens = meta.candidatesTokenCount ?? 0
  const totalTokens = meta.totalTokenCount ?? promptTokens + outputTokens
  const hasUsageData = promptTokens + outputTokens + totalTokens > 0
  return { promptTokens, outputTokens, totalTokens, hasUsageData }
}

function firstText(res: GeminiResponse): string {
  return (res.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim()
}

async function post(path: string, body: unknown): Promise<{ ok: boolean; status: number; json: GeminiResponse }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), env.GEMINI_ATTEMPT_TIMEOUT_MS)
  try {
    const res = await fetch(`${env.GEMINI_API_BASE}/${path}?key=${env.GEMINI_API_KEY}`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = (await res.json().catch(() => ({}))) as GeminiResponse
    return { ok: res.ok, status: res.status, json }
  } finally {
    clearTimeout(timer)
  }
}

export class GeminiGateway implements LlmPort {
  readonly name = 'gemini'

  async generate<T = string>(opts: GenerateOptions<T>): Promise<LlmResult<T>> {
    return limit(() => this.generateInner(opts))
  }

  private async generateInner<T>(opts: GenerateOptions<T>): Promise<LlmResult<T>> {
    const prompt = await resolvePrompt(opts.promptKey, opts.variables, opts.tenantId)

    // Reasoning-shaped steps get the pro-tier ordering; everything else gets
    // the flash-first list. Both still fall through the whole chain.
    const isReasoning = /icp|strategy|intake|segment/i.test(opts.promptKey)
    const priority = isReasoning ? GEMINI_REASONING_PRIORITY : GEMINI_MODEL_PRIORITY
    const preferred =
      opts.model || (isReasoning ? env.GEMINI_MODEL_REASONING : env.GEMINI_MODEL_CONTENT) || undefined
    const candidates = buildCandidates(preferred, priority)
    const modelRequested = candidates[0] ?? 'gemini-flash-latest'

    const generationConfig: Record<string, unknown> = {
      temperature: opts.temperature ?? prompt.temperature,
    }
    if (opts.schema) {
      generationConfig.responseMimeType = 'application/json'
      generationConfig.responseSchema = toGeminiSchema(opts.schema as z.ZodType<unknown>)
    }

    const body = {
      systemInstruction: { parts: [{ text: prompt.systemInstruction }] },
      contents: [{ role: 'user', parts: [{ text: prompt.userText }] }],
      generationConfig,
    }

    const started = Date.now()
    let lastError: Error | null = null

    for (const model of candidates) {
      let res
      try {
        res = await post(`models/${model}:generateContent`, body)
      } catch (err) {
        lastError =
          (err as Error).name === 'AbortError'
            ? new Error(`${model} did not respond within ${env.GEMINI_ATTEMPT_TIMEOUT_MS}ms`)
            : (err as Error)
        continue
      }

      if (!res.ok) {
        const message = res.json.error?.message ?? `Gemini API error (${res.status})`
        lastError = new Error(message)
        if (canTryNextModel(res.status, message)) continue
        // Bad key / safety block — identical on every model, so stop here
        // rather than burning the rest of the chain.
        break
      }

      const text = firstText(res.json)
      const usage = readUsage(res.json.usageMetadata)
      // Gemini reports the concrete model that actually answered, which may
      // differ from the candidate we asked for. Cost and the ledger key off
      // the reported one.
      const actualModel = res.json.modelVersion ?? model
      const cost = estimateCost('gemini', actualModel, usage.promptTokens, usage.outputTokens)
      const latencyMs = Date.now() - started

      await recordLlmCall({
        tenantId: opts.tenantId,
        runId: opts.runId,
        stepId: opts.stepId,
        feature: opts.feature,
        provider: 'gemini',
        modelRequested,
        model: actualModel,
        fellBack: actualModel !== modelRequested,
        usage,
        costUsd: cost.totalCost,
        priced: cost.priced,
        latencyMs,
        promptKey: prompt.key,
        promptVersion: prompt.version,
      })

      if (!text) throw new UpstreamError('Gemini returned an empty response.', { retryable: true })

      const base = {
        text,
        usage,
        model: actualModel,
        modelRequested,
        fellBack: actualModel !== modelRequested,
        costUsd: cost.totalCost,
        priced: cost.priced,
        latencyMs,
      }

      if (!opts.schema) return { ...base, data: text as unknown as T }

      const parsed = opts.schema.safeParse(this.parseOrThrow(text))
      if (parsed.success) return { ...base, data: parsed.data }

      // One bounded repair attempt, then fail. Never coerce a malformed
      // response into the expected shape — a silently half-filled strategy is
      // worse than a failed step.
      logger.warn({ promptKey: opts.promptKey, model: actualModel }, 'schema validation failed, repairing')
      const repaired = await this.repair(opts, body, model, parsed.error.message)
      if (repaired) return { ...base, ...repaired }

      throw new UpstreamError(
        `Gemini response did not match the expected schema for "${opts.promptKey}".`,
        { retryable: false, details: { issues: parsed.error.issues.slice(0, 5) } },
      )
    }

    throw new UpstreamError(
      `${lastError?.message ?? 'Gemini call failed'} (tried ${candidates.length} model(s))`,
      { retryable: false },
    )
  }

  private parseOrThrow(text: string): unknown {
    try {
      return extractJson(text)
    } catch {
      return null
    }
  }

  private async repair<T>(
    opts: GenerateOptions<T>,
    body: Record<string, unknown>,
    model: string,
    validationError: string,
  ): Promise<Pick<LlmResult<T>, 'data' | 'text'> | null> {
    const contents = [
      ...(body.contents as unknown[]),
      {
        role: 'user',
        parts: [
          {
            text:
              `The previous response did not match the required schema. ` +
              `Validation error:\n${validationError}\n\n` +
              `Return ONLY corrected JSON matching the schema. No prose, no code fence.`,
          },
        ],
      },
    ]

    try {
      const res = await post(`models/${model}:generateContent`, { ...body, contents })
      if (!res.ok) return null
      const text = firstText(res.json)
      const usage = readUsage(res.json.usageMetadata)
      const actualModel = res.json.modelVersion ?? model
      const cost = estimateCost('gemini', actualModel, usage.promptTokens, usage.outputTokens)

      // The repair attempt is a real request and is billed like one.
      await recordLlmCall({
        tenantId: opts.tenantId,
        runId: opts.runId,
        stepId: opts.stepId,
        feature: `${opts.feature}.repair`,
        provider: 'gemini',
        modelRequested: model,
        model: actualModel,
        fellBack: false,
        usage,
        costUsd: cost.totalCost,
        priced: cost.priced,
        latencyMs: 0,
        promptKey: opts.promptKey,
      })

      const parsed = opts.schema!.safeParse(this.parseOrThrow(text))
      return parsed.success ? { data: parsed.data, text } : null
    } catch {
      return null
    }
  }

  async embed(opts: EmbedOptions): Promise<EmbedResult> {
    const model = env.GEMINI_MODEL_EMBEDDING
    const vectors: number[][] = []

    // Sequential through the same semaphore rather than one batch request:
    // batch endpoints differ across embedding models, and a corpus ingestion is
    // a background job where throughput matters less than not breaking.
    for (const text of opts.texts) {
      const out = await limit(async () => {
        // outputDimensionality is sent ALWAYS, not only when it differs from
        // the default. gemini-embedding-001 returns 3072 dimensions unless
        // told otherwise, and the KnowledgeChunk column is vector(768) — an
        // omitted value here fails at insert time with an opaque Postgres
        // dimension error rather than anything that points at this line.
        const res = await post(`models/${model}:embedContent`, {
          model: `models/${model}`,
          content: { parts: [{ text }] },
          outputDimensionality: env.GEMINI_EMBEDDING_DIMENSIONS,
        })
        if (!res.ok) {
          const message = (res.json as { error?: { message?: string } }).error?.message ?? 'embed failed'
          throw new UpstreamError(`Gemini embedding failed: ${message}`, { retryable: res.status >= 500 })
        }
        const values = (res.json as unknown as { embedding?: { values?: number[] } }).embedding?.values
        if (!values?.length) throw new UpstreamError('Gemini returned an empty embedding.', { retryable: true })
        if (values.length !== env.GEMINI_EMBEDDING_DIMENSIONS) {
          throw new UpstreamError(
            `Gemini returned a ${values.length}-dimension embedding but the store expects ${env.GEMINI_EMBEDDING_DIMENSIONS}.`,
            { retryable: false },
          )
        }
        // Truncated Gemini embeddings are not unit-normalised. Cosine distance
        // is scale-invariant so this is not strictly required today, but it
        // keeps the stored vectors well-behaved if the index or metric changes.
        const norm = Math.sqrt(values.reduce((s, v) => s + v * v, 0)) || 1
        return values.map((v) => v / norm)
      })
      vectors.push(out)
    }

    // Google does not return usage metadata on embedContent, so this is
    // recorded honestly as "no usage data" rather than an invented count.
    return {
      vectors,
      model,
      usage: { promptTokens: 0, outputTokens: 0, totalTokens: 0, hasUsageData: false },
    }
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const res = await fetch(`${env.GEMINI_API_BASE}/models?key=${env.GEMINI_API_KEY}`, {
        signal: AbortSignal.timeout(8_000),
      })
      // Never surface the response body here — it can echo the key back.
      return res.ok ? { ok: true } : { ok: false, detail: `HTTP ${res.status}` }
    } catch (err) {
      return { ok: false, detail: (err as Error).message }
    }
  }
}
