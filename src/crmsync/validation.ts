import { env } from '../config/env.js'
import { prisma } from '../platform/db.js'
import type { BuiltPayload } from './payload.js'
import type { ValidationIssue, ValidationResult } from './types.js'

// TASK #986 — refusing to sync a package that is not sound.
//
// Everything here is checked against the DATABASE, not against the payload's
// own claims. A payload that says an audit is approved proves nothing; the
// check is whether the row says so.
//
// The two rules that matter most:
//
//   Only a QUALIFIED lead enters the CRM flow. There is no code path that
//   pushes every prospect into the CRM, and no rule that quietly widens the
//   gate.
//
//   Cross-context references are refused. A Workbench belonging to another
//   audit, or an audit belonging to another company, stops the sync — that is
//   how one company's demonstration link would end up on another's record.

/** Statuses that may be handed to the CRM. */
const SYNCABLE_STATUSES = ['qualified', 'qualified_unassigned']

function error(check: string, message: string): ValidationIssue {
  return { check, severity: 'error', message }
}
function warning(check: string, message: string): ValidationIssue {
  return { check, severity: 'warning', message }
}

export async function validateForSync(tenantId: string, built: BuiltPayload): Promise<ValidationResult> {
  const issues: ValidationIssue[] = []
  const { payload, refs } = built

  // ── The qualification gate ──────────────────────────────────────────────
  const q = await prisma.salesQualification.findFirst({
    where: { id: payload.qualification.qualificationRef, tenantId },
  })

  if (!q) {
    issues.push(error('qualification_exists', 'The qualification does not exist for this tenant.'))
    // Nothing below can be checked without it.
    return { ok: false, issues }
  }

  if (!SYNCABLE_STATUSES.includes(q.status)) {
    issues.push(
      error(
        'qualification_gate',
        `This company is "${q.status}". Only a qualified lead may be handed to the CRM, and no rule pushes unqualified prospects there.`,
      ),
    )
  }

  if (q.crmCompanyId !== refs.crmCompanyId) {
    issues.push(error('company_consistency', 'The payload company does not match the qualification.'))
  }

  // ── The score it was qualified on ───────────────────────────────────────
  if (!refs.intentScoreId) {
    issues.push(error('intent_score_exists', 'No intent score exists for this company, so the qualification cannot be substantiated.'))
  } else {
    const score = await prisma.intentScore.findFirst({ where: { id: refs.intentScoreId, tenantId } })
    if (!score) {
      issues.push(error('intent_score_resolves', 'The referenced intent score no longer resolves.'))
    } else if (score.crmCompanyId !== q.crmCompanyId) {
      issues.push(error('intent_score_company', 'The intent score belongs to a different company.'))
    }
  }

  // ── The company must exist in the CRM ───────────────────────────────────
  if (!payload.company.name || payload.company.name === payload.company.crmCompanyId) {
    issues.push(
      warning(
        'company_readable',
        'The company could not be read from NXT Sales, so the package carries its identifier rather than its name.',
      ),
    )
  }

  // ── The approved audit ──────────────────────────────────────────────────
  if (!refs.auditReportId) {
    issues.push(
      error(
        'approved_report_exists',
        'No APPROVED audit report exists for this company. The CRM package must carry reviewed evidence, not a draft.',
      ),
    )
  } else {
    const report = await prisma.auditReport.findFirst({ where: { id: refs.auditReportId, tenantId } })
    if (!report) {
      issues.push(error('report_resolves', 'The referenced audit report no longer resolves.'))
    } else {
      if (report.status !== 'approved') {
        issues.push(error('report_approved', `The audit report is "${report.status}", not approved.`))
      }
      if (report.crmCompanyId !== q.crmCompanyId) {
        issues.push(error('report_company', 'The audit report belongs to a different company.'))
      }
      if (refs.auditRunId && report.auditRunId !== refs.auditRunId) {
        issues.push(error('report_run', 'The audit report and the audit run in the package do not match.'))
      }

      // The report names the revision that was approved; the revision itself
      // carries no status. Both must line up for the evidence to be sound.
      if (report.approvedRevision == null) {
        issues.push(error('revision_approved', 'The report is approved but names no approved revision.'))
      } else {
        const approvedRevision = await prisma.auditReportRevision.findFirst({
          where: { auditReportId: report.id, revisionNumber: report.approvedRevision },
        })
        if (!approvedRevision) {
          issues.push(
            error('revision_resolves', `The report names approved revision ${report.approvedRevision}, which does not exist.`),
          )
        }
      }
    }
  }

  // ── Findings must belong to the run in the package ─────────────────────
  if (payload.audit.topFindings.length && refs.auditRunId) {
    const ids = payload.audit.topFindings.map((f) => f.findingRef)
    const count = await prisma.catalogFinding.count({
      where: { id: { in: ids }, auditRunId: refs.auditRunId, tenantId },
    })
    if (count !== ids.length) {
      issues.push(error('findings_resolve', 'One or more findings do not belong to the audit run in this package.'))
    }
  }

  // ── The Workbench must belong to the same company AND audit ────────────
  if (refs.workbenchDemoId) {
    const demo = await prisma.workbenchDemo.findFirst({ where: { id: refs.workbenchDemoId, tenantId } })
    if (!demo) {
      issues.push(error('workbench_resolves', 'The referenced Workbench demonstration no longer resolves.'))
    } else {
      if (demo.crmCompanyId !== q.crmCompanyId) {
        // The failure this check exists to prevent.
        issues.push(error('workbench_company', "The Workbench belongs to a different company. Syncing it would put one prospect's demonstration on another's record."))
      }
      if (refs.auditRunId && demo.auditRunId !== refs.auditRunId) {
        issues.push(
          warning(
            'workbench_audit',
            'The Workbench was built from a different audit run than the one in this package, so its details are not included.',
          ),
        )
      }
    }
  }

  // ── The decision maker, when one is included ───────────────────────────
  if (refs.decisionMakerId) {
    const dm = await prisma.decisionMakerCandidate.findFirst({ where: { id: refs.decisionMakerId, tenantId } })
    if (!dm) {
      issues.push(error('decision_maker_resolves', 'The referenced decision maker no longer resolves.'))
    } else if (dm.crmCompanyId !== q.crmCompanyId) {
      issues.push(error('decision_maker_company', 'The decision maker belongs to a different company.'))
    }
  }

  // ── Suppression. A company we must not contact must not be handed over
  //    as a lead to contact. ────────────────────────────────────────────────
  const suppressed = await prisma.engagementEvent.count({
    where: { tenantId, crmCompanyId: q.crmCompanyId, eventType: 'email_unsubscribed' },
  })
  if (suppressed > 0) {
    issues.push(
      error(
        'not_suppressed',
        'This company has unsubscribed. It must not be handed to sales as a lead to contact.',
      ),
    )
  }

  // ── Owner policy ────────────────────────────────────────────────────────
  if (!q.ownerCrmUserId && !env.CRM_SYNC_ALLOW_UNASSIGNED) {
    issues.push(
      error(
        'owner_required',
        'No sales owner is assigned, and the configured policy does not permit syncing unassigned records.',
      ),
    )
  } else if (!q.ownerCrmUserId) {
    issues.push(warning('owner_unassigned', 'This lead has no sales owner. The package is marked unassigned.'))
  }

  // ── Payload shape ───────────────────────────────────────────────────────
  if (!payload.payloadVersion || !payload.mappingVersion) {
    issues.push(error('payload_versioned', 'The payload is missing its version or mapping version.'))
  }
  if (!payload.externalKey.startsWith('mai:')) {
    issues.push(error('external_key', 'The correlation key is malformed.'))
  }

  // ── No secret may travel in a payload ──────────────────────────────────
  const serialised = JSON.stringify(payload)
  const secretish = /(api[_-]?key|secret|password|bearer\s|authorization|jwt_|webhook_url)/i
  if (secretish.test(serialised)) {
    issues.push(error('no_credentials', 'The payload contains something that looks like a credential.'))
  }

  return { ok: !issues.some((i) => i.severity === 'error'), issues }
}
