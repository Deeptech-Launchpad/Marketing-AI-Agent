import { env } from '../config/env.js'
import { logger } from '../platform/logger.js'
import { getVerificationPolicy, isStale } from './policy.js'
import { HunterProvider } from './providers/hunterProvider.js'
import {
  inspectSyntax,
  isPersonalAddress,
  isRoleAccount,
  runVerificationProvider,
  type EmailVerificationProvider,
} from './providers/provider.js'
import { VerifaliaProvider } from './providers/verifaliaProvider.js'
import type { VerificationRecord, VerificationResult } from './types.js'

const log = logger.child({ module: 'emailverification' })

/**
 * The configured providers, in the order they are tried.
 *
 * Selection is by configuration rather than by racing them: verification is
 * billed per lookup, and asking two providers the same question to see if they
 * agree is a cost with no decision attached to it. The second exists so the
 * business can switch platforms without a deploy.
 */
function providers(): EmailVerificationProvider[] {
  const all: Record<string, EmailVerificationProvider> = {
    hunter: new HunterProvider(),
    verifalia: new VerifaliaProvider(),
  }
  const preferred = env.EMAIL_VERIFICATION_PROVIDER
  if (preferred && all[preferred]) return [all[preferred]!]
  // No preference stated: try each, so a single configured key is found.
  return [all.hunter!, all.verifalia!]
}

export function verificationProviderNames(): string[] {
  return providers().map((p) => p.name)
}

/**
 * Verifies one address and returns the full record.
 *
 * Never throws for an unverifiable address — an address that cannot be
 * verified is a normal, reportable outcome, and the caller must be able to
 * tell it apart from an address that was verified and failed.
 */
export async function verifyEmail(email: string): Promise<VerificationRecord> {
  const policy = getVerificationPolicy()
  const value = String(email ?? '').trim().toLowerCase()

  // ── 1. Shape. Cheap, local, and settles the hopeless cases. ────────────
  const syntax = inspectSyntax(value)
  if (!syntax.valid) {
    return {
      email: value,
      result: 'undeliverable',
      status: 'completed',
      riskReasons: [],
      provider: null,
      verifiedAt: new Date(),
      reason: `Not a usable address: ${syntax.reason}`,
      evidence: null,
      outreachReady: false,
    }
  }

  // ── 2. Policy. A personal address is not a quality problem — it is one we
  //      are not permitted to hold (Section E.4). Refused before it is sent
  //      to a third party, so we never disclose it to a provider either.
  if (isPersonalAddress(value)) {
    return {
      email: value,
      result: 'undeliverable',
      status: 'completed',
      riskReasons: [],
      provider: null,
      verifiedAt: new Date(),
      reason:
        'This is a personal (free-mail) address. The approved contact-data policy permits work addresses only, ' +
        'so it is not verified and must not be stored or contacted.',
      evidence: null,
      outreachReady: false,
    }
  }

  // ── 3. The provider. ───────────────────────────────────────────────────
  for (const provider of providers()) {
    const outcome = await runVerificationProvider(provider, value)

    if (outcome.status === 'not_configured') {
      log.debug({ provider: provider.name }, 'verification provider not configured')
      continue
    }

    const verifiedAt = outcome.status === 'completed' ? new Date() : null
    const record: VerificationRecord = {
      email: value,
      result: outcome.result,
      status: outcome.status,
      riskReasons: outcome.riskReasons,
      provider: outcome.provider,
      verifiedAt,
      reason: outcome.reason,
      evidence: outcome.evidence,
      outreachReady: decideReady(outcome.result, policy.outreachReadyResults),
    }
    log.debug({ email: value, result: record.result, ready: record.outreachReady }, 'address verified')
    return record
  }

  // ── 4. Nothing configured. The honest answer, and the safe one. ────────
  return {
    email: value,
    result: 'unverified',
    status: 'not_configured',
    riskReasons: isRoleAccount(value) ? ['role_account'] : [],
    provider: null,
    verifiedAt: null,
    reason:
      'No email verification provider is configured. The address is well-formed but has not been checked, ' +
      'so it is not outreach-ready. Set HUNTER_API_KEY or VERIFALIA_USERNAME/VERIFALIA_PASSWORD to enable ' +
      'verification.',
    evidence: null,
    outreachReady: false,
  }
}

function decideReady(result: VerificationResult, ready: VerificationResult[]): boolean {
  return ready.includes(result)
}

/**
 * The gate outreach calls.
 *
 * Takes what is already known about an address and answers one question: may
 * this be sent to right now? A stored `deliverable` that has gone stale is not
 * a yes — it is a re-verification.
 */
export function assertOutreachReady(record: VerificationRecord | null): {
  ready: boolean
  reason: string
  needsVerification: boolean
} {
  const policy = getVerificationPolicy()

  if (!record) {
    return {
      ready: false,
      reason: 'This address has never been verified. An unverified address is not outreach-ready.',
      needsVerification: true,
    }
  }
  if (record.status === 'not_configured') {
    return {
      ready: false,
      reason: record.reason,
      needsVerification: true,
    }
  }
  if (!policy.outreachReadyResults.includes(record.result)) {
    return {
      ready: false,
      reason:
        `Verification returned "${record.result}"` +
        (record.riskReasons.length ? ` (${record.riskReasons.join(', ')})` : '') +
        `. Policy ${policy.version} permits outreach only to: ${policy.outreachReadyResults.join(', ')}.`,
      needsVerification: false,
    }
  }
  if (isStale(record.verifiedAt, policy)) {
    return {
      ready: false,
      reason:
        `Last verified ${record.verifiedAt?.toISOString().slice(0, 10) ?? 'never'}, which is older than the ` +
        `${policy.revalidateAfterDays}-day revalidation window. People change jobs; it must be re-checked.`,
      needsVerification: true,
    }
  }
  return {
    ready: true,
    reason: `Verified ${record.result} by ${record.provider ?? 'an unnamed provider'} on ${
      record.verifiedAt?.toISOString().slice(0, 10) ?? 'an unrecorded date'
    }.`,
    needsVerification: false,
  }
}
