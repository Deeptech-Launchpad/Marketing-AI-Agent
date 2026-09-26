import { prisma } from '../platform/db.js'
import { findUnsupportedClaims } from '../websiteaudit/claimGuard.js'
import { CHANNEL_LIMITS, type ComposedMessage, type OutreachTarget } from './types.js'

// TASK #982 — the gate an action passes before it is marked ready.
//
// Reuses the Task #979 claim guard rather than writing a second one, so the
// same rule that stopped a percentage reaching an audit report stops it
// reaching a prospect's inbox.
//
// The check that does the most work here is the WORKBENCH one. An outreach
// message may carry a public Workbench link, and a link belonging to a
// DIFFERENT prospect's audit would show one company another company's product
// data. That is the worst failure available to this feature, so the link is
// verified against the audit run the message was built from — not merely
// checked for being a valid URL.

export interface ValidationIssue {
  check: string
  field: string
  message: string
}

export interface ValidationOutcome {
  ok: boolean
  passed: string[]
  issues: ValidationIssue[]
}

export interface ValidationInput {
  tenantId: string
  /** Null for an intent-basis campaign (2026-09-24 restructure) — see checks 4 and 5 below. */
  auditRunId: string | null
  message: ComposedMessage
  target: OutreachTarget
}

export async function validateAction(input: ValidationInput): Promise<ValidationOutcome> {
  const issues: ValidationIssue[] = []
  const passed: string[] = []
  const { message, target } = input
  const limits = CHANNEL_LIMITS[message.channel]

  // ── 1. Unsupported claims, per block ───────────────────────────────────
  let guardFailed = false
  for (const [block, text] of Object.entries(message.blocks)) {
    if (!text.trim()) continue
    for (const v of findUnsupportedClaims(text)) {
      guardFailed = true
      issues.push({ check: 'claim_guard', field: `blocks.${block}`, message: `[${v.pattern}] "${v.match}" — ${v.why}` })
    }
  }
  if (!guardFailed) passed.push('claim_guard')

  // ── 2. Channel limits ──────────────────────────────────────────────────
  if (message.length > limits.maxBody) {
    issues.push({
      check: 'channel_limits',
      field: 'body',
      message: `The body is ${message.length} characters; ${message.channel} allows ${limits.maxBody}.`,
    })
  } else if (limits.maxSubject && message.subject && message.subject.length > limits.maxSubject) {
    issues.push({
      check: 'channel_limits',
      field: 'subject',
      message: `The subject is ${message.subject.length} characters; ${message.channel} allows ${limits.maxSubject}.`,
    })
  } else {
    passed.push('channel_limits')
  }

  // ── 3. Required recipient data ─────────────────────────────────────────
  if (limits.requiresPerson && !target.contactName) {
    issues.push({
      check: 'target',
      field: 'contactName',
      message: `The ${message.channel} channel needs a named person, and no verified decision maker was identified for this company.`,
    })
  } else if (limits.requiresDestination && !target.destination) {
    issues.push({
      check: 'target',
      field: 'destination',
      message: `No verified destination is stored for this contact on the ${message.channel} channel. One is never guessed from a name or a domain.`,
    })
  } else {
    passed.push('target')
  }

  // ── 4. Evidence is present and traceable ───────────────────────────────
  if (!message.evidence.length) {
    issues.push({
      check: 'evidence',
      field: 'evidence',
      message: 'The message carries no evidence reference, so there is no answer to "why was this sent to this person".',
    })
  } else {
    const findingIds = message.evidence.filter((e) => e.kind === 'catalog_finding' && e.referenceId).map((e) => e.referenceId!)
    if (findingIds.length && !input.auditRunId) {
      // Cannot happen from either path today — a catalog_finding citation is
      // only ever produced by the audit-basis path, which always carries an
      // auditRunId — but a claim that cannot be checked is treated as unproven.
      issues.push({
        check: 'evidence',
        field: 'evidence',
        message: 'The message cites a catalog finding, but no audit run was given to verify it against.',
      })
    } else if (findingIds.length) {
      const found = await prisma.catalogFinding.count({
        where: { id: { in: findingIds }, auditRunId: input.auditRunId! },
      })
      if (found !== findingIds.length) {
        issues.push({
          check: 'evidence',
          field: 'evidence',
          message: 'The message cites a catalog finding that does not belong to this audit run.',
        })
      } else {
        passed.push('evidence')
      }
    } else {
      passed.push('evidence')
    }
  }

  // ── 5. The Workbench link belongs to THIS prospect ─────────────────────
  if (message.workbenchUrl) {
    const token = message.workbenchUrl.split('/workbench/')[1]?.split(/[?#]/)[0]
    if (!token) {
      issues.push({ check: 'workbench_link', field: 'workbenchUrl', message: 'The Workbench URL is not a valid link.' })
    } else {
      const { createHash } = await import('node:crypto')
      const link = await prisma.workbenchLink.findUnique({
        where: { tokenHash: createHash('sha256').update(token).digest('hex') },
        include: { demo: { select: { auditRunId: true, tenantId: true, status: true } } },
      })

      if (!link) {
        issues.push({ check: 'workbench_link', field: 'workbenchUrl', message: 'That Workbench link does not exist.' })
      } else if (link.revokedAt) {
        issues.push({ check: 'workbench_link', field: 'workbenchUrl', message: 'That Workbench link has been revoked.' })
      } else if (link.expiresAt.getTime() < Date.now()) {
        issues.push({ check: 'workbench_link', field: 'workbenchUrl', message: 'That Workbench link has expired.' })
      } else if (link.demo.auditRunId !== input.auditRunId || link.demo.tenantId !== input.tenantId) {
        // The failure this whole check exists for.
        issues.push({
          check: 'workbench_link',
          field: 'workbenchUrl',
          message:
            'That Workbench link belongs to a different audit. Sending it would show this prospect another company data.',
        })
      } else if (link.demo.status !== 'ready') {
        issues.push({
          check: 'workbench_link',
          field: 'workbenchUrl',
          message: `The linked Workbench is "${link.demo.status}", so there is nothing useful behind the link.`,
        })
      } else {
        passed.push('workbench_link')
      }
    }
  }

  // ── 6. No internal identifier leaks into a customer-facing message ─────
  const idPattern = /\b(tenantId|crmCompanyId|auditRunId|demoId|observationId)\b/i
  const composed = `${message.subject ?? ''} ${message.body}`
  if (idPattern.test(composed)) {
    issues.push({
      check: 'no_internal_ids',
      field: 'body',
      message: 'The message names an internal identifier field. Customer-facing copy must not expose internal structure.',
    })
  } else {
    passed.push('no_internal_ids')
  }

  return { ok: issues.length === 0, passed, issues }
}
