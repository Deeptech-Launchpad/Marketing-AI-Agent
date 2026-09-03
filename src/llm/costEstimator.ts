// Cost estimation, ported from NXT Sales' server/src/utils/aiPricing.js.
//
// SINGLE source of truth: to change a rate, change it here and nowhere else.
// Rates are USD per 1,000,000 tokens from Google's published pricing.
//
// A model that is not listed returns priced:false and a zero cost, and every
// caller reports "pricing unavailable" rather than showing an invented number.
// Two caveats are encoded as "unavailable" rather than guessed, carried over
// from the original:
//   * rolling aliases (gemini-flash-latest / gemini-pro-latest) resolve to a
//     different concrete model over time, so they are NOT priced. In practice
//     the gateway records the concrete model the API reports back, so alias
//     rows should be rare.
//   * tiered rates (long-context tiers, cache/batch discounts) are not
//     modelled — the base text rate is used, which makes long-context requests
//     an UNDER-estimate. That is why every figure is labelled "estimated".
//   * preview models (e.g. gemini-3.1-pro-preview, which gemini-pro-latest
//     currently resolves to) have no published rate and are left unpriced
//     rather than approximated from the nearest GA model.

const PER_MILLION = 1_000_000

interface Rate {
  input: number
  output: number
}

const PRICING: Record<string, Record<string, Rate>> = {
  gemini: {
    // 3.x rates ported from NXT Sales' utils/aiPricing.js (verified there
    // 2026-08-20). These matter because the rolling "-latest" aliases resolve
    // to this line in practice: gemini-flash-latest answers as gemini-3.7-flash.
    'gemini-3.7-flash': { input: 0.75, output: 3.75 },
    'gemini-3.6-flash': { input: 0.75, output: 3.75 },
    'gemini-3.5-flash': { input: 1.5, output: 9.0 },
    'gemini-3.5-flash-lite': { input: 0.3, output: 2.5 },
    'gemini-2.5-pro': { input: 1.25, output: 10.0 },
    'gemini-2.5-flash': { input: 0.3, output: 2.5 },
    'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
    'gemini-2.0-flash': { input: 0.1, output: 0.4 },
    'gemini-2.0-flash-lite': { input: 0.075, output: 0.3 },
    // Embedding rate per 1M input tokens; embeddings have no output tokens.
    'gemini-embedding-001': { input: 0.15, output: 0.0 },
  },
}

export interface CostEstimate {
  inputCost: number
  outputCost: number
  totalCost: number
  priced: boolean
}

export function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

/** Strips a leading "models/" so a raw API model name resolves to a rate. */
function normalise(model: string): string {
  return model.replace(/^models\//, '').trim()
}

export function estimateCost(
  provider: string,
  model: string,
  promptTokens: number,
  outputTokens: number,
): CostEstimate {
  const rate = PRICING[provider]?.[normalise(model)]
  if (!rate) return { inputCost: 0, outputCost: 0, totalCost: 0, priced: false }

  const inputCost = (promptTokens / PER_MILLION) * rate.input
  const outputCost = (outputTokens / PER_MILLION) * rate.output
  return {
    inputCost: round6(inputCost),
    outputCost: round6(outputCost),
    totalCost: round6(inputCost + outputCost),
    priced: true,
  }
}
