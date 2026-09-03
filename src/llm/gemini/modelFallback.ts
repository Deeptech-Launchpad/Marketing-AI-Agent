// Model priority and error classification, ported from NXT Sales'
// client/src/utils/geminiModel.js.
//
// The ordering below is not cosmetic and should not be "tidied". Google has
// been deprecating pinned model names for accounts created after a given
// cutoff, even while the /models list endpoint still advertises them as
// generateContent-capable — confirmed over there by a direct curl test that got
// 404 "no longer available to new users" for every pinned name but succeeded
// immediately on the rolling "-latest" alias. Leading with the aliases is what
// makes a newer API key resolve on the first attempt instead of exhausting the
// whole list first.

export const GEMINI_MODEL_PRIORITY = [
  'gemini-flash-latest',
  'gemini-pro-latest',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-2.5-pro',
] as const

/** Reasoning-heavy steps prefer a pro-tier model but still degrade gracefully. */
export const GEMINI_REASONING_PRIORITY = [
  'gemini-pro-latest',
  'gemini-2.5-pro',
  'gemini-flash-latest',
  'gemini-2.5-flash',
] as const

/**
 * Whether a failed attempt should advance to the next candidate model.
 *
 * 429 counts as retryable-on-another-model because Gemini free-tier quotas are
 * commonly PER MODEL: exhausting one says nothing about the others. A bad key
 * or a safety block applies identically to every model, so those fail fast
 * after one attempt rather than wasting the whole chain.
 */
export function canTryNextModel(status: number, message: string): boolean {
  if (status === 404 || status === 429) return true
  return /not found|not supported|does not exist|no longer available/i.test(message)
}

export function buildCandidates(preferred: string | undefined, priority: readonly string[]): string[] {
  const list = [preferred, ...priority].filter((v): v is string => Boolean(v))
  return [...new Set(list)]
}
