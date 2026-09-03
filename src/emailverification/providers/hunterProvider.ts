import { env } from '../../config/env.js'
import type { RiskReason, VerificationEvidence, VerificationResult } from '../types.js'
import { riskReasonFor, type EmailVerificationProvider, type VerificationOutcome } from './provider.js'

// Hunter.io — named in the Team Answer's own margin comment as one of the
// approved verification platforms.
//
// This is a real adapter against Hunter's documented Email Verifier endpoint.
// It has no credential in this environment, so in practice it reports
// `not_configured` and the platform treats every address as unverified. That
// is the correct behaviour, not a placeholder: the alternative — assuming an
// address is fine because we cannot check it — is the exact failure the
// business rule forbids.

/** Hunter's `status` vocabulary, mapped to ours. */
const RESULT_MAP: Record<string, VerificationResult> = {
  valid: 'deliverable',
  invalid: 'undeliverable',
  accept_all: 'risky',
  webmail: 'risky',
  disposable: 'risky',
  unknown: 'unknown',
}

interface HunterResponse {
  data?: {
    status?: string
    result?: string
    score?: number
    regexp?: boolean
    gibberish?: boolean
    disposable?: boolean
    webmail?: boolean
    mx_records?: boolean
    smtp_server?: boolean
    smtp_check?: boolean
    accept_all?: boolean
    block?: boolean
  }
  errors?: Array<{ code?: number; details?: string }>
}

export class HunterProvider implements EmailVerificationProvider {
  readonly name = 'hunter'

  available(): { status: VerificationOutcome['status']; reason?: string } {
    if (!env.HUNTER_API_KEY) {
      return {
        status: 'not_configured',
        reason:
          'HUNTER_API_KEY is not set. Hunter.io is one of the two verification platforms named in the Team Answer; ' +
          'until a key is issued no address can be verified, and none may be treated as outreach-ready.',
      }
    }
    return { status: 'completed' }
  }

  async verify(email: string): Promise<VerificationOutcome> {
    const started = Date.now()
    const url = new URL('/v2/email-verifier', env.HUNTER_API_BASE)
    url.searchParams.set('email', email)
    url.searchParams.set('api_key', env.HUNTER_API_KEY!)

    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(env.EMAIL_VERIFICATION_TIMEOUT_MS),
    })

    if (res.status === 401 || res.status === 403) {
      throw new Error(`Hunter rejected the credential (HTTP ${res.status}).`)
    }
    if (res.status === 429) throw new Error('Hunter rate limit reached (HTTP 429).')
    if (!res.ok) throw new Error(`Hunter returned HTTP ${res.status}.`)

    const body = (await res.json()) as HunterResponse
    const d = body.data ?? {}
    const verdict = (d.status ?? d.result ?? '').toLowerCase()

    const evidence: VerificationEvidence = {
      provider: this.name,
      providerVerdict: verdict || null,
      providerScore: typeof d.score === 'number' ? d.score : null,
      checks: {
        syntaxValid: d.regexp ?? null,
        domainHasMx: d.mx_records ?? null,
        smtpAccepted: d.smtp_check ?? null,
        catchAll: d.accept_all ?? null,
        disposable: d.disposable ?? null,
        roleAccount: null,
      },
      raw: { ...d },
    }

    const result = RESULT_MAP[verdict] ?? 'unknown'
    const riskReasons: RiskReason[] = riskReasonFor(evidence, email)
    if (d.webmail) riskReasons.push('provider_unspecified')

    return {
      provider: this.name,
      status: 'completed',
      result,
      riskReasons: [...new Set(riskReasons)],
      reason: verdict
        ? `Hunter reported "${verdict}"${typeof d.score === 'number' ? ` at confidence ${d.score}` : ''}.`
        : 'Hunter returned no status for this address.',
      evidence,
      durationMs: Date.now() - started,
    }
  }
}
