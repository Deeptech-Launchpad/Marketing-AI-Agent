import { env } from '../../config/env.js'
import type { VerificationEvidence, VerificationResult } from '../types.js'
import { riskReasonFor, type EmailVerificationProvider, type VerificationOutcome } from './provider.js'

// Verifalia — the second platform named in the Team Answer's margin comment.
//
// Implemented as the documented single-address validation call with
// HTTP Basic auth. Like the Hunter adapter it is real and unconfigured: with
// no credentials it reports `not_configured` and verifies nothing.
//
// Verifalia answers with a two-part verdict — a `status` and a
// `classification` — and the classification is the one that decides
// deliverability, so that is what is mapped. The status is kept in evidence
// because it explains WHY, which is what a disputed bounce needs.

const CLASSIFICATION_MAP: Record<string, VerificationResult> = {
  deliverable: 'deliverable',
  undeliverable: 'undeliverable',
  risky: 'risky',
  unknown: 'unknown',
}

interface VerifaliaEntry {
  status?: string
  classification?: string
  inputData?: string
  emailAddressDomainPart?: string
  isDisposableEmailAddress?: boolean
  isRoleAccount?: boolean
  isFreeEmailAddress?: boolean
  hasInternationalMailboxName?: boolean
  syntaxFailureIndex?: number | null
}

interface VerifaliaResponse {
  entries?: { data?: VerifaliaEntry[] }
}

export class VerifaliaProvider implements EmailVerificationProvider {
  readonly name = 'verifalia'

  available(): { status: VerificationOutcome['status']; reason?: string } {
    if (!env.VERIFALIA_USERNAME || !env.VERIFALIA_PASSWORD) {
      return {
        status: 'not_configured',
        reason:
          'VERIFALIA_USERNAME and VERIFALIA_PASSWORD are not set. Verifalia is one of the two verification ' +
          'platforms named in the Team Answer; without credentials no address can be verified.',
      }
    }
    return { status: 'completed' }
  }

  async verify(email: string): Promise<VerificationOutcome> {
    const started = Date.now()
    const auth = Buffer.from(`${env.VERIFALIA_USERNAME}:${env.VERIFALIA_PASSWORD}`).toString('base64')

    // `waitTime` asks Verifalia to complete the job inline rather than
    // returning a job to poll. One address does not justify a polling loop.
    const res = await fetch(new URL('/v2.6/email-validations?waitTime=30000', env.VERIFALIA_API_BASE), {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ entries: [{ inputData: email }] }),
      signal: AbortSignal.timeout(env.EMAIL_VERIFICATION_TIMEOUT_MS),
    })

    if (res.status === 401 || res.status === 403) {
      throw new Error(`Verifalia rejected the credentials (HTTP ${res.status}).`)
    }
    if (res.status === 429) throw new Error('Verifalia rate limit reached (HTTP 429).')
    if (!res.ok && res.status !== 200 && res.status !== 202) {
      throw new Error(`Verifalia returned HTTP ${res.status}.`)
    }

    const body = (await res.json()) as VerifaliaResponse
    const entry = body.entries?.data?.[0]
    if (!entry) {
      return {
        provider: this.name,
        status: 'completed',
        result: 'unknown',
        riskReasons: [],
        reason: 'Verifalia accepted the job but returned no entry for this address.',
        evidence: null,
        durationMs: Date.now() - started,
      }
    }

    const classification = (entry.classification ?? '').toLowerCase()
    const evidence: VerificationEvidence = {
      provider: this.name,
      providerVerdict: classification || (entry.status ?? null),
      providerScore: null,
      checks: {
        syntaxValid: entry.syntaxFailureIndex == null ? true : false,
        domainHasMx: entry.status === 'DomainHasNullMx' ? false : null,
        smtpAccepted: entry.status === 'Success' ? true : null,
        catchAll: entry.status === 'CatchAllValidationTimeout' || entry.status === 'ServerIsCatchAll' ? true : null,
        disposable: entry.isDisposableEmailAddress ?? null,
        roleAccount: entry.isRoleAccount ?? null,
      },
      raw: { ...entry },
    }

    return {
      provider: this.name,
      status: 'completed',
      result: CLASSIFICATION_MAP[classification] ?? 'unknown',
      riskReasons: [...new Set(riskReasonFor(evidence, email))],
      reason: `Verifalia classified the address as "${classification || 'unknown'}" (status: ${entry.status ?? 'unstated'}).`,
      evidence,
      durationMs: Date.now() - started,
    }
  }
}
