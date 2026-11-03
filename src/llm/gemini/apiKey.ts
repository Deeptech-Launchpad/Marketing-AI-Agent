import { env } from '../../config/env.js'
import { currentGeminiBudget } from './budgetContext.js'

// WHICH GEMINI KEY A CALL USES.
//
// Everything in this application uses GEMINI_API_KEY, exactly as before - EXCEPT the calls made inside a
// Warm Leads budget (budgetContext.ts, keyScope 'warm-leads'). Those use WARM_LEADS_GEMINI_API_KEY, which is meant
// to belong to a separate Google Cloud project and be restricted to the Generative Language API and this server.
//
// The rule that matters: a Warm Leads call NEVER falls back to the shared key. If the dedicated key is empty,
// or has been set to the same value as the shared one (which would defeat the point of having a project of its
// own), the call is refused before anything is reserved or sent.

export class GeminiKeyMissingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GeminiKeyMissingError'
  }
}

const MISSING = 'Warm Leads has no Gemini key of its own (WARM_LEADS_GEMINI_API_KEY is empty), so this call was not sent. It does not use the shared key.'
const SAME = 'WARM_LEADS_GEMINI_API_KEY is the same as the shared GEMINI_API_KEY, so this call was not sent. Warm Leads needs a key from its own Google Cloud project.'

/** What is wrong with the dedicated key itself, or null. Independent of the driver: a real request needs a valid key. */
function dedicatedKeyProblem(): string | null {
  const own = env.WARM_LEADS_GEMINI_API_KEY.trim()
  if (!own) return MISSING
  if (own === env.GEMINI_API_KEY.trim()) return SAME
  return null
}

/**
 * Why Warm Leads may not run right now because of its key, or null when it may. Never contains a key.
 * A fake driver makes no request, so there is nothing to authorise (tests, local development).
 */
export function warmLeadsKeyProblem(): string | null {
  return env.LLM_DRIVER !== 'real' ? null : dedicatedKeyProblem()
}

/** The key for the call being made, decided by the budget the call runs in. Throws instead of using the wrong key. */
export function resolveGeminiApiKey(): string {
  if (currentGeminiBudget()?.keyScope === 'warm-leads') {
    const problem = dedicatedKeyProblem()
    if (problem) throw new GeminiKeyMissingError(problem)
    return env.WARM_LEADS_GEMINI_API_KEY.trim()
  }
  return env.GEMINI_API_KEY
}
